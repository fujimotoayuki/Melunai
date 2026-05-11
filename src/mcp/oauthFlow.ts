/**
 * OAuth flow runner — orchestrates the full authorization-code-with-PKCE
 * dance for an MCP HTTP server and persists the resulting token.
 *
 *   1. Discover authorization server metadata.
 *   2. Register a public PKCE client (DCR) if the server allows it.
 *   3. Spin up a loopback HTTP listener on a random free port.
 *   4. Open the OS browser at the authorization endpoint.
 *   5. Capture the redirect, verify state, exchange code for tokens.
 *   6. Persist the token via `OAuthTokenStore`.
 *
 * Browser launching is delegated to a host-supplied callback so this module
 * stays independent of Electron — the manager wires it to `shell.openExternal`.
 */

import * as crypto from "crypto";
import * as http from "http";
import {
  buildAuthorizationUrl,
  discoverAuthorizationServer,
  exchangeAuthCode,
  generatePkcePair,
  registerClient,
  type AuthorizationServerMetadata,
  type OAuthTokenStore,
  type StoredOAuthToken,
} from "./oauth.js";

export interface OAuthFlowOptions {
  serverId: string;
  serverName: string;
  /** The MCP HTTP endpoint URL the user is trying to authorize against. */
  resourceUrl: string;
  /** Optional pre-issued client_id (skips dynamic registration). */
  clientId?: string;
  clientSecret?: string;
  /** Optional fixed scope to request. */
  scope?: string;
  /** Token persistence layer. */
  store: OAuthTokenStore;
  /** Opens the OS default browser at the given URL. */
  openBrowser: (url: string) => Promise<void> | void;
  /** Callback timeout, default 5 minutes. */
  timeoutMs?: number;
}

export class OAuthFlowError extends Error {
  constructor(message: string, readonly code: string) {
    super(message);
    this.name = "OAuthFlowError";
  }
}

export async function runOAuthFlow(opts: OAuthFlowOptions): Promise<StoredOAuthToken> {
  const metadata = await discoverAuthorizationServer(opts.resourceUrl);

  // PKCE is required; fall back to S256 if the server didn't advertise.
  const methods = metadata.code_challenge_methods_supported ?? ["S256"];
  if (!methods.includes("S256")) {
    throw new OAuthFlowError(
      "Authorization server does not support PKCE S256.",
      "pkce_unsupported",
    );
  }

  const { server, redirectUri, awaitCallback } = await startLoopbackListener(
    opts.timeoutMs ?? 5 * 60 * 1000,
  );

  let token: StoredOAuthToken;
  try {
    let clientId = opts.clientId;
    let clientSecret = opts.clientSecret;
    if (clientId === undefined) {
      if (metadata.registration_endpoint === undefined) {
        throw new OAuthFlowError(
          "Server requires a client_id and does not support dynamic client registration.",
          "no_client_id",
        );
      }
      const registered = await registerClient(
        metadata.registration_endpoint,
        redirectUri,
        `Melunai (${opts.serverName})`,
      );
      clientId = registered.clientId;
      clientSecret = registered.clientSecret;
    }

    const pkce = generatePkcePair();
    const state = crypto.randomBytes(16).toString("base64url");
    const authUrl = buildAuthorizationUrl({
      metadata,
      clientId,
      redirectUri,
      scope: opts.scope,
      state,
      pkce,
    });

    await opts.openBrowser(authUrl);

    const callback = await awaitCallback;
    // 定数時間比較で state を検証（タイミング攻撃への防御）
    if (!safeStringEqual(callback.state ?? "", state)) {
      throw new OAuthFlowError("OAuth state mismatch.", "state_mismatch");
    }
    if (callback.error !== undefined) {
      throw new OAuthFlowError(
        `Authorization server returned error: ${callback.error}${callback.errorDescription ? " — " + callback.errorDescription : ""}`,
        "auth_error",
      );
    }
    if (callback.code === undefined) {
      throw new OAuthFlowError("Authorization server did not return a code.", "no_code");
    }
    // code は base64url / 一般的に 1024 文字未満。長さで攻撃ペイロード混入を弾く。
    if (callback.code.length > 4096 || !/^[A-Za-z0-9._\-~+/=]+$/.test(callback.code)) {
      throw new OAuthFlowError("Authorization code is malformed.", "bad_code");
    }

    token = await exchangeAuthCode({
      metadata,
      code: callback.code,
      codeVerifier: pkce.verifier,
      clientId,
      clientSecret,
      redirectUri,
    });
  } finally {
    server.close();
  }

  await opts.store.set(opts.serverId, token);
  return token;
}

// ---------------------------------------------------------------------------
// Loopback HTTP listener — listens on a random free port for the redirect
// ---------------------------------------------------------------------------

interface CallbackParams {
  code?: string;
  state?: string;
  error?: string;
  errorDescription?: string;
}

interface LoopbackHandle {
  server: http.Server;
  redirectUri: string;
  awaitCallback: Promise<CallbackParams>;
}

const SUCCESS_PAGE = `<!doctype html>
<html><head><meta charset="utf-8"><title>Authorization complete</title>
<style>
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
         background: #1d1d1f; color: #f5f5f7; display: flex; align-items: center;
         justify-content: center; height: 100vh; margin: 0; }
  .card { background: rgba(255,255,255,0.04); padding: 32px 40px; border-radius: 20px;
          backdrop-filter: blur(12px); }
  h1 { font-size: 18px; margin: 0 0 8px; font-weight: 500; }
  p { font-size: 13px; color: #a1a1a6; margin: 0; }
</style></head><body>
<div class="card">
  <h1>Authorization complete</h1>
  <p>You can close this window and return to Melunai.</p>
</div></body></html>`;

/**
 * 定数時間で文字列を比較する。長さが違う場合も即座に false を返さないことで
 * タイミング攻撃（state / code の盗用試行）を防ぐ。
 */
function safeStringEqual(a: string, b: string): boolean {
  if (typeof a !== "string" || typeof b !== "string") return false;
  // Buffer 化して長さが違っても false を返す前に同じ計算量を経由
  const ba = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  if (ba.length !== bb.length) {
    // ダミー比較で時間を揃える
    crypto.timingSafeEqual(ba, ba);
    return false;
  }
  return crypto.timingSafeEqual(ba, bb);
}

function startLoopbackListener(timeoutMs: number): Promise<LoopbackHandle> {
  return new Promise((resolve, reject) => {
    let resolveCallback!: (value: CallbackParams) => void;
    let rejectCallback!: (reason: Error) => void;
    const awaitCallback = new Promise<CallbackParams>((res, rej) => {
      resolveCallback = res;
      rejectCallback = rej;
    });

    let alreadyHandled = false;

    const server = http.createServer((req, res) => {
      if (req.url === undefined) {
        res.statusCode = 400;
        res.end();
        return;
      }
      // Host ヘッダ検証 — ループバックを指す妥当な host のみ許容（他ループバック表記/別IPからの詐称を遮断）。
      // ブラウザによっては redirect_uri が 127.0.0.1 でも `localhost:port` で送られる場合があるため
      // ホワイトリスト方式で複数表記を受け入れる。
      const port = (server.address() as { port: number } | null)?.port;
      const allowedHosts = port !== undefined
        ? new Set([
            `127.0.0.1:${port}`,
            `localhost:${port}`,
            `[::1]:${port}`,
          ])
        : new Set<string>();
      const actualHost = (req.headers.host ?? "").toLowerCase();
      if (!allowedHosts.has(actualHost)) {
        res.statusCode = 400;
        res.end();
        return;
      }
      const url = new URL(req.url, "http://127.0.0.1");
      if (url.pathname !== "/callback") {
        res.statusCode = 404;
        res.end();
        return;
      }
      // 既に有効な callback を1回受信済みなら以降は 410 でロックダウン。
      // これにより同マシン上の他プロセスがレースで認可コードを上書きする攻撃を防ぐ。
      if (alreadyHandled) {
        res.statusCode = 410;
        res.end();
        return;
      }
      alreadyHandled = true;

      const params: CallbackParams = {
        code: url.searchParams.get("code") ?? undefined,
        state: url.searchParams.get("state") ?? undefined,
        error: url.searchParams.get("error") ?? undefined,
        errorDescription: url.searchParams.get("error_description") ?? undefined,
      };
      res.statusCode = 200;
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      // 多層防御として簡易 CSP（外部スクリプト読込禁止）
      res.setHeader(
        "Content-Security-Policy",
        "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'",
      );
      res.end(SUCCESS_PAGE, () => {
        // レスポンス送信後、即座にリスナーを閉じる（さらなる入力を一切受けない）
        server.close();
      });
      resolveCallback(params);
    });

    const timer = setTimeout(() => {
      rejectCallback(new OAuthFlowError("OAuth callback timed out.", "callback_timeout"));
      try { server.close(); } catch { /* ignore */ }
    }, timeoutMs);

    awaitCallback.finally(() => clearTimeout(timer));

    server.on("error", (err) => {
      clearTimeout(timer);
      rejectCallback(err);
      reject(err);
    });

    // Port 0 → kernel picks a free port. 127.0.0.1 のみで bind し、外部公開を避ける。
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        reject(new Error("Loopback server failed to bind a port."));
        return;
      }
      const redirectUri = `http://127.0.0.1:${address.port}/callback`;
      resolve({ server, redirectUri, awaitCallback });
    });
  });
}
