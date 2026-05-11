import fs from "node:fs/promises";
import path from "node:path";

import { DOMParser } from "@xmldom/xmldom";
import JSZip from "jszip";

import type {
  DocumentExtractionLimits,
  DocumentExtractionResult,
  DocumentSourceMetadata,
  DocumentTextSegment,
} from "../types/index.js";
import { resolveWorkspacePath } from "../utils/pathUtils.js";

export const DEFAULT_PPTX_EXTRACTION_LIMITS: DocumentExtractionLimits = {
  maxFiles: 8,
  maxCharsPerFile: 40_000,
  maxTotalChars: 120_000,
  maxPagesPerPdf: 20,
  maxParagraphsPerDocx: 300,
  maxSheetsPerXlsx: 12,
  maxCellsPerSheet: 2_000,
  maxSlidesPerPptx: 80,
};

interface SlidePart {
  slideNumber: number;
  path: string;
}

export async function extractPptxText(
  workspaceRoot: string,
  relativePath: string,
  limits: Partial<DocumentExtractionLimits> = {},
): Promise<DocumentExtractionResult> {
  const normalizedLimits = normalizeLimits(limits);
  const name = path.basename(relativePath);
  const baseResult = {
    path: relativePath,
    name,
    kind: "powerpoint" as const,
    extension: ".pptx" as const,
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

  if (path.extname(absolutePath).toLowerCase() !== ".pptx") {
    return {
      ...baseResult,
      status: "unsupported",
      skipReason: "unsupported_type",
      errorMessage: "Only .pptx files are supported by the PPTX extractor.",
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

    const buf = await fs.readFile(absolutePath);
    const zip = await JSZip.loadAsync(buf);
    // zip-bomb チェック（pptx は zip コンテナ。展開後 GB 級膨張を防ぐ）
    const { assertZipIsSafe, ZipSafetyError } = await import("./zipSafety.js");
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
    const slideParts = await getOrderedSlideParts(zip);
    const selectedSlides = slideParts.slice(0, normalizedLimits.maxSlidesPerPptx);
    const warnings: string[] = [];

    if (slideParts.length > normalizedLimits.maxSlidesPerPptx) {
      warnings.push(`PPTX slide count exceeded limit; read first ${normalizedLimits.maxSlidesPerPptx} slide(s).`);
    }

    const rawSegments: DocumentTextSegment[] = [];
    for (const slide of selectedSlides) {
      const segment = await extractSlideSegment(zip, slide);
      if (segment !== null) {
        rawSegments.push(segment);
      }
    }

    const limited = applyCharacterLimit(rawSegments, normalizedLimits.maxCharsPerFile);
    const metadata: DocumentSourceMetadata = {
      slideCount: slideParts.length,
    };

    if (limited.truncatedByChars) {
      warnings.push("PPTX text was truncated by the per-file character limit.");
    }

    if (hasMediaFiles(zip)) {
      warnings.push("Embedded media was ignored during text extraction.");
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
      skipReason: classifyPptxError(error),
      errorMessage: error instanceof Error ? error.message : "PPTX extraction failed.",
      warnings: ["PPTX text extraction failed."],
    };
  }
}

function normalizeLimits(limits: Partial<DocumentExtractionLimits>): DocumentExtractionLimits {
  return {
    ...DEFAULT_PPTX_EXTRACTION_LIMITS,
    ...limits,
    maxCharsPerFile: normalizePositiveInteger(
      limits.maxCharsPerFile,
      DEFAULT_PPTX_EXTRACTION_LIMITS.maxCharsPerFile,
    ),
    maxSlidesPerPptx: normalizePositiveInteger(
      limits.maxSlidesPerPptx,
      DEFAULT_PPTX_EXTRACTION_LIMITS.maxSlidesPerPptx,
    ),
  };
}

function normalizePositiveInteger(value: number | undefined, fallback: number): number {
  if (value === undefined || !Number.isFinite(value) || value <= 0) {
    return fallback;
  }

  return Math.floor(value);
}

async function getOrderedSlideParts(zip: JSZip): Promise<SlidePart[]> {
  const presentationXml = await readZipText(zip, "ppt/presentation.xml");
  const relsXml = await readZipText(zip, "ppt/_rels/presentation.xml.rels");

  if (presentationXml === null || relsXml === null) {
    return getSlidePartsByFilename(zip);
  }

  const rels = parseRelationshipTargets(relsXml);
  const slideIds = [...presentationXml.matchAll(/<p:sldId\b[^>]*r:id="([^"]+)"/g)]
    .map((match) => match[1])
    .filter((id): id is string => id !== undefined);

  const parts = slideIds.flatMap((id, index): SlidePart[] => {
    const target = rels.get(id);
    if (target === undefined) return [];
    return [{
      slideNumber: index + 1,
      path: normalizePptTarget(target),
    }];
  });

  return parts.length > 0 ? parts : getSlidePartsByFilename(zip);
}

function getSlidePartsByFilename(zip: JSZip): SlidePart[] {
  return Object.keys(zip.files)
    .filter((name) => /^ppt\/slides\/slide\d+\.xml$/i.test(name))
    .sort((left, right) => getSlideNumberFromPath(left) - getSlideNumberFromPath(right))
    .map((filePath, index) => ({
      slideNumber: index + 1,
      path: filePath,
    }));
}

async function extractSlideSegment(zip: JSZip, slide: SlidePart): Promise<DocumentTextSegment | null> {
  const xml = await readZipText(zip, slide.path);
  if (xml === null) return null;

  const textRuns = extractTextRuns(xml);
  if (textRuns.length === 0) return null;

  const text = textRuns.join("\n").trim();
  if (text.length === 0) return null;

  return {
    id: `slide-${slide.slideNumber}`,
    kind: "slide",
    slideNumber: slide.slideNumber,
    text,
    charCount: text.length,
  };
}

function extractTextRuns(xml: string): string[] {
  const document = new DOMParser().parseFromString(xml, "application/xml");
  const nodes = document.getElementsByTagName("a:t");
  const runs: string[] = [];

  for (let index = 0; index < nodes.length; index += 1) {
    const node = nodes.item(index);
    const value = node?.textContent?.trim();
    if (value !== undefined && value.length > 0) {
      runs.push(value);
    }
  }

  return runs;
}

function parseRelationshipTargets(xml: string): Map<string, string> {
  const document = new DOMParser().parseFromString(xml, "application/xml");
  const nodes = document.getElementsByTagName("Relationship");
  const map = new Map<string, string>();

  for (let index = 0; index < nodes.length; index += 1) {
    const node = nodes.item(index);
    const id = node?.getAttribute("Id");
    const target = node?.getAttribute("Target");
    if (id !== null && id !== undefined && target !== null && target !== undefined) {
      map.set(id, target);
    }
  }

  return map;
}

function normalizePptTarget(target: string): string {
  const normalized = target.replaceAll("\\", "/");
  return normalized.startsWith("ppt/")
    ? normalized
    : `ppt/${normalized.replace(/^\.\//, "")}`;
}

async function readZipText(zip: JSZip, filePath: string): Promise<string | null> {
  const file = zip.file(filePath);
  return file === null ? null : file.async("text");
}

function hasMediaFiles(zip: JSZip): boolean {
  return Object.keys(zip.files).some((name) => /^ppt\/media\//i.test(name));
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

function getSlideNumberFromPath(filePath: string): number {
  const match = /slide(\d+)\.xml$/i.exec(filePath);
  return match?.[1] === undefined ? Number.MAX_SAFE_INTEGER : Number(match[1]);
}

function classifyPptxError(error: unknown): "password_protected" | "macro_or_active_content" | "extraction_failed" {
  const message = error instanceof Error ? error.message.toLowerCase() : "";
  if (message.includes("password") || message.includes("encrypted")) {
    return "password_protected";
  }

  if (message.includes("macro") || message.includes("vba")) {
    return "macro_or_active_content";
  }

  return "extraction_failed";
}
