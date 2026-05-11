/**
 * Sampling bridge — fulfills server-initiated `sampling/createMessage`
 * requests by relaying them to Ollama, the host's local LLM.
 *
 * MCP servers occasionally need an LLM completion of their own (e.g. an
 * agent server reasoning about its next step). The spec routes that call
 * back to the host so the user remains in control. Melunai's bridge:
 *
 *   1. Translates `messages` + `systemPrompt` into Ollama's chat format.
 *   2. Honors `temperature`, `maxTokens`, `stopSequences`.
 *   3. Returns a single assistant message in MCP shape.
 *
 * Streaming is intentionally collapsed — MCP wants a single result block.
 */

import type {
  McpContentBlock,
  McpSamplingMessage,
  McpSamplingRequestParams,
  McpSamplingResult,
} from "./mcpTypes.js";

export interface SamplingBridgeOptions {
  /** Ollama base URL (e.g. `http://127.0.0.1:11434`). Trailing slashes stripped. */
  endpoint: string;
  /** Model used for sampling unless `modelPreferences.hints[*].name` overrides. */
  defaultModel: string;
  /** Hard upper bound on `maxTokens`, regardless of what the server asks for. */
  maxTokensCap?: number;
  /** Per-request timeout in ms. Default 60_000. */
  timeoutMs?: number;
  /**
   * サーバが modelPreferences.hints で指定できるモデル名のホワイトリスト。
   * これに含まれない値は無視して defaultModel にフォールバックする。
   * 未指定の場合は defaultModel のみ許可（最も保守的）。
   */
  allowedModels?: string[];
  /**
   * 同一プロセス内のレート制限（per minute）。指定 N を超えた要求は拒否される。
   * デフォルトは 30 req/min。
   */
  rateLimitPerMinute?: number;
}

/** リング状の発火タイムスタンプを保持してレート制限に使う */
const samplingTimestamps: number[] = [];

interface OllamaChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

interface OllamaChatResponse {
  message?: { role?: string; content?: string };
  done?: boolean;
  done_reason?: string;
  model?: string;
  error?: string;
}

export class OllamaSamplingBridge {
  constructor(private readonly options: SamplingBridgeOptions) {}

  async fulfill(params: McpSamplingRequestParams): Promise<McpSamplingResult> {
    // レート制限（プロセス全体共通の単純実装）
    const limit = this.options.rateLimitPerMinute ?? 30;
    const now = Date.now();
    const oneMinAgo = now - 60_000;
    while (samplingTimestamps.length > 0 && (samplingTimestamps[0] ?? 0) < oneMinAgo) {
      samplingTimestamps.shift();
    }
    if (samplingTimestamps.length >= limit) {
      throw new Error("sampling rate limit exceeded");
    }
    samplingTimestamps.push(now);

    // systemPrompt の長さ制限（巨大プロンプト攻撃防止）
    const messages: OllamaChatMessage[] = [];
    if (typeof params.systemPrompt === "string" && params.systemPrompt.length > 0) {
      messages.push({
        role: "system",
        content: params.systemPrompt.slice(0, 8192),
      });
    }

    // メッセージ件数も上限を設ける（コンテキスト爆発防止）
    const cappedMessages = params.messages.slice(0, 64);
    for (const m of cappedMessages) {
      messages.push({ role: m.role, content: flattenContent(m).slice(0, 16_384) });
    }

    // モデル名はホワイトリストでのみ受け入れる。未指定なら defaultModel のみ許可。
    const allowed = new Set(this.options.allowedModels ?? [this.options.defaultModel]);
    const model = pickModel(params, this.options.defaultModel, allowed);
    const maxTokens = clampMaxTokens(params.maxTokens, this.options.maxTokensCap);
    const timeoutMs = this.options.timeoutMs ?? 60_000;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await fetch(`${stripTrailingSlash(this.options.endpoint)}/api/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: controller.signal,
        body: JSON.stringify({
          model,
          stream: false,
          messages,
          options: {
            temperature: params.temperature,
            num_predict: maxTokens,
            stop: params.stopSequences,
          },
        }),
      });

      if (!response.ok) {
        throw new Error(`Ollama sampling returned ${response.status}`);
      }

      const parsed = (await response.json()) as OllamaChatResponse;
      if (typeof parsed.error === "string" && parsed.error.length > 0) {
        throw new Error(parsed.error);
      }

      const text = parsed.message?.content ?? "";
      return {
        role: "assistant",
        content: { type: "text", text } satisfies McpContentBlock,
        model: parsed.model ?? model,
        stopReason: parsed.done_reason ?? (parsed.done ? "endTurn" : undefined),
      };
    } finally {
      clearTimeout(timer);
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function flattenContent(message: McpSamplingMessage): string {
  const blocks = Array.isArray(message.content) ? message.content : [message.content];
  return blocks
    .map((block) => {
      if (block.type === "text" && typeof block.text === "string") return block.text;
      if (block.type === "image") return "[image omitted]";
      if (block.type === "resource") {
        const inline = block as { text?: string; uri?: string };
        if (typeof inline.text === "string") return inline.text;
        if (typeof inline.uri === "string") return `[resource ${inline.uri}]`;
      }
      return "";
    })
    .join("\n")
    .trim();
}

function pickModel(
  params: McpSamplingRequestParams,
  fallback: string,
  allowed: Set<string>,
): string {
  const hints = params.modelPreferences?.hints ?? [];
  for (const hint of hints) {
    if (typeof hint.name === "string" && hint.name.length > 0 && allowed.has(hint.name)) {
      return hint.name;
    }
  }
  // hints が拒否対象だった場合も静かに defaultModel に倒す（サーバ側に何が許可されているかは漏らさない）
  return fallback;
}

function clampMaxTokens(requested: number | undefined, cap: number | undefined): number | undefined {
  if (requested === undefined) return cap;
  if (cap === undefined) return requested;
  return Math.min(requested, cap);
}

function stripTrailingSlash(url: string): string {
  return url.replace(/\/$/, "");
}
