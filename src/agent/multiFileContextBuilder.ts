import path from "node:path";

import { readFile } from "../tools/index.js";
import type {
  CombinedFileSummary,
  MultiFileReadPlan,
  MultiFileReadRequest,
  MultiFileReadResult,
  PerFileSummary,
  ReadableTextExtension,
  SourceFileLimits,
  SourceFileReadResult,
  SourceFileSelection,
  SourceFileSkipReason,
  SourceFileStatus,
} from "../types/index.js";
import { resolveWorkspacePath } from "../utils/pathUtils.js";

export const DEFAULT_SOURCE_FILE_LIMITS: SourceFileLimits = {
  maxFiles: 12,
  maxCharsPerFile: 8_000,
  maxTotalChars: 32_000,
};

const SUPPORTED_TEXT_EXTENSIONS: ReadonlySet<string> = new Set([
  ".md",
  ".txt",
  ".json",
  ".csv",
]);

/**
 * Creates the read plan that will be applied by `buildMultiFileTextContext`.
 *
 * This is deliberately read-only. It does not inspect file contents and it does
 * not produce executable actions.
 */
export function buildMultiFileReadPlan(
  selectedFiles: SourceFileSelection[],
  limits: Partial<SourceFileLimits> = {},
): MultiFileReadPlan {
  const normalizedLimits = normalizeLimits(limits);

  return {
    files: selectedFiles.slice(0, normalizedLimits.maxFiles),
    limits: normalizedLimits,
    estimatedFileCount: Math.min(selectedFiles.length, normalizedLimits.maxFiles),
  };
}

/**
 * Reads multiple selected text files into bounded context for later LLM use.
 *
 * The function applies file-count, per-file, and total-context limits. It also
 * records every skipped, unsupported, truncated, or failed source so the UI can
 * explain what Melunai did before any model synthesis happens.
 */
export async function buildMultiFileTextContext(
  request: MultiFileReadRequest,
): Promise<MultiFileReadResult> {
  const limits = normalizeLimits(request.limits);
  const files: SourceFileReadResult[] = [];
  let remainingTotalChars = limits.maxTotalChars;

  for (let index = 0; index < request.selectedFiles.length; index += 1) {
    const selection = request.selectedFiles[index];
    if (selection === undefined) {
      continue;
    }

    if (index >= limits.maxFiles) {
      files.push(skippedResult(selection, "skipped", "too_many_files"));
      continue;
    }

    const extension = getReadableExtension(selection.path);
    if (extension === null) {
      files.push(skippedResult(selection, "unsupported", "unsupported_type"));
      continue;
    }

    if (!isInsideWorkspace(request.workspaceRoot, selection.path)) {
      files.push(skippedResult(selection, "skipped", "outside_workspace"));
      continue;
    }

    if (remainingTotalChars <= 0) {
      files.push(skippedResult(selection, "skipped", "too_large"));
      continue;
    }

    const readLimit = Math.min(limits.maxCharsPerFile, remainingTotalChars);
    const readResult = await readFile(request.workspaceRoot, selection.path, readLimit);

    if (!readResult.ok) {
      files.push({
        path: selection.path,
        name: selection.name,
        kind: "text",
        extension,
        status: readResult.error.code === "unsupported_file_type" ? "unsupported" : "failed",
        skipReason: mapReadFailure(readResult.error.code),
        errorMessage: readResult.error.message,
      });
      continue;
    }

    const content = readResult.data.content;
    if (content.trim().length === 0) {
      files.push({
        path: readResult.data.path,
        name: selection.name,
        kind: "text",
        extension,
        status: "skipped",
        skipReason: "empty_file",
        originalCharCount: content.length,
        includedCharCount: 0,
      });
      continue;
    }

    const originalCharCount = content.length + (readResult.data.truncated ? 1 : 0);
    const status: SourceFileStatus = readResult.data.truncated ? "truncated" : "included";

    files.push({
      path: readResult.data.path,
      name: selection.name,
      kind: "text",
      extension,
      status,
      content,
      originalCharCount,
      includedCharCount: content.length,
      truncated: readResult.data.truncated,
    });

    remainingTotalChars -= content.length;
  }

  const perFileSummaries = files.map((file) => summarizeFile(file));
  const combinedSummary = buildCombinedSummary(perFileSummaries, files, request.userInstruction);

  return {
    files,
    perFileSummaries,
    combinedSummary,
    limits,
  };
}

function normalizeLimits(limits: Partial<SourceFileLimits>): SourceFileLimits {
  return {
    maxFiles: normalizePositiveInteger(limits.maxFiles, DEFAULT_SOURCE_FILE_LIMITS.maxFiles),
    maxCharsPerFile: normalizePositiveInteger(
      limits.maxCharsPerFile,
      DEFAULT_SOURCE_FILE_LIMITS.maxCharsPerFile,
    ),
    maxTotalChars: normalizePositiveInteger(
      limits.maxTotalChars,
      DEFAULT_SOURCE_FILE_LIMITS.maxTotalChars,
    ),
  };
}

function normalizePositiveInteger(value: number | undefined, fallback: number): number {
  if (value === undefined || !Number.isFinite(value) || value <= 0) {
    return fallback;
  }

  return Math.floor(value);
}

function getReadableExtension(relativePath: string): ReadableTextExtension | null {
  const extension = path.extname(relativePath).toLowerCase();
  return SUPPORTED_TEXT_EXTENSIONS.has(extension)
    ? (extension as ReadableTextExtension)
    : null;
}

function isInsideWorkspace(workspaceRoot: string, relativePath: string): boolean {
  try {
    resolveWorkspacePath(workspaceRoot, relativePath);
    return true;
  } catch {
    return false;
  }
}

function skippedResult(
  selection: SourceFileSelection,
  status: SourceFileStatus,
  skipReason: SourceFileSkipReason,
): SourceFileReadResult {
  return {
    path: selection.path,
    name: selection.name,
    kind: "text",
    extension: path.extname(selection.path).toLowerCase(),
    status,
    skipReason,
  };
}

function mapReadFailure(code: string): SourceFileSkipReason {
  if (code === "unsupported_file_type") return "unsupported_type";
  return "read_failed";
}

function summarizeFile(file: SourceFileReadResult): PerFileSummary {
  if (file.content === undefined || file.content.trim().length === 0) {
    return {
      path: file.path,
      title: file.name,
      summary: describeUnavailableFile(file),
      keyPoints: [],
      warnings: buildFileWarnings(file),
      sourceStatus: file.status,
    };
  }

  const lines = file.content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  const firstLine = lines[0] ?? file.name;
  const title = firstLine.replace(/^#+\s*/, "").slice(0, 120);
  const keyPoints = lines.slice(0, 5).map((line) => line.slice(0, 180));
  const todos = lines
    .filter((line) => /todo|task|next|fixme|やること|TODO/i.test(line))
    .slice(0, 5)
    .map((line) => line.slice(0, 180));

  return {
    path: file.path,
    title,
    summary: `${file.name}: ${firstLine.slice(0, 240)}`,
    keyPoints,
    todos: todos.length > 0 ? todos : undefined,
    warnings: buildFileWarnings(file),
    sourceStatus: file.status,
  };
}

function describeUnavailableFile(file: SourceFileReadResult): string {
  if (file.status === "unsupported") {
    return `${file.name} is not a supported text file for multi-file reading.`;
  }

  if (file.skipReason === "too_many_files") {
    return `${file.name} was skipped because the selected file count exceeded the configured limit.`;
  }

  if (file.skipReason === "too_large") {
    return `${file.name} was skipped because the total context limit was already reached.`;
  }

  if (file.skipReason === "outside_workspace") {
    return `${file.name} was skipped because it is outside the selected workspace.`;
  }

  if (file.skipReason === "empty_file") {
    return `${file.name} is empty.`;
  }

  return `${file.name} could not be read.`;
}

function buildFileWarnings(file: SourceFileReadResult): string[] {
  const warnings: string[] = [];

  if (file.status === "truncated" || file.truncated === true) {
    warnings.push("File content was truncated by the configured limits.");
  }

  if (file.status === "unsupported") {
    warnings.push("Unsupported file type.");
  }

  if (file.status === "failed") {
    warnings.push(file.errorMessage ?? "File read failed.");
  }

  if (file.status === "skipped" && file.skipReason !== undefined) {
    warnings.push(`File skipped: ${file.skipReason}.`);
  }

  return warnings;
}

function buildCombinedSummary(
  perFileSummaries: PerFileSummary[],
  files: SourceFileReadResult[],
  userInstruction: string,
): CombinedFileSummary {
  const includedFiles = files.filter((file) => file.content !== undefined);
  const warnings = files.flatMap((file) => buildFileWarnings(file));
  const topPoints = perFileSummaries.flatMap((summary) => summary.keyPoints).slice(0, 10);
  const todos = perFileSummaries
    .flatMap((summary) => summary.todos ?? [])
    .slice(0, 10);

  return {
    summary: `Prepared ${includedFiles.length} readable file(s) for: ${userInstruction}`,
    keyPoints: topPoints,
    todos: todos.length > 0 ? todos : undefined,
    sources: includedFiles.map((file) => ({
      path: file.path,
      label: file.name,
      excerpt: file.content?.slice(0, 240),
    })),
    warnings,
  };
}
