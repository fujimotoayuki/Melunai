import type { DocumentSourceReference } from "./documentExtraction.js";
import type { SourceReference } from "./multiFileReading.js";

export type GeneratedDocumentExtension = ".docx" | ".pptx" | ".xlsx";

export type GeneratedDocumentKind = "word" | "powerpoint" | "excel";

export type DocumentGenerationStatus =
  | "draft_proposed"
  | "approved"
  | "created"
  | "rejected"
  | "failed";

export type DocumentGenerationRiskLevel = "safe" | "warning" | "blocked";

export type DocumentGenerationSource =
  | {
      kind: "text_file";
      reference: SourceReference;
    }
  | {
      kind: "document";
      reference: DocumentSourceReference;
    }
  | {
      kind: "user_instruction";
      label: string;
      excerpt?: string;
    };

export interface DocumentGenerationLimits {
  maxSourceReferences: number;
  maxWordSections: number;
  maxWordParagraphsPerSection: number;
  maxPowerPointSlides: number;
  maxPowerPointBulletsPerSlide: number;
  maxExcelSheets: number;
  maxExcelColumnsPerSheet: number;
  maxExcelSampleRowsPerSheet: number;
}

export interface DocumentGenerationDisclaimer {
  label: string;
  message: string;
  required: true;
}

export interface DocumentGenerationIssue {
  level: DocumentGenerationRiskLevel;
  code: string;
  message: string;
  targetPath?: string;
}

export interface GeneratedDocumentBase {
  id: string;
  kind: GeneratedDocumentKind;
  extension: GeneratedDocumentExtension;
  proposedFilename: string;
  targetPath: string;
  title: string;
  purpose?: string;
  draftDisclaimer: DocumentGenerationDisclaimer;
  sources: DocumentGenerationSource[];
  warnings: string[];
}

export interface WordDraftSection {
  id: string;
  heading: string;
  paragraphs: string[];
  bullets?: string[];
  sourceReferences?: DocumentGenerationSource[];
}

export interface WordDraftOutline extends GeneratedDocumentBase {
  kind: "word";
  extension: ".docx";
  sections: WordDraftSection[];
}

export interface PowerPointDraftSlide {
  id: string;
  title: string;
  subtitle?: string;
  bullets: string[];
  speakerNotes?: string;
  sourceReferences?: DocumentGenerationSource[];
}

export interface PowerPointDraftOutline extends GeneratedDocumentBase {
  kind: "powerpoint";
  extension: ".pptx";
  slides: PowerPointDraftSlide[];
}

export interface ExcelDraftColumn {
  id: string;
  header: string;
  description?: string;
  valueType: "text" | "number" | "date" | "currency" | "boolean";
}

export interface ExcelDraftSheet {
  id: string;
  name: string;
  purpose?: string;
  columns: ExcelDraftColumn[];
  sampleRows?: Array<Record<string, string | number | boolean>>;
  sourceReferences?: DocumentGenerationSource[];
}

export interface ExcelWorkbookSchema extends GeneratedDocumentBase {
  kind: "excel";
  extension: ".xlsx";
  sheets: ExcelDraftSheet[];
}

export type GeneratedDocumentDraft =
  | WordDraftOutline
  | PowerPointDraftOutline
  | ExcelWorkbookSchema;

export interface DocumentGenerationRequest {
  workspaceRoot: string;
  userInstruction: string;
  outputKind: GeneratedDocumentKind;
  sources: DocumentGenerationSource[];
  limits: DocumentGenerationLimits;
}

export interface DocumentGenerationPlan {
  id: string;
  summary: string;
  draft: GeneratedDocumentDraft;
  status: "draft_proposed";
  issues: DocumentGenerationIssue[];
  requiresApproval: true;
}

export interface DocumentGenerationApproval {
  planId: string;
  approvedAt: string;
  approvedTargetPath: string;
}

export interface DocumentGenerationResult {
  planId: string;
  status: DocumentGenerationStatus;
  targetPath: string;
  createdAt?: string;
  errorMessage?: string;
  warnings: string[];
}
