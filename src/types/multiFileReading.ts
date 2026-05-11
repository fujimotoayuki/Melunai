export type ReadableTextExtension = ".md" | ".txt" | ".json" | ".csv";

export type SourceFileKind = "text";

export type SourceFileStatus =
  | "included"
  | "truncated"
  | "skipped"
  | "unsupported"
  | "failed";

export type SourceFileSkipReason =
  | "unsupported_type"
  | "too_large"
  | "too_many_files"
  | "outside_workspace"
  | "read_failed"
  | "empty_file";

export interface SourceFileLimits {
  maxFiles: number;
  maxCharsPerFile: number;
  maxTotalChars: number;
}

export interface SourceFileSelection {
  /** Workspace-relative path. */
  path: string;
  name: string;
  kind: SourceFileKind;
  extension: ReadableTextExtension;
  size?: number;
  modifiedAt?: string;
}

export interface SourceFileReadResult {
  /** Workspace-relative path. */
  path: string;
  name: string;
  kind: SourceFileKind;
  extension?: string;
  status: SourceFileStatus;
  content?: string;
  originalCharCount?: number;
  includedCharCount?: number;
  truncated?: boolean;
  skipReason?: SourceFileSkipReason;
  errorMessage?: string;
}

export interface PerFileSummary {
  /** Workspace-relative path. */
  path: string;
  title?: string;
  summary: string;
  keyPoints: string[];
  todos?: string[];
  warnings?: string[];
  sourceStatus: SourceFileStatus;
}

export interface SourceReference {
  /** Workspace-relative path. */
  path: string;
  label?: string;
  excerpt?: string;
}

export interface CombinedFileSummary {
  summary: string;
  keyPoints: string[];
  todos?: string[];
  suggestedFileActions?: string[];
  sources: SourceReference[];
  warnings: string[];
}

export interface MultiFileReadRequest {
  workspaceRoot: string;
  selectedFiles: SourceFileSelection[];
  userInstruction: string;
  limits: SourceFileLimits;
}

export interface MultiFileReadPlan {
  files: SourceFileSelection[];
  limits: SourceFileLimits;
  estimatedFileCount: number;
}

export interface MultiFileReadResult {
  files: SourceFileReadResult[];
  perFileSummaries: PerFileSummary[];
  combinedSummary?: CombinedFileSummary;
  limits: SourceFileLimits;
}
