import {
  DEFAULT_OLLAMA_ENDPOINT,
  DEFAULT_TIMEOUT_MS,
  type OllamaApiChatResponse,
  type OllamaApiTagsResponse,
  type OllamaChatRequest,
  type OllamaChatResult,
  type OllamaClientConfig,
  type OllamaListModelsResult,
  type OllamaModel,
} from "./ollamaTypes.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Ollama エンドポイントを解決し、loopback (127.0.0.1 / localhost / ::1) のみに制限する。
 *
 * これは Melunai の中核的な防衛ライン: レンダラから任意の `endpoint` を渡されると
 * チャット内容（ユーザーの機密プロンプト）が外部 URL に送信されてしまうため、
 * 全ての ollama 呼び出しはここで弾く必要がある。
 *
 * main.ts 側にも同等のチェック (resolveOllamaEndpoint) があるが、フォールバック層として
 * クライアント自身でも検証する（多層防御）。
 */
function resolveEndpoint(config: OllamaClientConfig | undefined): string {
  const raw = (config?.endpoint ?? DEFAULT_OLLAMA_ENDPOINT).replace(/\/$/, "");
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return DEFAULT_OLLAMA_ENDPOINT.replace(/\/$/, "");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return DEFAULT_OLLAMA_ENDPOINT.replace(/\/$/, "");
  }
  const host = parsed.hostname.toLowerCase();
  // IPv4-mapped IPv6 ([::ffff:127.0.0.1] 等) も解析して内部の IPv4 を判定
  const v4Mapped = host.match(/^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
  const effectiveHost = v4Mapped !== null ? v4Mapped[1]! : host;
  const allowed = new Set(["127.0.0.1", "localhost", "::1"]);
  // 127.0.0.0/8 全体を loopback として許可
  if (allowed.has(effectiveHost) || /^127\./.test(effectiveHost)) {
    return raw;
  }
  console.warn(
    `[ollama] Endpoint host '${parsed.hostname}' is not loopback; falling back to default.`,
  );
  return DEFAULT_OLLAMA_ENDPOINT.replace(/\/$/, "");
}

function resolveTimeoutMs(config: OllamaClientConfig | undefined): number {
  return config?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
}

function failResult<T = never>(
  code: string,
  message: string,
  cause?: unknown,
): import("../types/index.js").ToolResult<T> {
  return {
    ok: false,
    error: { code, message, cause },
  };
}

async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort();
  }, timeoutMs);

  try {
    const response = await fetch(url, { ...init, signal: controller.signal });
    return response;
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// listModels
// ---------------------------------------------------------------------------

/**
 * Lists all locally available Ollama models.
 * Returns an empty array if Ollama is reachable but no models are installed.
 * Returns a structured error if Ollama is unreachable or returns an unexpected response.
 */
export async function listModels(
  config?: OllamaClientConfig,
): Promise<OllamaListModelsResult> {
  const endpoint = resolveEndpoint(config);
  const timeoutMs = resolveTimeoutMs(config);
  const url = `${endpoint}/api/tags`;

  let response: Response;

  try {
    response = await fetchWithTimeout(url, { method: "GET" }, timeoutMs);
  } catch (cause) {
    if (isAbortError(cause)) {
      return failResult(
        "ollama_timeout",
        "Ollama did not respond within the timeout period. Check that Ollama is running.",
        cause,
      );
    }

    return failResult(
      "ollama_unavailable",
      "Could not connect to Ollama. Check that Ollama is running at the configured endpoint.",
      cause,
    );
  }

  if (!response.ok) {
    return failResult(
      "ollama_error",
      `Ollama returned an unexpected status: ${response.status}.`,
    );
  }

  let body: unknown;

  try {
    body = await response.json();
  } catch (cause) {
    return failResult(
      "ollama_invalid_response",
      "Ollama returned a response that could not be parsed as JSON.",
      cause,
    );
  }

  if (!isTagsResponse(body)) {
    return failResult(
      "ollama_invalid_response",
      "Ollama tags response did not match the expected shape.",
    );
  }

  const models: OllamaModel[] = body.models.map((m) => ({
    name: m.name,
    modifiedAt: m.modified_at,
    size: m.size,
    digest: m.digest,
  }));

  return { ok: true, data: models };
}

// ---------------------------------------------------------------------------
// chat
// ---------------------------------------------------------------------------

/**
 * Sends a chat request to a local Ollama model.
 * Returns the assistant's text content on success.
 * Returns a structured error on any failure — never throws.
 * Never falls back to a cloud LLM.
 */
export async function chat(request: OllamaChatRequest): Promise<OllamaChatResult> {
  const { model, messages, config } = request;
  const endpoint = resolveEndpoint(config);
  const timeoutMs = resolveTimeoutMs(config);
  const url = `${endpoint}/api/chat`;

  const body = JSON.stringify({
    model,
    messages: messages.map((m) => ({ role: m.role, content: m.content })),
    stream: false,
  });

  let response: Response;

  try {
    response = await fetchWithTimeout(
      url,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body,
      },
      timeoutMs,
    );
  } catch (cause) {
    if (isAbortError(cause)) {
      return failResult(
        "ollama_timeout",
        "Ollama did not respond within the timeout period. Check that Ollama is running.",
        cause,
      );
    }

    return failResult(
      "ollama_unavailable",
      "Could not connect to Ollama. Check that Ollama is running at the configured endpoint.",
      cause,
    );
  }

  if (!response.ok) {
    let detail = "";

    try {
      const errBody = await response.text();
      detail = errBody.slice(0, 200);
    } catch {
      // ignore
    }

    if (response.status === 404) {
      return failResult(
        "ollama_model_not_found",
        `Model "${model}" was not found in Ollama. Check that the model is installed.${detail ? ` Detail: ${detail}` : ""}`,
      );
    }

    return failResult(
      "ollama_error",
      `Ollama returned an unexpected status: ${response.status}.${detail ? ` Detail: ${detail}` : ""}`,
    );
  }

  let parsed: unknown;

  try {
    parsed = await response.json();
  } catch (cause) {
    return failResult(
      "ollama_invalid_response",
      "Ollama returned a chat response that could not be parsed as JSON.",
      cause,
    );
  }

  if (!isChatResponse(parsed)) {
    return failResult(
      "ollama_invalid_response",
      "Ollama chat response did not match the expected shape.",
    );
  }

  if (typeof parsed.message.content !== "string") {
    return failResult(
      "ollama_invalid_response",
      "Ollama chat response message content was not a string.",
    );
  }

  return { ok: true, data: parsed.message.content };
}

// ---------------------------------------------------------------------------
// Type guards
// ---------------------------------------------------------------------------

function isTagsResponse(value: unknown): value is OllamaApiTagsResponse {
  if (typeof value !== "object" || value === null) return false;
  const obj = value as Record<string, unknown>;
  if (!Array.isArray(obj["models"])) return false;

  return obj["models"].every(
    (m) =>
      typeof m === "object" &&
      m !== null &&
      typeof (m as Record<string, unknown>)["name"] === "string" &&
      typeof (m as Record<string, unknown>)["modified_at"] === "string" &&
      typeof (m as Record<string, unknown>)["size"] === "number" &&
      typeof (m as Record<string, unknown>)["digest"] === "string",
  );
}

function isChatResponse(value: unknown): value is OllamaApiChatResponse {
  if (typeof value !== "object" || value === null) return false;
  const obj = value as Record<string, unknown>;
  if (typeof obj["model"] !== "string") return false;
  if (typeof obj["done"] !== "boolean") return false;

  const msg = obj["message"];
  if (typeof msg !== "object" || msg === null) return false;
  const msgObj = msg as Record<string, unknown>;

  return (
    typeof msgObj["role"] === "string" && typeof msgObj["content"] === "string"
  );
}

function isAbortError(cause: unknown): boolean {
  return (
    cause instanceof Error &&
    (cause.name === "AbortError" || cause.name === "TimeoutError")
  );
}
