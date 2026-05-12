import { chat } from "../llm/index.js";
import type { OllamaClientConfig } from "../llm/index.js";
import type { ActionPlan, ValidationResult, Workspace } from "../types/index.js";
import { listFolder } from "../tools/index.js";
import { buildWorkspaceContext, type FilePreview } from "./contextBuilder.js";
import { buildPrompt } from "./promptBuilder.js";
import { parseActionPlan } from "./actionPlanParser.js";
import { validateActionPlanSafety } from "./safetyValidator.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface PlanRequest {
  /** The user's natural language instruction */
  userInstruction: string;
  workspace: Workspace;
  /** Ollama model name (e.g. "llama3:latest") */
  model: string;
  /** Optional Ollama client config (endpoint, timeout) */
  ollamaConfig?: OllamaClientConfig;
  /**
   * Optional file previews to include in context.
   * The caller (UI layer) is responsible for selecting relevant files
   * and ensuring each preview is already truncated to a safe size.
   * The Agent Controller does not automatically read file contents.
   */
  filePreviews?: FilePreview[];
  /** Maximum file tree entries to include in context (default: 100) */
  maxContextEntries?: number;
}

export type AgentErrorCode =
  | "workspace_unreadable"
  | "ollama_unavailable"
  | "ollama_timeout"
  | "ollama_error"
  | "ollama_model_not_found"
  | "ollama_invalid_response"
  | "parse_failed";

export interface AgentError {
  code: AgentErrorCode;
  /** Internal English error code */
  message: string;
  /** Japanese user-facing explanation */
  userMessage: string;
  cause?: unknown;
}

/**
 * Side-channel metrics filled by planAction so the caller can write a
 * performance_trace without re-computing prompt sizes. None of these affect
 * application logic; they exist purely for the trace logger.
 */
export interface PlanMeta {
  /** True when Ollama was actually called (false for early validation failure). */
  llmCalled: boolean;
  /** Total characters across system + user prompt messages. */
  promptChars: number;
  /** Number of file previews actually included in the prompt. */
  contextFileCount: number;
  /** Number of file-tree entries serialized into the prompt. */
  workspaceTreeEntries: number;
  /** Per-stage timings the caller can fold into stageTimings. */
  promptBuildMs: number;
  llmMs: number;
}

export type PlanResult =
  | {
      ok: true;
      actionPlan: ActionPlan;
      validationResult: ValidationResult;
      meta: PlanMeta;
    }
  | {
      ok: false;
      error: AgentError;
      meta: PlanMeta;
    };

// ---------------------------------------------------------------------------
// planAction — the core planning flow
// ---------------------------------------------------------------------------

/**
 * Runs the full planning flow for a user instruction.
 *
 * Flow:
 *   User instruction
 *   -> Context Builder
 *   -> Prompt Builder
 *   -> Ollama Client
 *   -> ActionPlan Parser
 *   -> Safety Validator
 *   -> return { actionPlan, validationResult }
 *
 * This function NEVER executes file actions.
 * It NEVER trusts raw LLM output without parsing and validation.
 * It NEVER bypasses the Safety Validator.
 */
export async function planAction(request: PlanRequest): Promise<PlanResult> {
  const {
    userInstruction,
    workspace,
    model,
    ollamaConfig,
    filePreviews = [],
    maxContextEntries,
  } = request;

  const meta: PlanMeta = {
    llmCalled: false,
    promptChars: 0,
    contextFileCount: 0,
    workspaceTreeEntries: 0,
    promptBuildMs: 0,
    llmMs: 0,
  };

  // Step 1: Read workspace file tree (read-only)
  const listResult = await listFolder(workspace.rootPath);

  if (!listResult.ok) {
    return fail(
      meta,
      "workspace_unreadable",
      `Failed to read workspace: ${listResult.error.message}`,
      "ワークスペースのファイル一覧を取得できませんでした。フォルダが存在するか確認してください。",
      listResult.error.cause,
    );
  }

  // Step 2 + 3: Build context + prompt (timed for the trace).
  const promptStart = Date.now();
  const context = buildWorkspaceContext(workspace, listResult.data, {
    maxEntries: maxContextEntries,
    filePreviews,
  });
  const { systemMessage, userMessage } = buildPrompt(userInstruction, context);
  meta.promptBuildMs = Date.now() - promptStart;
  meta.promptChars = systemMessage.content.length + userMessage.content.length;
  meta.contextFileCount = context.filePreviews.length;
  meta.workspaceTreeEntries = context.totalEntries;

  // Step 4: Call Ollama
  meta.llmCalled = true;
  const llmStart = Date.now();
  const chatResult = await chat({
    model,
    messages: [systemMessage, userMessage],
    config: ollamaConfig,
  });
  meta.llmMs = Date.now() - llmStart;

  if (!chatResult.ok) {
    const { code, message, cause } = chatResult.error;
    return fail(
      meta,
      code as AgentErrorCode,
      message,
      resolveOllamaUserMessage(code),
      cause,
    );
  }

  // Step 5: Parse LLM output — never trust raw text
  const parseResult = parseActionPlan(chatResult.data);

  if (!parseResult.ok) {
    return fail(
      meta,
      "parse_failed",
      `ActionPlan parsing failed: ${parseResult.error.code} — ${parseResult.error.message}`,
      "AIの返答を解析できませんでした。もう一度試すか、指示を変えてください。",
    );
  }

  // Step 6: Validate — never bypass the Safety Validator
  const validationResult = validateActionPlanSafety(
    parseResult.data,
    workspace.rootPath,
  );

  return {
    ok: true,
    actionPlan: parseResult.data,
    validationResult,
    meta,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function fail(
  meta: PlanMeta,
  code: AgentErrorCode,
  message: string,
  userMessage: string,
  cause?: unknown,
): PlanResult {
  return {
    ok: false,
    error: { code, message, userMessage, cause },
    meta,
  };
}

function resolveOllamaUserMessage(code: string): string {
  switch (code) {
    case "ollama_unavailable":
      return "Ollamaに接続できませんでした。Ollamaが起動しているか確認してください。";
    case "ollama_timeout":
      return "ローカルLLMの応答が遅れています。参照ファイルを減らすか、短い指示で続けてください。";
    case "ollama_model_not_found":
      return "指定されたモデルが見つかりませんでした。Ollamaにモデルがインストールされているか確認してください。";
    case "ollama_invalid_response":
      return "Ollamaから予期しない形式の応答が返されました。もう一度試してください。";
    default:
      return "Ollamaとの通信中にエラーが発生しました。もう一度試してください。";
  }
}
