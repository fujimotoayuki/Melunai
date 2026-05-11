import fs from "node:fs/promises";
import path from "node:path";

import ExcelJS from "exceljs";

import type {
  DocumentExtractionLimits,
  DocumentExtractionResult,
  DocumentSourceMetadata,
  DocumentTextSegment,
} from "../types/index.js";
import { resolveWorkspacePath } from "../utils/pathUtils.js";

export const DEFAULT_XLSX_EXTRACTION_LIMITS: DocumentExtractionLimits = {
  maxFiles: 8,
  maxCharsPerFile: 40_000,
  maxTotalChars: 120_000,
  maxPagesPerPdf: 20,
  maxParagraphsPerDocx: 300,
  maxSheetsPerXlsx: 12,
  maxCellsPerSheet: 2_000,
  maxSlidesPerPptx: 80,
};

export async function extractXlsxText(
  workspaceRoot: string,
  relativePath: string,
  limits: Partial<DocumentExtractionLimits> = {},
): Promise<DocumentExtractionResult> {
  const normalizedLimits = normalizeLimits(limits);
  const name = path.basename(relativePath);
  const baseResult = {
    path: relativePath,
    name,
    kind: "excel" as const,
    extension: ".xlsx" as const,
    segments: [] as DocumentTextSegment[],
    warnings: [] as string[],
  };

  let absolutePath: string;
  try {
    absolutePath = resolveWorkspacePath(workspaceRoot, relativePath);
  } catch (error) {
    return {
      ...baseResult,
      status: "skipped",
      skipReason: "outside_workspace",
      errorMessage: error instanceof Error ? error.message : "Path is outside workspace.",
    };
  }

  if (path.extname(absolutePath).toLowerCase() !== ".xlsx") {
    return {
      ...baseResult,
      status: "unsupported",
      skipReason: "unsupported_type",
      errorMessage: "Only .xlsx files are supported by the XLSX extractor.",
    };
  }

  try {
    const stats = await fs.stat(absolutePath);
    if (!stats.isFile()) {
      return {
        ...baseResult,
        status: "failed",
        skipReason: "extraction_failed",
        errorMessage: "Path does not point to a file.",
      };
    }

    // .xlsx files are ZIP containers, so check for zip-bomb patterns before parsing.
    try {
      const JSZip = (await import("jszip")).default;
      const { assertZipIsSafe, ZipSafetyError } = await import("./zipSafety.js");
      const buf = await fs.readFile(absolutePath);
      const zip = await JSZip.loadAsync(buf);
      try {
        assertZipIsSafe(zip, buf.byteLength);
      } catch (cause) {
        if (cause instanceof ZipSafetyError) {
          return {
            ...baseResult,
            status: "skipped",
            skipReason: "too_large",
            errorMessage: cause.message,
          };
        }
        throw cause;
      }
    } catch (cause) {
      return {
        ...baseResult,
        status: "failed",
        skipReason: "extraction_failed",
        errorMessage: cause instanceof Error ? cause.message : String(cause),
      };
    }

    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.readFile(absolutePath);
    const worksheets = workbook.worksheets;
    const sheetNames = worksheets.map((worksheet) => worksheet.name);
    const warnings: string[] = [];
    const selectedWorksheets = worksheets.slice(0, normalizedLimits.maxSheetsPerXlsx);

    if (worksheets.length > normalizedLimits.maxSheetsPerXlsx) {
      warnings.push(`XLSX sheet count exceeded limit; read first ${normalizedLimits.maxSheetsPerXlsx} sheet(s).`);
    }

    const rawSegments = selectedWorksheets.flatMap((worksheet, index) =>
      buildSheetSegments(worksheet, index + 1, normalizedLimits),
    );
    const limited = applyCharacterLimit(rawSegments, normalizedLimits.maxCharsPerFile);
    const metadata: DocumentSourceMetadata = {
      sheetCount: sheetNames.length,
    };

    if (limited.truncatedByChars) {
      warnings.push("XLSX text was truncated by the per-file character limit.");
    }

    if (limited.segments.length === 0) {
      return {
        ...baseResult,
        status: "skipped",
        metadata,
        skipReason: "empty_document",
        warnings,
      };
    }

    const partial = warnings.length > 0 ||
      limited.truncatedByChars ||
      limited.segments.some((segment) => segment.truncated === true);

    return {
      ...baseResult,
      status: partial ? "partial" : "extracted",
      metadata,
      segments: limited.segments,
      originalCharCount: rawSegments.reduce((sum, segment) => sum + segment.charCount, 0),
      includedCharCount: limited.segments.reduce((sum, segment) => sum + segment.charCount, 0),
      truncated: partial,
      warnings,
    };
  } catch (error) {
    return {
      ...baseResult,
      status: "failed",
      skipReason: classifyXlsxError(error),
      errorMessage: error instanceof Error ? error.message : "XLSX extraction failed.",
      warnings: ["XLSX text extraction failed."],
    };
  }
}

function normalizeLimits(limits: Partial<DocumentExtractionLimits>): DocumentExtractionLimits {
  return {
    ...DEFAULT_XLSX_EXTRACTION_LIMITS,
    ...limits,
    maxCharsPerFile: normalizePositiveInteger(
      limits.maxCharsPerFile,
      DEFAULT_XLSX_EXTRACTION_LIMITS.maxCharsPerFile,
    ),
    maxSheetsPerXlsx: normalizePositiveInteger(
      limits.maxSheetsPerXlsx,
      DEFAULT_XLSX_EXTRACTION_LIMITS.maxSheetsPerXlsx,
    ),
    maxCellsPerSheet: normalizePositiveInteger(
      limits.maxCellsPerSheet,
      DEFAULT_XLSX_EXTRACTION_LIMITS.maxCellsPerSheet,
    ),
  };
}

function normalizePositiveInteger(value: number | undefined, fallback: number): number {
  if (value === undefined || !Number.isFinite(value) || value <= 0) {
    return fallback;
  }

  return Math.floor(value);
}

function buildSheetSegments(
  worksheet: ExcelJS.Worksheet,
  sheetIndex: number,
  limits: DocumentExtractionLimits,
): DocumentTextSegment[] {
  const lines: string[] = [];
  let cellCount = 0;
  let truncated = false;

  for (let rowIndex = 1; rowIndex <= worksheet.rowCount; rowIndex += 1) {
    if (cellCount >= limits.maxCellsPerSheet) {
      truncated = true;
      break;
    }

    const row = worksheet.getRow(rowIndex);
    const visibleCells: string[] = [];

    for (let columnIndex = 1; columnIndex <= worksheet.columnCount; columnIndex += 1) {
      if (cellCount >= limits.maxCellsPerSheet) {
        truncated = true;
        break;
      }

      const value = formatCellValue(row.getCell(columnIndex).value);
      if (value.length === 0) {
        continue;
      }

      visibleCells.push(value);
      cellCount += 1;
    }

    if (visibleCells.length > 0) {
      lines.push(visibleCells.join("\t"));
    }
  }

  const text = lines.join("\n").trim();
  if (text.length === 0) {
    return [];
  }

  return [
    {
      id: `sheet-${sheetIndex}`,
      kind: "sheet",
      sheetName: worksheet.name,
      cellRange: worksheet.rowCount > 0 && worksheet.columnCount > 0
        ? `R1C1:R${worksheet.rowCount}C${worksheet.columnCount}`
        : "",
      text,
      charCount: text.length,
      truncated,
    },
  ];
}

function formatCellValue(value: ExcelJS.CellValue): string {
  if (value === null || value === undefined) return "";
  if (value instanceof Date) return value.toISOString();

  if (typeof value === "object") {
    if ("text" in value && typeof value.text === "string") {
      return value.text.trim();
    }

    if ("result" in value) {
      return formatCellValue(value.result as ExcelJS.CellValue);
    }

    if ("richText" in value && Array.isArray(value.richText)) {
      return value.richText.map((part) => part.text).join("").trim();
    }

    if ("formula" in value) {
      return "";
    }

    return String(value).trim();
  }

  return String(value).trim();
}

function applyCharacterLimit(
  segments: DocumentTextSegment[],
  maxChars: number,
): { segments: DocumentTextSegment[]; truncatedByChars: boolean } {
  const limitedSegments: DocumentTextSegment[] = [];
  let remaining = maxChars;
  let truncatedByChars = false;

  for (const segment of segments) {
    if (remaining <= 0) {
      truncatedByChars = true;
      break;
    }

    const included = segment.text.slice(0, remaining);
    const truncated = included.length < segment.text.length;
    limitedSegments.push({
      ...segment,
      text: included,
      charCount: included.length,
      truncated: segment.truncated === true || truncated,
    });
    truncatedByChars = truncatedByChars || truncated;
    remaining -= included.length;
  }

  return { segments: limitedSegments, truncatedByChars };
}

function classifyXlsxError(error: unknown): "password_protected" | "macro_or_active_content" | "extraction_failed" {
  const message = error instanceof Error ? error.message.toLowerCase() : "";
  if (message.includes("password") || message.includes("encrypted")) {
    return "password_protected";
  }

  if (message.includes("macro") || message.includes("vba")) {
    return "macro_or_active_content";
  }

  return "extraction_failed";
}
