import fs from "node:fs/promises";
import path from "node:path";

import { PDFParse } from "pdf-parse";

import type {
  DocumentExtractionLimits,
  DocumentExtractionResult,
  DocumentSourceMetadata,
  DocumentTextSegment,
} from "../types/index.js";
import { resolveWorkspacePath } from "../utils/pathUtils.js";

export const DEFAULT_PDF_EXTRACTION_LIMITS: DocumentExtractionLimits = {
  maxFiles: 8,
  maxCharsPerFile: 40_000,
  maxTotalChars: 120_000,
  maxPagesPerPdf: 20,
  maxParagraphsPerDocx: 250,
  maxSheetsPerXlsx: 12,
  maxCellsPerSheet: 2_000,
  maxSlidesPerPptx: 80,
};

export async function extractPdfText(
  workspaceRoot: string,
  relativePath: string,
  limits: Partial<DocumentExtractionLimits> = {},
): Promise<DocumentExtractionResult> {
  const normalizedLimits = normalizeLimits(limits);
  const name = path.basename(relativePath);
  const baseResult = {
    path: relativePath,
    name,
    kind: "pdf" as const,
    extension: ".pdf" as const,
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

  if (path.extname(absolutePath).toLowerCase() !== ".pdf") {
    return {
      ...baseResult,
      status: "unsupported",
      skipReason: "unsupported_type",
      errorMessage: "Only .pdf files are supported by the PDF extractor.",
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

    const buffer = await fs.readFile(absolutePath);
    const parser = new PDFParse({ data: buffer });

    try {
      const info = await parser.getInfo({ parsePageInfo: false });
      const metadata = buildMetadata(info.info, info.total);
      const pageLimit = Math.min(info.total, normalizedLimits.maxPagesPerPdf);
      const text = await parser.getText({
        first: pageLimit,
        pageJoiner: "\n",
      });

      const segments = buildPageSegments(text.pages, normalizedLimits.maxCharsPerFile);
      const includedCharCount = segments.reduce((sum, segment) => sum + segment.charCount, 0);
      const extractedText = segments.map((segment) => segment.text).join("\n").trim();
      const warnings: string[] = [];

      if (info.total > normalizedLimits.maxPagesPerPdf) {
        warnings.push(`PDF page count exceeded limit; read first ${normalizedLimits.maxPagesPerPdf} page(s).`);
      }

      if (includedCharCount >= normalizedLimits.maxCharsPerFile) {
        warnings.push("PDF text was truncated by the per-file character limit.");
      }

      if (extractedText.length === 0) {
        return {
          ...baseResult,
          status: "skipped",
          metadata: {
            ...metadata,
            scannedOrImageOnly: true,
          },
          skipReason: "scanned_pdf_ocr_required",
          warnings: [
            ...warnings,
            "No extractable text was found. OCR is out of scope for the first document-reading version.",
          ],
        };
      }

      const partial = warnings.length > 0 || segments.some((segment) => segment.truncated === true);

      return {
        ...baseResult,
        status: partial ? "partial" : "extracted",
        metadata,
        segments,
        originalCharCount: text.text.length,
        includedCharCount,
        truncated: partial,
        warnings,
      };
    } finally {
      await parser.destroy();
    }
  } catch (error) {
    return {
      ...baseResult,
      status: "failed",
      skipReason: classifyPdfError(error),
      errorMessage: error instanceof Error ? error.message : "PDF extraction failed.",
      warnings: ["PDF text extraction failed."],
    };
  }
}

function normalizeLimits(limits: Partial<DocumentExtractionLimits>): DocumentExtractionLimits {
  return {
    ...DEFAULT_PDF_EXTRACTION_LIMITS,
    ...limits,
    maxCharsPerFile: normalizePositiveInteger(
      limits.maxCharsPerFile,
      DEFAULT_PDF_EXTRACTION_LIMITS.maxCharsPerFile,
    ),
    maxPagesPerPdf: normalizePositiveInteger(
      limits.maxPagesPerPdf,
      DEFAULT_PDF_EXTRACTION_LIMITS.maxPagesPerPdf,
    ),
  };
}

function normalizePositiveInteger(value: number | undefined, fallback: number): number {
  if (value === undefined || !Number.isFinite(value) || value <= 0) {
    return fallback;
  }

  return Math.floor(value);
}

function buildMetadata(info: unknown, pageCount: number): DocumentSourceMetadata {
  const record = isRecord(info) ? info : {};

  return {
    title: stringValue(record.Title),
    author: stringValue(record.Author),
    subject: stringValue(record.Subject),
    createdAt: stringValue(record.CreationDate),
    modifiedAt: stringValue(record.ModDate),
    pageCount,
  };
}

function buildPageSegments(
  pages: Array<{ num: number; text: string }>,
  maxChars: number,
): DocumentTextSegment[] {
  const segments: DocumentTextSegment[] = [];
  let remaining = maxChars;

  for (const page of pages) {
    if (remaining <= 0) {
      break;
    }

    const text = page.text.trim();
    if (text.length === 0) {
      continue;
    }

    const included = text.slice(0, remaining);
    const truncated = text.length > remaining;
    segments.push({
      id: `page-${page.num}`,
      kind: "page",
      pageNumber: page.num,
      text: included,
      charCount: included.length,
      truncated,
    });

    remaining -= included.length;
  }

  return segments;
}

function classifyPdfError(error: unknown): "password_protected" | "extraction_failed" {
  const message = error instanceof Error ? error.message.toLowerCase() : "";
  if (message.includes("password") || message.includes("encrypted")) {
    return "password_protected";
  }

  return "extraction_failed";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}
