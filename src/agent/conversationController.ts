import { chat } from "../llm/index.js";
import type { OllamaClientConfig } from "../llm/index.js";
import type { ToolResult, Workspace } from "../types/index.js";
import type { FilePreview } from "./contextBuilder.js";

export interface ConversationRequest {
  userInstruction: string;
  model: string;
  workspace?: Workspace | null;
  ollamaConfig?: OllamaClientConfig;
  filePreviews?: FilePreview[];
  /**
   * Lightweight mode for the Normal Chat Fast Path:
   *   - drops workspace name from system prompt
   *   - ignores filePreviews completely
   *   - shorter system message
   * Caller decides when to use it (see main.ts chat-message handler).
   */
  light?: boolean;
}

/**
 * Side-channel metrics filled by replyToConversation so the caller can write
 * a performance_trace without re-computing prompt sizes.
 */
export interface ConversationMeta {
  llmCalled: boolean;
  promptChars: number;
  contextFileCount: number;
  promptBuildMs: number;
  llmMs: number;
  /** Light fast-path was used. */
  light: boolean;
}

export interface ConversationResultMeta {
  meta: ConversationMeta;
}

export type ConversationResult = ToolResult<string> & ConversationResultMeta;

export async function replyToConversation(
  request: ConversationRequest,
): Promise<ConversationResult> {
  const meta: ConversationMeta = {
    llmCalled: false,
    promptChars: 0,
    contextFileCount: 0,
    promptBuildMs: 0,
    llmMs: 0,
    light: request.light ?? false,
  };

  const promptStart = Date.now();
  const previews = request.light ? [] : (request.filePreviews ?? []);
  const systemContent = buildConversationSystemMessage(
    request.workspace ?? null,
    request.light ?? false,
  );
  const userContent = buildConversationUserMessage(
    request.userInstruction,
    previews,
  );
  const messages = [
    { role: "system" as const, content: systemContent },
    { role: "user" as const, content: userContent },
  ];
  meta.promptBuildMs = Date.now() - promptStart;
  meta.promptChars = systemContent.length + userContent.length;
  meta.contextFileCount = previews.length;

  meta.llmCalled = true;
  const llmStart = Date.now();
  const result = await chat({
    model: request.model,
    messages,
    config: request.ollamaConfig,
  });
  meta.llmMs = Date.now() - llmStart;

  if (!result.ok) {
    return { ...result, meta };
  }

  return { ok: true, data: result.data.trim(), meta };
}

function buildConversationSystemMessage(
  workspace: Workspace | null,
  light: boolean,
): string {
  // Light system message keeps Qwen2.5 3B happy: minimum tokens, no
  // workspace, no rules about file claims (no preview is sent in light mode).
  if (light) {
    return [
      "You are Melunai, a friendly local desktop assistant.",
      "Reply in Japanese. Keep replies to 1-3 short sentences unless the user asks for more.",
    ].join("\n");
  }

  return [
    "You are Melunai. Reply in Japanese unless asked otherwise.",
    "Keep replies concise and practical.",
    "This is chat only. Do not claim file changes were executed.",
    workspace === null ? "No workspace selected." : `Workspace: ${workspace.displayName}.`,
  ].join("\n");
}

function buildConversationUserMessage(
  userInstruction: string,
  filePreviews: FilePreview[],
): string {
  if (filePreviews.length === 0) {
    return userInstruction;
  }

  const previewText = filePreviews
    .slice(0, 3)
    .map((preview) => {
      const suffix = preview.truncated ? "\n[truncated]" : "";
      return `--- ${preview.path} ---\n${preview.content}${suffix}`;
    })
    .join("\n\n");

  return [
    userInstruction,
    "",
    "Read-only reference snippets:",
    previewText,
  ].join("\n");
}
