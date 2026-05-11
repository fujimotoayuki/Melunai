/**
 * Streamable HTTP transport (MCP spec rev 2025-03-26).
 *
 * One endpoint speaks both directions:
 *   • POST    — client → server JSON-RPC. Response may be JSON
 *               (single message) or text/event-stream (multiple).
 *   • GET     — client opens a long-lived SSE stream for
 *               server-initiated requests / notifications.
 *   • DELETE  — client terminates the session.
 *
 * `Mcp-Session-Id` returned by the server during initialize is echoed on
 * every subsequent request and is used to scope the long-lived SSE stream.
 */

import type { JsonRpcMessage } from "./mcpTypes.js";
import type { McpTransport, McpTransportHandlers } from "./mcpTransport.js";

/**
 * Optional auth provider. Returns the current access token (or null if
 * unauthenticated), and is asked to refresh after a 401.
 */
export interface HttpAuthProvider {
  getAccessToken(): Promise<string | null>;
  /** Called once per 401 to attempt a token refresh. Returns true on success. */
  refresh(): Promise<boolean>;
  /** Called when refresh fails so the host can launch the OAuth flow. */
  onAuthRequired?: (resourceUrl: string) => void;
}

export interface HttpTransportOptions {
  url: string;
  headers?: Record<string, string>;
  auth?: HttpAuthProvider;
}

/** リクエスト1本あたりのタイムアウト（ms）。長時間ハングを防ぐ。 */
const HTTP_REQUEST_TIMEOUT_MS = 30_000;
/** SSE フレーム（または1メッセージ）の最大バイト数。8MB を超えたら攻撃として扱う。 */
const SSE_MAX_FRAME_BYTES = 8 * 1024 * 1024;
/** SSE ストリームの累積最大バイト数。512MB で頭打ち（OOM 防御）。 */
const SSE_MAX_TOTAL_BYTES = 512 * 1024 * 1024;
/** SSE ストリームのアイドルタイムアウト（ms）。サーバが沈黙したまま接続を保つのを防ぐ。 */
const SSE_IDLE_TIMEOUT_MS = 5 * 60_000;

/**
 * MCP サーバURLを安全性チェックする。
 *  - http:/https: のみ許可
 *  - クラウドメタデータエンドポイント（169.254.169.254 等）拒否
 *  - 環境変数 MELUNAI_ALLOW_LOCAL_MCP=1 が無い限り、内部/プライベートIP拒否
 *  - DNS rebinding 防止のため、必ず new URL でパースしてから host を抽出
 */
export function assertSafeMcpUrl(rawUrl: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error("MCP HTTP transport: invalid URL");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`MCP HTTP transport: unsupported protocol '${parsed.protocol}'`);
  }
  const host = parsed.hostname.toLowerCase();
  // IPv4-mapped IPv6 ([::ffff:169.254.169.254] 等) を IPv4 に正規化して再判定する。
  // これをやらないと攻撃者が `[::ffff:169.254.169.254]` 表記でメタデータエンドポイントに到達できる。
  const v4Mapped = host.match(/^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
  const effectiveHost = v4Mapped !== null ? v4Mapped[1]! : host;

  // クラウド/メタデータ系を完全拒否（IPv4-mapped 経由も含めて）
  if (
    effectiveHost === "metadata.google.internal" ||
    effectiveHost === "metadata.azure.com" ||
    effectiveHost === "169.254.169.254" ||
    effectiveHost === "fd00:ec2::254"
  ) {
    throw new Error(`MCP HTTP transport: blocked metadata host '${host}'`);
  }
  const allowLocal = process.env["MELUNAI_ALLOW_LOCAL_MCP"] === "1";
  if (!allowLocal) {
    // 内部・プライベート・リンクローカル・loopback を拒否
    if (
      effectiveHost === "localhost" ||
      effectiveHost === "::1" ||
      /^127\./.test(effectiveHost) ||
      /^10\./.test(effectiveHost) ||
      /^192\.168\./.test(effectiveHost) ||
      /^169\.254\./.test(effectiveHost) ||
      /^172\.(1[6-9]|2[0-9]|3[0-1])\./.test(effectiveHost) ||
      /^fe80:/i.test(effectiveHost) ||
      /^fc[0-9a-f]{2}:|^fd[0-9a-f]{2}:/i.test(effectiveHost)
    ) {
      throw new Error(
        `MCP HTTP transport: blocked internal host '${host}' (set MELUNAI_ALLOW_LOCAL_MCP=1 to allow)`,
      );
    }
  }
  return parsed;
}

export class StreamableHttpTransport implements McpTransport {
  private handlers: McpTransportHandlers | null = null;
  private sessionId: string | null = null;
  private sseAbort: AbortController | null = null;
  private opened = false;

  constructor(private readonly options: HttpTransportOptions) {
    // 起動時に URL 安全性チェック（後付けで気付いた攻撃 URL を起動時に弾く）
    assertSafeMcpUrl(options.url);
  }

  async start(handlers: McpTransportHandlers): Promise<void> {
    this.handlers = handlers;
    this.opened = true;
    // Server-initiated stream is opened lazily after the first response sets
    // a session id (some servers don't issue one until after `initialize`).
  }

  async send(message: JsonRpcMessage): Promise<void> {
    if (!this.opened) throw new Error("http transport is not open");

    let response = await this.postWithAuth(message);

    if (response.status === 401 && this.options.auth !== undefined) {
      const refreshed = await this.options.auth.refresh();
      if (refreshed) {
        response = await this.postWithAuth(message);
      } else {
        this.options.auth.onAuthRequired?.(this.options.url);
      }
    }

    if (!response.ok) {
      throw new Error(`MCP HTTP transport: server returned ${response.status}`);
    }

    // Capture session id on first reply.
    const sid = response.headers.get("Mcp-Session-Id");
    if (sid !== null && this.sessionId === null) {
      this.sessionId = sid;
      // Now that we have a session, open the long-lived SSE stream for
      // server-initiated messages. Don't await — it runs forever.
      void this.openServerStream();
    }

    // 202 Accepted = no response body (notification ack)
    if (response.status === 202) return;

    const contentType = response.headers.get("Content-Type") ?? "";
    if (contentType.includes("text/event-stream")) {
      // Server may stream multiple messages in response to a single request.
      await this.consumeSseStream(response);
    } else if (contentType.includes("application/json")) {
      const parsed = (await response.json()) as JsonRpcMessage;
      this.handlers?.onMessage(parsed);
    }
    // Other content types: ignore.
  }

  async close(): Promise<void> {
    if (!this.opened) return;
    this.opened = false;

    if (this.sseAbort !== null) {
      this.sseAbort.abort();
      this.sseAbort = null;
    }

    // Best-effort session termination per spec.
    if (this.sessionId !== null) {
      const headers: Record<string, string> = {
        "Mcp-Session-Id": this.sessionId,
        ...(this.options.headers ?? {}),
      };
      const abort = new AbortController();
      const timer = setTimeout(() => abort.abort(), HTTP_REQUEST_TIMEOUT_MS);
      try {
        await fetch(this.options.url, {
          method: "DELETE",
          headers,
          signal: abort.signal,
          redirect: "manual",
        });
      } catch {
        /* ignore — server may not implement DELETE */
      } finally {
        clearTimeout(timer);
      }
    }

    this.sessionId = null;
    this.handlers?.onClose("closed by client");
  }

  isOpen(): boolean {
    return this.opened;
  }

  // -------------------------------------------------------------------------
  // POST helper (with optional Authorization header)
  // -------------------------------------------------------------------------

  private async postWithAuth(message: JsonRpcMessage): Promise<Response> {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      ...(this.options.headers ?? {}),
    };
    if (this.sessionId !== null) headers["Mcp-Session-Id"] = this.sessionId;
    if (this.options.auth !== undefined) {
      const token = await this.options.auth.getAccessToken();
      if (token !== null) headers["Authorization"] = `Bearer ${token}`;
    }
    // タイムアウト付き fetch（30s）。認可不要のレスポンスサイズ攻撃も含めて防ぐ。
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), HTTP_REQUEST_TIMEOUT_MS);
    try {
      return await fetch(this.options.url, {
        method: "POST",
        headers,
        body: JSON.stringify(message),
        signal: abort.signal,
        redirect: "manual", // 任意 URL への 3xx 追従を防ぐ
      });
    } finally {
      clearTimeout(timer);
    }
  }

  // -------------------------------------------------------------------------
  // Server-initiated stream (GET + SSE)
  // -------------------------------------------------------------------------

  private async openServerStream(): Promise<void> {
    if (!this.opened) return;
    const abort = new AbortController();
    this.sseAbort = abort;

    const headers: Record<string, string> = {
      Accept: "text/event-stream",
      ...(this.options.headers ?? {}),
    };
    if (this.sessionId !== null) headers["Mcp-Session-Id"] = this.sessionId;
    if (this.options.auth !== undefined) {
      const token = await this.options.auth.getAccessToken();
      if (token !== null) headers["Authorization"] = `Bearer ${token}`;
    }

    let response: Response;
    try {
      response = await fetch(this.options.url, {
        method: "GET",
        headers,
        signal: abort.signal,
      });
    } catch (cause) {
      // Some servers don't support GET; that's fine.
      this.handlers?.onError?.(cause instanceof Error ? cause : new Error(String(cause)));
      return;
    }

    if (response.status === 405 || response.status === 404) {
      // Server doesn't expose a server-initiated stream. Acceptable.
      return;
    }
    if (!response.ok) {
      this.handlers?.onError?.(
        new Error(`MCP HTTP server stream returned ${response.status}`),
      );
      return;
    }

    try {
      await this.consumeSseStream(response);
    } catch (cause) {
      if (this.opened) {
        this.handlers?.onError?.(
          cause instanceof Error ? cause : new Error(String(cause)),
        );
      }
    } finally {
      if (this.opened) {
        // The long-lived stream ended unexpectedly. Mark the transport closed.
        this.opened = false;
        this.handlers?.onClose("server stream closed");
      }
    }
  }

  // -------------------------------------------------------------------------
  // Generic SSE consumer — handles both POST-response streams and the
  // long-lived server-initiated stream.
  // -------------------------------------------------------------------------

  private async consumeSseStream(response: Response): Promise<void> {
    if (response.body === null) return;
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let totalBytes = 0;
    let lastActivity = Date.now();

    // アイドルタイムアウト監視（5分間 \n\n が来なければ強制中断）
    const idleTimer = setInterval(() => {
      if (Date.now() - lastActivity > SSE_IDLE_TIMEOUT_MS) {
        void reader.cancel("SSE idle timeout").catch(() => undefined);
      }
    }, 30_000);

    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        lastActivity = Date.now();
        // バイト数で計測する（旧実装は decode 後の文字数で計測しており、
        // UTF-8 マルチバイト/サロゲートペアで cap が膨らむバグがあった）。
        totalBytes += value.byteLength;
        if (totalBytes > SSE_MAX_TOTAL_BYTES) {
          await reader.cancel("SSE total size cap exceeded").catch(() => undefined);
          throw new Error("MCP HTTP transport: SSE stream exceeded size cap");
        }
        buffer += decoder.decode(value, { stream: true });
        // 単一フレームが過大（区切りが来ない）→ 攻撃と判定
        if (buffer.length > SSE_MAX_FRAME_BYTES) {
          await reader.cancel("SSE frame cap exceeded").catch(() => undefined);
          throw new Error("MCP HTTP transport: SSE frame exceeded size cap");
        }

        // SSE frames are separated by a blank line.
        let frameEnd = buffer.indexOf("\n\n");
        while (frameEnd !== -1) {
          const frame = buffer.slice(0, frameEnd);
          buffer = buffer.slice(frameEnd + 2);
          this.handleSseFrame(frame);
          frameEnd = buffer.indexOf("\n\n");
        }
      }
      // ストリーム終端で末尾のマルチバイト残骸を flush（呼ばないと最後の JSON が壊れる）
      buffer += decoder.decode();
      // 最後の改行が無いことを許容して flush 残バッファを 1 フレームとして処理
      if (buffer.trim().length > 0) {
        this.handleSseFrame(buffer);
        buffer = "";
      }
    } finally {
      clearInterval(idleTimer);
    }
  }

  private handleSseFrame(frame: string): void {
    // Each frame is one or more `field: value` lines. We only care about
    // the `data:` lines, concatenated per spec.
    const dataLines: string[] = [];
    for (const line of frame.split(/\r?\n/)) {
      if (line.startsWith("data:")) {
        dataLines.push(line.slice(5).replace(/^ /, ""));
      }
      // `event:` and `id:` are unused by the MCP wire format.
    }
    if (dataLines.length === 0) return;
    const payload = dataLines.join("\n");
    try {
      const parsed = JSON.parse(payload) as JsonRpcMessage;
      this.handlers?.onMessage(parsed);
    } catch {
      // Ignore malformed events.
    }
  }
}
