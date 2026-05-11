import type {
  FileNode,
  ActionPlan,
  DocumentExtractionBatchResult,
  DocumentGenerationPlan,
  DocumentGenerationResult,
  GeneratedDocumentKind,
  MultiFileReadResult,
  ValidationResult,
  Workspace,
} from "../../types/index.js";

// ---------------------------------------------------------------------------
// App phase — tracks where in the workflow the app currently is
// ---------------------------------------------------------------------------

/**
 * idle       — No active plan. User can give instructions.
 * planning   — Waiting for Ollama to return an ActionPlan.
 * approval   — Plan received. Waiting for user to approve or reject.
 * executing  — User approved. Actions are being executed.
 * done       — Execution complete. Results shown.
 */
export type AppPhase =
  | "idle"
  | "planning"
  | "approval"
  | "executing"
  | "done";

// ---------------------------------------------------------------------------
// Chat
// ---------------------------------------------------------------------------

export interface ChatMessage {
  id: string;
  role: "user" | "assistant" | "system";
  content: string;
  timestamp: string;
  stats?: {
    tokenPerSecond: number | null;
    elapsedSeconds: number | null;
  };
}

// ---------------------------------------------------------------------------
// File preview
// ---------------------------------------------------------------------------

export interface FilePreviewState {
  /** Workspace-relative path of the currently selected file, or null */
  path: string | null;
  /** File content (may be truncated) */
  content: string | null;
  /** True when content was cut off due to size limits */
  truncated: boolean;
  loading: boolean;
  /** Japanese error message for display */
  error: string | null;
}

// ---------------------------------------------------------------------------
// Multi-file reading
// ---------------------------------------------------------------------------

export interface MultiFileReadingState {
  selectedPaths: string[];
  loading: boolean;
  result: MultiFileReadResult | null;
  /** Japanese error message for display */
  error: string | null;
}

export interface DocumentReadingState {
  selectedPaths: string[];
  loading: boolean;
  result: DocumentExtractionBatchResult | null;
  /** Japanese error message for display */
  error: string | null;
}

export interface DocumentGenerationState {
  outputKind: GeneratedDocumentKind;
  loading: boolean;
  executing: boolean;
  plan: DocumentGenerationPlan | null;
  generationToken: string | null;
  result: DocumentGenerationResult | null;
  /** Japanese error message for display */
  error: string | null;
}

// ---------------------------------------------------------------------------
// Action preview
// ---------------------------------------------------------------------------

export interface ActionPreviewState {
  actionPlan: ActionPlan | null;
  validationResult: ValidationResult | null;
  planToken: string | null;
}

// ---------------------------------------------------------------------------
// Action Chips (TASK-040 / Workbench v2 §37)
//
// Surfaces 1-click options when a user input is ambiguous (e.g. "ファイル作って"
// without an extension, or "フォルダ必要かもね"). Chips are local UI only —
// they never come from the LLM, never auto-execute, and never bypass the
// SafetyValidator + token approval flow.
// ---------------------------------------------------------------------------

export type ActionChipKind =
  | "choose_text_file"
  | "choose_folder"
  | "choose_word"
  | "choose_powerpoint"
  | "choose_excel"
  | "ask_filename"
  | "create_folder_now"   // future: triggered from "フォルダ必要かもね"
  | "open_organize_panel"
  | "cancel";

export interface ActionChip {
  id: string;
  label: string;
  kind: ActionChipKind;
}

export interface ActionChipsState {
  /** Plain Japanese question shown above the chips. */
  message: string | null;
  chips: ActionChip[];
}

// ---------------------------------------------------------------------------
// Root app state
// ---------------------------------------------------------------------------

export interface AppState {
  // ---- Workspace ----
  workspace: Workspace | null;
  fileTree: FileNode[];
  workspaceLoading: boolean;
  /** Japanese error message for display */
  workspaceError: string | null;

  // ---- Chat ----
  messages: ChatMessage[];
  userInput: string;

  // ---- Ollama model ----
  availableModels: string[];
  selectedModel: string;
  modelLoading: boolean;
  /** Japanese error message for display */
  modelError: string | null;

  // ---- File preview ----
  filePreview: FilePreviewState;

  // ---- Multi-file reading ----
  multiFileReading: MultiFileReadingState;

  // ---- Document reading ----
  documentReading: DocumentReadingState;

  // ---- Document generation ----
  documentGeneration: DocumentGenerationState;

  // ---- Action preview ----
  actionPreview: ActionPreviewState;

  // ---- Action chips (ambiguity-resolution UI; TASK-040) ----
  actionChips: ActionChipsState;

  // ---- Phase and errors ----
  phase: AppPhase;
  /** Japanese error message shown when planning fails */
  planningError: string | null;
  /** Japanese result message shown after execution */
  executionSummary: string | null;
}

// ---------------------------------------------------------------------------
// Initial state
// ---------------------------------------------------------------------------

export const initialState: AppState = {
  workspace: null,
  fileTree: [],
  workspaceLoading: false,
  workspaceError: null,

  messages: [],
  userInput: "",

  availableModels: [],
  selectedModel: "",
  modelLoading: false,
  modelError: null,

  filePreview: {
    path: null,
    content: null,
    truncated: false,
    loading: false,
    error: null,
  },

  multiFileReading: {
    selectedPaths: [],
    loading: false,
    result: null,
    error: null,
  },

  documentReading: {
    selectedPaths: [],
    loading: false,
    result: null,
    error: null,
  },

  documentGeneration: {
    outputKind: "word",
    loading: false,
    executing: false,
    plan: null,
    generationToken: null,
    result: null,
    error: null,
  },

  actionPreview: {
    actionPlan: null,
    validationResult: null,
    planToken: null,
  },

  actionChips: {
    message: null,
    chips: [],
  },

  phase: "idle",
  planningError: null,
  executionSummary: null,
};
