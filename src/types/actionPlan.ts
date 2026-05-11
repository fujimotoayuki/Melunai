import type {
  ExcelDraftSheet,
  PowerPointDraftSlide,
  WordDraftSection,
} from "./documentGeneration.js";

export type ActionType =
  | "create_folder"
  | "create_file"
  | "move_file"
  | "rename_file"
  | "generate_word"
  | "generate_powerpoint"
  | "generate_excel";

export type RiskLevel = "safe" | "warning" | "blocked";

export interface BaseAction {
  id: string;
  type: ActionType;
  description: string;
}

export interface CreateFolderAction extends BaseAction {
  type: "create_folder";
  path: string;
}

export interface CreateFileAction extends BaseAction {
  type: "create_file";
  path: string;
  content: string;
  overwrite?: boolean;
}

export interface MoveFileAction extends BaseAction {
  type: "move_file";
  from: string;
  to: string;
  overwrite?: boolean;
}

export interface RenameFileAction extends BaseAction {
  type: "rename_file";
  from: string;
  to: string;
  overwrite?: boolean;
}

// ---------------------------------------------------------------------------
// Document generation actions (TASK-031)
//
// These actions let the LLM propose Office document drafts inline within an
// ActionPlan, so the user can request "make a Word doc about X" in normal
// chat. Each action carries the full draft outline; the executor converts it
// to a DocumentGenerationPlan and dispatches to the existing draft writers
// in src/documentGeneration/.
//
// Safety:
//   - target path MUST be inside the workspace and end with the correct ext
//   - existing files are NEVER overwritten (writers use the wx flag)
//   - Safety Validator blocks plans with conflicting targets or bad paths
// ---------------------------------------------------------------------------

export interface GenerateWordAction extends BaseAction {
  type: "generate_word";
  /** Workspace-relative .docx path. Must not exist yet. */
  path: string;
  /** Document title shown on the first page / in metadata. */
  title: string;
  /** Optional one-line purpose, included in the draft preview. */
  purpose?: string;
  /** Ordered Word sections (heading + paragraphs + optional bullets). */
  sections: WordDraftSection[];
}

export interface GeneratePowerPointAction extends BaseAction {
  type: "generate_powerpoint";
  /** Workspace-relative .pptx path. Must not exist yet. */
  path: string;
  title: string;
  purpose?: string;
  /** Ordered slides (title + bullets + optional speaker notes). */
  slides: PowerPointDraftSlide[];
}

export interface GenerateExcelAction extends BaseAction {
  type: "generate_excel";
  /** Workspace-relative .xlsx path. Must not exist yet. */
  path: string;
  title: string;
  purpose?: string;
  /** One or more sheets, each with named columns and optional sample rows. */
  sheets: ExcelDraftSheet[];
}

export type FileAction =
  | CreateFolderAction
  | CreateFileAction
  | MoveFileAction
  | RenameFileAction
  | GenerateWordAction
  | GeneratePowerPointAction
  | GenerateExcelAction;

export interface ActionPlan {
  summary: string;
  actions: FileAction[];
}

export interface ValidationIssue {
  actionId?: string;
  level: RiskLevel;
  code: string;
  message: string;
}

export interface ValidationResult {
  executable: boolean;
  issues: ValidationIssue[];
  validatedActions: FileAction[];
}
