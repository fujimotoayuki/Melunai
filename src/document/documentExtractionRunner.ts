import path from "node:path";
import * as fs from "node:fs";

import { extractDocxText } from "./docxExtractor.js";
import { extractPdfText } from "./pdfExtractor.js";
import { extractPptxText } from "./pptxExtractor.js";
import { extractXlsxText } from "./xlsxExtractor.js";

/**
 * 各種 Office/PDF 抽出器に渡してよい最大ファイルサイズ（50MB）。
 * これを超える入力は ZIP-bomb / OOM 対策のため事前に拒否する。
 */
const MAX_DOCUMENT_FILE_BYTES = 50 * 1024 * 1024;
import type {
  CombinedDocumentSummary,
  DocumentExtractionBatchResult,
  DocumentExtractionLimits,
  DocumentExtractionResult,
  DocumentSourceReference,
  DocumentSourceSelection,
  DocumentSummary,
  ExtractableDocumentExtension,
} from "../types/index.js";

export const DEFAULT_DOCUMENT_EXTRACTION_LIMITS: DocumentExtractionLimits = {
  maxFiles: 8,
  maxCharsPerFile: 40_000,
  maxTotalChars: 120_000,
  maxPagesPerPdf: 20,
  maxParagraphsPerDocx: 300,
  maxSheetsPerXlsx: 12,
  maxCellsPerSheet: 2_000,
  maxSlidesPerPptx: 80,
};

export async function extractDocuments(args: {
  workspaceRoot: string;
  paths: string[];
  userInstruction: string;
  limits?: Partial<DocumentExtractionLimits>;
}): Promise<DocumentExtractionBatchResult> {
  const limits = normalizeLimits(args.limits ?? {});
  const documents: DocumentExtractionResult[] = [];

  for (let index = 0; index < args.paths.length; index += 1) {
    const relativePath = args.paths[index];
    if (relativePath === undefined) continue;

    if (index >= limits.maxFiles) {
      documents.push(skippedTooManyFiles(relativePath));
      continue;
    }

    documents.push(await extractOneDocument(args.workspaceRoot, relativePath, limits));
  }

  const documentSummaries = documents.map((document) => summarizeDocument(document));
  const combinedSummary = buildCombinedSummary(documentSummaries, documents, args.userInstruction);

  return {
    documents,
    documentSummaries,
    combinedSummary,
    limits,
  };
}

export function toDocumentSourceSelection(relativePath: string): DocumentSourceSelection | null {
  const extension = path.extname(relativePath).toLowerCase();
  if (!isExtractableExtension(extension)) {
    return null;
  }

  return {
    path: relativePath,
    name: path.basename(relativePath),
    kind: extensionToKind(extension),
    extension,
  };
}

async function extractOneDocument(
  workspaceRoot: string,
  relativePath: string,
  limits: DocumentExtractionLimits,
): Promise<DocumentExtractionResult> {
  const extension = path.extname(relativePath).toLowerCase();

  // サイズ事前チェック: ファイル全体をメモリに乗せる前に lstat で巨大ファイルを弾く。
  // 同時に symlink/junction も拒否（パス検証は呼び出し元の責務だが多層防御として）。
  const absolutePath = path.resolve(workspaceRoot, relativePath);
  try {
    const lst = await fs.promises.lstat(absolutePath);
    if (lst.isSymbolicLink()) {
      return {
        path: relativePath,
        name: path.basename(relativePath),
        kind: "pdf",
        extension: ".pdf",
        status: "skipped",
        segments: [],
        skipReason: "too_large",
        warnings: ["Symbolic links are not supported for document extraction."],
      };
    }
    if (lst.size > MAX_DOCUMENT_FILE_BYTES) {
      return {
        path: relativePath,
        name: path.basename(relativePath),
        kind: extensionToKindOrPdf(extension),
        extension: extension as ".pdf" | ".docx" | ".xlsx" | ".pptx",
        status: "skipped",
        segments: [],
        skipReason: "too_large",
        warnings: [
          `File exceeds ${Math.floor(MAX_DOCUMENT_FILE_BYTES / 1024 / 1024)}MB extraction limit.`,
        ],
      };
    }
  } catch {
    // 存在しない/読めない場合は extractor 側で適切なエラーを返してもらう
  }

  switch (extension) {
    case ".pdf":
      return extractPdfText(workspaceRoot, relativePath, limits);
    case ".docx":
      return extractDocxText(workspaceRoot, relativePath, limits);
    case ".xlsx":
      return extractXlsxText(workspaceRoot, relativePath, limits);
    case ".pptx":
      return extractPptxText(workspaceRoot, relativePath, limits);
    default:
      return {
        path: relativePath,
        name: path.basename(relativePath),
        kind: "pdf",
        extension: ".pdf",
        status: "unsupported",
        segments: [],
        skipReason: "unsupported_type",
        warnings: ["Unsupported document type."],
      };
  }
}

function extensionToKindOrPdf(ext: string): DocumentExtractionResult["kind"] {
  switch (ext) {
    case ".docx": return "word";
    case ".xlsx": return "excel";
    case ".pptx": return "powerpoint";
    default: return "pdf";
  }
}

function summarizeDocument(document: DocumentExtractionResult): DocumentSummary {
  const titleSegment = document.segments.find((segment) => segment.kind === "heading") ??
    document.segments[0];
  const keyPoints = document.segments
    .map((segment) => segment.text.replace(/\s+/g, " ").trim())
    .filter((text) => text.length > 0)
    .slice(0, 5)
    .map((text) => text.slice(0, 220));
  const title = titleSegment?.text.split(/\r?\n/)[0]?.slice(0, 120) ?? document.name;
  const sources = document.segments.slice(0, 6).map((segment): DocumentSourceReference => ({
    path: document.path,
    label: document.name,
    pageNumber: segment.pageNumber,
    sheetName: segment.sheetName,
    cellRange: segment.cellRange,
    slideNumber: segment.slideNumber,
    segmentId: segment.id,
    excerpt: segment.text.slice(0, 240),
  }));

  return {
    path: document.path,
    title,
    summary: keyPoints.length > 0
      ? `${document.name}: ${keyPoints[0]}`
      : describeUnavailableDocument(document),
    keyPoints,
    suggestedDescriptions: keyPoints.length > 0 ? [`${document.name}: ${keyPoints[0]}`] : undefined,
    suggestedFilenames: keyPoints.length > 0 ? [suggestFilename(document, title)] : undefined,
    sources,
    warnings: document.warnings,
    sourceStatus: document.status,
  };
}

function buildCombinedSummary(
  summaries: DocumentSummary[],
  documents: DocumentExtractionResult[],
  userInstruction: string,
): CombinedDocumentSummary {
  const extractedCount = documents.filter((document) => document.segments.length > 0).length;
  const warnings = documents.flatMap((document) => document.warnings);

  return {
    summary: `Prepared ${extractedCount} document(s) for: ${userInstruction}`,
    keyPoints: summaries.flatMap((summary) => summary.keyPoints).slice(0, 12),
    suggestedDescriptions: summaries.flatMap((summary) => summary.suggestedDescriptions ?? []).slice(0, 8),
    suggestedFilenames: summaries.flatMap((summary) => summary.suggestedFilenames ?? []).slice(0, 8),
    sources: summaries.flatMap((summary) => summary.sources).slice(0, 16),
    warnings,
  };
}

function normalizeLimits(limits: Partial<DocumentExtractionLimits>): DocumentExtractionLimits {
  return {
    ...DEFAULT_DOCUMENT_EXTRACTION_LIMITS,
    ...limits,
  };
}

function skippedTooManyFiles(relativePath: string): DocumentExtractionResult {
  const selection = toDocumentSourceSelection(relativePath);

  return {
    path: relativePath,
    name: path.basename(relativePath),
    kind: selection?.kind ?? "pdf",
    extension: selection?.extension ?? ".pdf",
    status: "skipped",
    segments: [],
    skipReason: "too_large",
    warnings: ["Document skipped because the selected document count exceeded the configured limit."],
  };
}

function describeUnavailableDocument(document: DocumentExtractionResult): string {
  if (document.skipReason !== undefined) {
    return `${document.name} could not be summarized: ${document.skipReason}.`;
  }

  return `${document.name} did not contain extractable text.`;
}

function suggestFilename(document: DocumentExtractionResult, title: string): string {
  const cleaned = title
    .replace(/[<>:"/\\|?*\u0000-\u001F]/g, "")
    .replace(/\s+/g, "_")
    .slice(0, 48)
    .toLowerCase();

  return `${cleaned || path.basename(document.path, document.extension)}${document.extension}`;
}

function isExtractableExtension(extension: string): extension is ExtractableDocumentExtension {
  return extension === ".pdf" ||
    extension === ".docx" ||
    extension === ".xlsx" ||
    extension === ".pptx";
}

function extensionToKind(extension: ExtractableDocumentExtension): DocumentSourceSelection["kind"] {
  switch (extension) {
    case ".pdf":
      return "pdf";
    case ".docx":
      return "word";
    case ".xlsx":
      return "excel";
    case ".pptx":
      return "powerpoint";
  }
}
