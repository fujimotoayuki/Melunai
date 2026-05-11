import fs from "node:fs/promises";
import path from "node:path";

import mammoth from "mammoth";

import type {
  DocumentExtractionLimits,
  DocumentExtractionResult,
  DocumentSourceMetadata,
  DocumentTextSegment,
} from "../types/index.js";
import { resolveWorkspacePath } from "../utils/pathUtils.js";

export const DEFAULT_DOCX_EXTRACTION_LIMITS: DocumentExtractionLimits = {
  maxFiles: 8,
  maxCharsPerFile: 40_000,
  maxTotalChars: 120_000,
  maxPagesPerPdf: 20,
  maxParagraphsPerDocx: 300,
  maxSheetsPerXlsx: 12,
  maxCellsPerSheet: 2_000,
  maxSlidesPerPptx: 80,
};

export async function extractDocxText(
  workspaceRoot: string,
  relativePath: string,
  limits: Partial<DocumentExtractionLimits> = {},
): Promise<DocumentExtractionResult> {
  const normalizedLimits = normalizeLimits(limits);
  const name = path.basename(relativePath);
  const baseResult = {
    path: relativePath,
    name,
    kind: "word" as const,
    extension: ".docx" as const,
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

  if (path.extname(absolutePath).toLowerCase() !== ".docx") {
    return {
      ...baseResult,
      status: "unsupported",
      skipReason: "unsupported_type",
      errorMessage: "Only .docx files are supported by the DOCX extractor.",
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

    // docx は zip コンテナ。mammoth に渡す前に zip-bomb チェック。
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
      // zip check 自体が失敗した場合は extractor 本体の error として処理
      return {
        ...baseResult,
        status: "failed",
        skipReason: "extraction_failed",
        errorMessage: cause instanceof Error ? cause.message : String(cause),
      };
    }

    const htmlResult = await mammoth.convertToHtml(
      { path: absolutePath },
      {
        externalFileAccess: false,
        ignoreEmptyParagraphs: true,
      },
    );
    const rawSegments = parseMammothHtml(htmlResult.value);
    const limited = applySegmentLimits(rawSegments, normalizedLimits);
    const metadata: DocumentSourceMetadata = {
      paragraphCount: rawSegments.length,
    };
    const warnings = htmlResult.messages.map((message) => message.message);

    if (limited.truncatedByParagraphCount) {
      warnings.push(`DOCX paragraph count exceeded limit; read first ${normalizedLimits.maxParagraphsPerDocx} segment(s).`);
    }

    if (limited.truncatedByChars) {
      warnings.push("DOCX text was truncated by the per-file character limit.");
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

    const partial = warnings.length > 0 || limited.truncatedByParagraphCount || limited.truncatedByChars;

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
      skipReason: classifyDocxError(error),
      errorMessage: error instanceof Error ? error.message : "DOCX extraction failed.",
      warnings: ["DOCX text extraction failed."],
    };
  }
}

function normalizeLimits(limits: Partial<DocumentExtractionLimits>): DocumentExtractionLimits {
  return {
    ...DEFAULT_DOCX_EXTRACTION_LIMITS,
    ...limits,
    maxCharsPerFile: normalizePositiveInteger(
      limits.maxCharsPerFile,
      DEFAULT_DOCX_EXTRACTION_LIMITS.maxCharsPerFile,
    ),
    maxParagraphsPerDocx: normalizePositiveInteger(
      limits.maxParagraphsPerDocx,
      DEFAULT_DOCX_EXTRACTION_LIMITS.maxParagraphsPerDocx,
    ),
  };
}

function normalizePositiveInteger(value: number | undefined, fallback: number): number {
  if (value === undefined || !Number.isFinite(value) || value <= 0) {
    return fallback;
  }

  return Math.floor(value);
}

function parseMammothHtml(html: string): DocumentTextSegment[] {
  const segments: DocumentTextSegment[] = [];
  const blockPattern = /<(h[1-6]|p)[^>]*>([\s\S]*?)<\/\1>/gi;
  let match: RegExpExecArray | null;
  let index = 0;

  while ((match = blockPattern.exec(html)) !== null) {
    const tag = match[1]?.toLowerCase();
    const body = match[2] ?? "";
    const text = decodeHtml(stripTags(body)).trim();
    if (tag === undefined || text.length === 0) {
      continue;
    }

    index += 1;
    const headingMatch = /^h([1-6])$/.exec(tag);
    if (headingMatch !== null) {
      segments.push({
        id: `heading-${index}`,
        kind: "heading",
        headingLevel: Number(headingMatch[1]),
        text,
        charCount: text.length,
      });
    } else {
      segments.push({
        id: `paragraph-${index}`,
        kind: "paragraph",
        text,
        charCount: text.length,
      });
    }
  }

  return segments;
}

function applySegmentLimits(
  segments: DocumentTextSegment[],
  limits: DocumentExtractionLimits,
): {
  segments: DocumentTextSegment[];
  truncatedByParagraphCount: boolean;
  truncatedByChars: boolean;
} {
  const limitedSegments: DocumentTextSegment[] = [];
  let remainingChars = limits.maxCharsPerFile;
  const paragraphLimited = segments.slice(0, limits.maxParagraphsPerDocx);

  for (const segment of paragraphLimited) {
    if (remainingChars <= 0) {
      break;
    }

    const included = segment.text.slice(0, remainingChars);
    limitedSegments.push({
      ...segment,
      text: included,
      charCount: included.length,
      truncated: included.length < segment.text.length,
    });
    remainingChars -= included.length;
  }

  return {
    segments: limitedSegments,
    truncatedByParagraphCount: segments.length > limits.maxParagraphsPerDocx,
    truncatedByChars: limitedSegments.some((segment) => segment.truncated === true) ||
      limitedSegments.length < paragraphLimited.length,
  };
}

function stripTags(value: string): string {
  return value.replace(/<[^>]+>/g, "");
}

function decodeHtml(value: string): string {
  return value
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, "\"")
    .replace(/&#39;/g, "'");
}

function classifyDocxError(error: unknown): "password_protected" | "extraction_failed" {
  const message = error instanceof Error ? error.message.toLowerCase() : "";
  if (message.includes("password") || message.includes("encrypted")) {
    return "password_protected";
  }

  return "extraction_failed";
}
