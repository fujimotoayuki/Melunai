export type ExtractableDocumentExtension = ".pdf" | ".docx" | ".xlsx" | ".pptx";

export type DocumentKind =
  | "pdf"
  | "word"
  | "excel"
  | "powerpoint";

export type DocumentExtractionStatus =
  | "extracted"
  | "partial"
  | "skipped"
  | "unsupported"
  | "failed";

export type DocumentExtractionSkipReason =
  | "unsupported_type"
  | "too_large"
  | "too_many_pages"
  | "too_many_sheets"
  | "too_many_slides"
  | "outside_workspace"
  | "password_protected"
  | "scanned_pdf_ocr_required"
  | "macro_or_active_content"
  | "empty_document"
  | "extraction_failed";

export type DocumentSegmentKind =
  | "page"
  | "heading"
  | "paragraph"
  | "sheet"
  | "cell_range"
  | "slide"
  | "speaker_notes"
  | "metadata";

export interface DocumentExtractionLimits {
  maxFiles: number;
  maxCharsPerFile: number;
  maxTotalChars: number;
  maxPagesPerPdf: number;
  maxParagraphsPerDocx: number;
  maxSheetsPerXlsx: number;
  maxCellsPerSheet: number;
  maxSlidesPerPptx: number;
}

export interface DocumentSourceSelection {
  /** Workspace-relative path. */
  path: string;
  name: string;
  kind: DocumentKind;
  extension: ExtractableDocumentExtension;
  size?: number;
  modifiedAt?: string;
}

export interface DocumentSourceMetadata {
  title?: string;
  author?: string;
  subject?: string;
  createdAt?: string;
  modifiedAt?: string;
  pageCount?: number;
  sheetCount?: number;
  slideCount?: number;
  paragraphCount?: number;
  hasMacros?: boolean;
  passwordProtected?: boolean;
  scannedOrImageOnly?: boolean;
}

export interface DocumentTextSegment {
  id: string;
  kind: DocumentSegmentKind;
  text: string;
  pageNumber?: number;
  headingLevel?: number;
  sheetName?: string;
  cellRange?: string;
  slideNumber?: number;
  charCount: number;
  truncated?: boolean;
}

export interface DocumentExtractionResult {
  /** Workspace-relative path. */
  path: string;
  name: string;
  kind: DocumentKind;
  extension: ExtractableDocumentExtension;
  status: DocumentExtractionStatus;
  metadata?: DocumentSourceMetadata;
  segments: DocumentTextSegment[];
  originalCharCount?: number;
  includedCharCount?: number;
  truncated?: boolean;
  skipReason?: DocumentExtractionSkipReason;
  warnings: string[];
  errorMessage?: string;
}

export interface DocumentSourceReference {
  /** Workspace-relative path. */
  path: string;
  label?: string;
  pageNumber?: number;
  sheetName?: string;
  cellRange?: string;
  slideNumber?: number;
  segmentId?: string;
  excerpt?: string;
}

export interface DocumentExtractionRequest {
  workspaceRoot: string;
  selectedDocuments: DocumentSourceSelection[];
  userInstruction: string;
  limits: DocumentExtractionLimits;
}

export interface DocumentExtractionPlan {
  documents: DocumentSourceSelection[];
  limits: DocumentExtractionLimits;
  estimatedDocumentCount: number;
}

export interface DocumentSummary {
  /** Workspace-relative path. */
  path: string;
  title?: string;
  summary: string;
  keyPoints: string[];
  todos?: string[];
  suggestedDescriptions?: string[];
  suggestedFilenames?: string[];
  sources: DocumentSourceReference[];
  warnings: string[];
  sourceStatus: DocumentExtractionStatus;
}

export interface CombinedDocumentSummary {
  summary: string;
  keyPoints: string[];
  todos?: string[];
  suggestedDescriptions?: string[];
  suggestedFilenames?: string[];
  sources: DocumentSourceReference[];
  warnings: string[];
}

export interface DocumentExtractionBatchResult {
  documents: DocumentExtractionResult[];
  documentSummaries: DocumentSummary[];
  combinedSummary?: CombinedDocumentSummary;
  limits: DocumentExtractionLimits;
}
