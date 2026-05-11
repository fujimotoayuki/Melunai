/**
 * Task Runner — Tool Executor for approved action plans.
 *
 * Executes a list of validated FileActions sequentially using the Tool Layer.
 * Stops on the first failure (DEC-008: stop-on-failure) and marks remaining
 * actions as "skipped".
 *
 * Only `validatedActions` from ValidationResult are accepted here — raw
 * ActionPlan.actions must never reach this function directly.
 *
 * Security note:
 *   This module runs from Electron's main-process side of the app, not from the
 *   renderer. The renderer may request execution only through the approved IPC
 *   flow, and main reuses validated actions rather than trusting arbitrary UI
 *   payloads.
 */

import {
  createFolder,
  createFile,
  moveFile,
  renameFile,
} from "../tools/index.js";
import { writeJsonlEvent } from "../storage/index.js";
import type {
  ExcelWorkbookSchema,
  FileAction,
  GenerateExcelAction,
  GeneratePowerPointAction,
  GenerateWordAction,
  PowerPointDraftOutline,
  WordDraftOutline,
  GeneratedDocumentDraft,
  DocumentGenerationPlan,
  DocumentGenerationApproval,
} from "../types/index.js";
import { createDocxDraft } from "../documentGeneration/docxDraftWriter.js";
import { createPptxDraft } from "../documentGeneration/pptxDraftWriter.js";
import { createXlsxDraft } from "../documentGeneration/xlsxDraftWriter.js";

// ---------------------------------------------------------------------------
// Result types (exported — tests/unit and executionBridge import from here)
// ---------------------------------------------------------------------------

export type ActionExecutionStatus = "success" | "failed" | "skipped";

export interface ActionExecutionRecord {
  /** Matches FileAction.id from the validated plan */
  actionId: string;
  /** Human-readable action type for logging/display */
  actionType: string;
  /** Outcome of this action */
  status: ActionExecutionStatus;
  /** Tool Layer error code if status === "failed" */
  errorCode?: string;
  /** Japanese user-facing error message if status === "failed" */
  errorMessage?: string;
}

export interface ExecutionResult {
  /** true only if all actions completed successfully */
  success: boolean;
  records: ActionExecutionRecord[];
  completedCount: number;
  failedCount: number;
  skippedCount: number;
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

/**
 * Execute a list of validated FileActions sequentially.
 *
 * @param validatedActions - From ValidationResult.validatedActions only.
 * @param workspaceRoot    - Absolute path to the workspace root.
 * @param logFilePath      - JSONL log file path for event logging.
 * @param sessionId        - Current session ID for log correlation.
 */
export async function executeApprovedPlan(
  validatedActions: FileAction[],
  workspaceRoot: string,
  logFilePath: string,
  sessionId: string,
): Promise<ExecutionResult> {
  const records: ActionExecutionRecord[] = [];
  let failedAt: number | null = null;

  for (let i = 0; i < validatedActions.length; i++) {
    const action = validatedActions[i];

    if (action === undefined) continue;

    // Stop-on-failure: skip remaining after first failure (DEC-008)
    if (failedAt !== null) {
      records.push({
        actionId: action.id,
        actionType: action.type,
        status: "skipped",
      });
      continue;
    }

    const record = await executeAction(action, workspaceRoot);
    records.push(record);

    if (record.status === "failed") {
      failedAt = i;
    }
  }

  const completedCount = records.filter((r) => r.status === "success").length;
  const failedCount = records.filter((r) => r.status === "failed").length;
  const skippedCount = records.filter((r) => r.status === "skipped").length;

  const result: ExecutionResult = {
    success: failedCount === 0,
    records,
    completedCount,
    failedCount,
    skippedCount,
  };

  // Log the overall execution result (fire-and-forget — non-critical)
  void writeJsonlEvent(logFilePath, {
    type: "execution_result",
    sessionId,
    workspaceRoot,
    executionResult: result,
  });

  return result;
}

// ---------------------------------------------------------------------------
// Internal: dispatch single action to Tool Layer
// ---------------------------------------------------------------------------

async function executeAction(
  action: FileAction,
  workspaceRoot: string,
): Promise<ActionExecutionRecord> {
  switch (action.type) {
    case "create_folder": {
      const result = await createFolder(workspaceRoot, action.path);
      if (!result.ok) {
        return {
          actionId: action.id,
          actionType: action.type,
          status: "failed",
          errorCode: result.error.code,
          errorMessage: resolveToolError(action.type, result.error.code),
        };
      }
      return { actionId: action.id, actionType: action.type, status: "success" };
    }

    case "create_file": {
      const result = await createFile(
        workspaceRoot,
        action.path,
        action.content,
        action.overwrite ?? false,
      );
      if (!result.ok) {
        return {
          actionId: action.id,
          actionType: action.type,
          status: "failed",
          errorCode: result.error.code,
          errorMessage: resolveToolError(action.type, result.error.code),
        };
      }
      return { actionId: action.id, actionType: action.type, status: "success" };
    }

    case "move_file": {
      const result = await moveFile(
        workspaceRoot,
        action.from,
        action.to,
        action.overwrite ?? false,
      );
      if (!result.ok) {
        return {
          actionId: action.id,
          actionType: action.type,
          status: "failed",
          errorCode: result.error.code,
          errorMessage: resolveToolError(action.type, result.error.code),
        };
      }
      return { actionId: action.id, actionType: action.type, status: "success" };
    }

    case "rename_file": {
      const result = await renameFile(
        workspaceRoot,
        action.from,
        action.to,
        action.overwrite ?? false,
      );
      if (!result.ok) {
        return {
          actionId: action.id,
          actionType: action.type,
          status: "failed",
          errorCode: result.error.code,
          errorMessage: resolveToolError(action.type, result.error.code),
        };
      }
      return { actionId: action.id, actionType: action.type, status: "success" };
    }

    case "generate_word":
    case "generate_powerpoint":
    case "generate_excel": {
      const plan = buildGenerationPlan(action);
      const approval: DocumentGenerationApproval = {
        planId: plan.id,
        approvedAt: new Date().toISOString(),
        approvedTargetPath: plan.draft.targetPath,
      };
      const writer =
        action.type === "generate_word" ? createDocxDraft
        : action.type === "generate_powerpoint" ? createPptxDraft
        : createXlsxDraft;
      const result = await writer(workspaceRoot, plan, approval);
      if (!result.ok) {
        return {
          actionId: action.id,
          actionType: action.type,
          status: "failed",
          errorCode: result.error.code,
          errorMessage: resolveToolError(action.type, result.error.code),
        };
      }
      return { actionId: action.id, actionType: action.type, status: "success" };
    }
  }
}

// ---------------------------------------------------------------------------
// Internal: convert an inline generate_* FileAction into a
// DocumentGenerationPlan that the existing docx/pptx/xlsx writers accept.
// ---------------------------------------------------------------------------

function buildGenerationPlan(
  action: GenerateWordAction | GeneratePowerPointAction | GenerateExcelAction,
): DocumentGenerationPlan {
  const draft = buildDraft(action);
  return {
    id: action.id,
    summary: action.description,
    draft,
    status: "draft_proposed",
    issues: [],
    requiresApproval: true,
  };
}

function buildDraft(
  action: GenerateWordAction | GeneratePowerPointAction | GenerateExcelAction,
): GeneratedDocumentDraft {
  const filename = action.path.split(/[\\/]/).pop() ?? action.path;
  const baseCommon = {
    id: action.id,
    proposedFilename: filename,
    targetPath: action.path,
    title: action.title,
    ...(action.purpose !== undefined ? { purpose: action.purpose } : {}),
    draftDisclaimer: {
      label: "Draft",
      message:
        "This file is a Melunai draft generated from an LLM ActionPlan. Please review before final use.",
      required: true as const,
    },
    sources: [
      {
        kind: "user_instruction" as const,
        label: "User instruction",
        excerpt: action.description.slice(0, 500),
      },
    ],
    warnings: [
      "Generated content is a first draft and may need factual, formatting, and wording review.",
    ],
  };

  if (action.type === "generate_word") {
    const draft: WordDraftOutline = {
      ...baseCommon,
      kind: "word",
      extension: ".docx",
      sections: action.sections,
    };
    return draft;
  }

  if (action.type === "generate_powerpoint") {
    const draft: PowerPointDraftOutline = {
      ...baseCommon,
      kind: "powerpoint",
      extension: ".pptx",
      slides: action.slides,
    };
    return draft;
  }

  const draft: ExcelWorkbookSchema = {
    ...baseCommon,
    kind: "excel",
    extension: ".xlsx",
    sheets: action.sheets,
  };
  return draft;
}

// ---------------------------------------------------------------------------
// Internal: user-facing Japanese error messages by tool error code
// ---------------------------------------------------------------------------

function resolveToolError(actionType: string, code: string): string {
  // Shared error codes
  switch (code) {
    case "target_exists":
      return "対象のパスに既にファイルまたはフォルダが存在します。";
    case "overwrite_unsupported":
      return "上書きはMVPではサポートされていません。別のファイル名を指定してください。";
    case "source_missing":
      return "移動元のファイルが見つかりません。";
    case "invalid_extension":
      return "ファイル拡張子が想定と異なります。";
    case "outside_workspace":
      return "作成先がワークスペース外、または安全でないパスです。";
  }

  // Action-specific error codes
  switch (actionType) {
    case "create_folder":
      return resolveCreateFolderError(code);
    case "create_file":
      return resolveCreateFileError(code);
    case "move_file":
    case "rename_file":
      return resolveMoveFileError(code);
    case "generate_word":
      return "Word ドラフトの作成に失敗しました。";
    case "generate_powerpoint":
      return "PowerPoint ドラフトの作成に失敗しました。";
    case "generate_excel":
      return "Excel ドラフトの作成に失敗しました。";
    default:
      return "ファイル操作に失敗しました。";
  }
}

function resolveCreateFolderError(code: string): string {
  switch (code) {
    case "create_folder_failed":
      return "フォルダの作成に失敗しました。パスを確認してください。";
    default:
      return "フォルダの作成に失敗しました。";
  }
}

function resolveCreateFileError(code: string): string {
  switch (code) {
    case "create_file_failed":
      return "ファイルの作成に失敗しました。パスを確認してください。";
    default:
      return "ファイルの作成に失敗しました。";
  }
}

function resolveMoveFileError(code: string): string {
  switch (code) {
    case "move_file_failed":
      return "ファイルの移動に失敗しました。パスを確認してください。";
    default:
      return "ファイルの移動または名前変更に失敗しました。";
  }
}
