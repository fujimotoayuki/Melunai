/**
 * OAuth 2.1 helper for MCP HTTP transports.
 *
 * Implements the slice of the MCP authorization spec actually needed for
 * Streamable HTTP servers:
 *
 *   1. Authorization Server discovery
 *      • RFC 9728 Protected Resource Metadata at
 *        `<resource>/.well-known/oauth-protected-resource`
 *      • Falls back to RFC 8414 Authorization Server Metadata at
 *        `<auth-server>/.well-known/oauth-authorization-server`
 *
 *   2. Dynamic Client Registration (RFC 7591) — when the server advertises a
 *      `registration_endpoint`. Otherwise the user supplies a `client_id`.
 *
 *   3. PKCE (RFC 7636, S256) Authorization Code flow with a loopback
 *      redirect URI (`http://127.0.0.1:<random>/callback`).
 *
 *   4. Token storage at `<userData>/mcp-oauth-tokens.json`, keyed by server id.
 *      Refresh tokens are rotated on every refresh.
 *
 *   5. Automatic refresh on 401 / token expiry.
 *
 * Browser launch + redirect capture live in `oauthFlow.ts` so this file
 * stays Node-only and unit-testable.
 */

import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";

/**
 * 任意 URL をネットワークアクセス前にスキーム検証する。
 * OAuth エンドポイントは MITM リスクが高いため、loopback 例外を除き HTTPS を強制する。
 * `MELUNAI_ALLOW_INSECURE_OAUTH=1` を立てた場合のみ http: を許可する（開発専用）。
 */
function assertSecureOAuthUrl(rawUrl: string, label: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error(`OAuth ${label}: invalid URL`);
  }
  const host = parsed.hostname.toLowerCase();
  const isLoopback = host === "127.0.0.1" || host === "localhost" || host === "::1";
  const allowInsecure = process.env["MELUNAI_ALLOW_INSECURE_OAUTH"] === "1";
  if (parsed.protocol === "https:") return parsed;
  if (parsed.protocol === "http:" && (isLoopback || allowInsecure)) return parsed;
  throw new Error(`OAuth ${label}: scheme '${parsed.protocol}' is not allowed (HTTPS required)`);
}

/** OAuth レスポンス本文の最大サイズ（512KB）。エラー本文の異常肥大に備える。 */
const OAUTH_RESPONSE_MAX_BYTES = 512 * 1024;
/** OAuth fetch タイムアウト（30 秒）。長時間ハング防止。 */
const OAUTH_FETCH_TIMEOUT_MS = 30_000;
/** トークン更新時のクロックスキュー（ms）。`expires_at` をその分だけ前倒し。 */
const TOKEN_EXPIRY_SKEW_MS = 60_000;

/**
 * 暗号化レイヤー — Electron の safeStorage が使えるなら OS 鍵束で暗号化する。
 * Electron 以外（テスト等）では平文に fall-back する。
 */
interface SafeStorageLike {
  isEncryptionAvailable(): boolean;
  encryptString(plain: string): Buffer;
  decryptString(encrypted: Buffer): string;
}
let safeStorageRef: SafeStorageLike | null = null;
export function setSafeStorage(impl: SafeStorageLike | null): void {
  safeStorageRef = impl;
}

// ---------------------------------------------------------------------------
// Persisted token shape
// ---------------------------------------------------------------------------

export interface StoredOAuthToken {
  /** Bearer token used in Authorization headers. */
  accessToken: string;
  /** Optional refresh token. */
  refreshToken?: string;
  /** Unix-ms timestamp of expiry. May be absent for non-expiring tokens. */
  expiresAt?: number;
  /** Scope string returned by the server. */
  scope?: string;
  /** Token type (almost always "Bearer"). */
  tokenType: string;
  /** Resolved server metadata, cached so we can refresh without re-discovery. */
  metadata: AuthorizationServerMetadata;
  /** Client id (issued via DCR or supplied by user). */
  clientId: string;
  /** Optional client secret (for confidential clients). */
  clientSecret?: string;
}

export interface AuthorizationServerMetadata {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  registration_endpoint?: string;
  scopes_supported?: string[];
  /** Mirror of `code_challenge_methods_supported` for PKCE. */
  code_challenge_methods_supported?: string[];
}

// ---------------------------------------------------------------------------
// Token store — JSON file in userData/
// ---------------------------------------------------------------------------

export class OAuthTokenStore {
  private cache: Record<string, StoredOAuthToken> | null = null;
  /** 並行 set / clear を直列化し lost-update を防ぐ */
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(private readonly storePath: string) {}

  async get(serverId: string): Promise<StoredOAuthToken | null> {
    await this.ensureLoaded();
    return this.cache?.[serverId] ?? null;
  }

  async set(serverId: string, token: StoredOAuthToken): Promise<void> {
    await this.ensureLoaded();
    if (this.cache === null) this.cache = {};
    this.cache[serverId] = token;
    await this.persist();
  }

  async clear(serverId: string): Promise<void> {
    await this.ensureLoaded();
    if (this.cache === null) return;
    delete this.cache[serverId];
    await this.persist();
  }

  private async ensureLoaded(): Promise<void> {
    if (this.cache !== null) return;
    try {
      const buf = await fs.promises.readFile(this.storePath);
      // ファイル先頭にマジックヘッダを置いて、暗号化済みか平文かを明示的に判別する。
      // これがないと「暗号化失敗→平文 fallback」の罠で過去の暗号化ファイルを誤って
      // 「破損平文」と扱い、JSON.parse 失敗→空 map で上書きしてしまう恐れがある。
      const isEncrypted = buf.length >= TOKEN_ENC_MAGIC.length
        && buf.slice(0, TOKEN_ENC_MAGIC.length).equals(TOKEN_ENC_MAGIC);
      let raw: string;
      if (isEncrypted) {
        if (safeStorageRef === null || !safeStorageRef.isEncryptionAvailable()) {
          // 暗号化済みだが今は復号できない → 起動失敗を避けるため空キャッシュで開始（書き戻すまでファイルは保持）
          // eslint-disable-next-line no-console
          console.warn("[mcp:oauth] token store is encrypted but safeStorage is unavailable; tokens are temporarily inaccessible.");
          this.cache = {};
          return;
        }
        raw = safeStorageRef.decryptString(buf.slice(TOKEN_ENC_MAGIC.length));
      } else {
        // マジックヘッダなし → 旧バージョン互換の平文形式
        raw = buf.toString("utf8");
        if (raw.charCodeAt(0) === 0xfeff) raw = raw.slice(1);
      }
      this.cache = JSON.parse(raw) as Record<string, StoredOAuthToken>;
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code === "ENOENT") {
        this.cache = {};
      } else {
        // 破損ファイルはバックアップしてから空 map にリセット（運用デバッグ容易化）
        try {
          const backup = `${this.storePath}.corrupted-${Date.now()}.bak`;
          await fs.promises.rename(this.storePath, backup);
          // eslint-disable-next-line no-console
          console.warn(`[mcp:oauth] token store unreadable, backed up to ${backup}`);
        } catch {
          /* ignore backup failure */
        }
        this.cache = {};
      }
    }
  }

  private async persist(): Promise<void> {
    // 書き込みを直列化し、tmp + rename で atomic に置換
    const previous = this.writeQueue;
    const next = previous.catch(() => undefined).then(() => this.persistNow());
    this.writeQueue = next.catch(() => undefined);
    await next;
  }

  private async persistNow(): Promise<void> {
    if (this.cache === null) return;
    await fs.promises.mkdir(path.dirname(this.storePath), { recursive: true });
    const json = JSON.stringify(this.cache, null, 2);
    const payload: Buffer =
      safeStorageRef !== null && safeStorageRef.isEncryptionAvailable()
        // マジックヘッダ + 暗号化ペイロード
        ? Buffer.concat([TOKEN_ENC_MAGIC, safeStorageRef.encryptString(json)])
        : Buffer.from(json, "utf8");
    const tmp = `${this.storePath}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`;
    try {
      await fs.promises.writeFile(tmp, payload, { mode: 0o600 });
      await fs.promises.rename(tmp, this.storePath);
    } catch (cause) {
      await fs.promises.unlink(tmp).catch(() => undefined);
      throw cause;
    }
  }
}

/** OAuth token store の暗号化マークヘッダ。先頭に置いて暗号化済みか平文かを判定する。 */
const TOKEN_ENC_MAGIC = Buffer.from("MELUNAI-ENCv1\n", "utf8");

// ---------------------------------------------------------------------------
// Discovery
// ---------------------------------------------------------------------------

/**
 * Resolve authorization server metadata for an MCP HTTP endpoint.
 *
 * Try the resource server's `oauth-protected-resource` document first; if
 * that names an authorization_server, fetch *its* metadata. Fall back to
 * treating the resource URL itself as the AS root.
 */
export async function discoverAuthorizationServer(
  resourceUrl: string,
): Promise<AuthorizationServerMetadata> {
  const resourceOrigin = new URL(resourceUrl).origin;

  // 1. Protected Resource Metadata (RFC 9728)
  try {
    const prm = await fetchJson(
      new URL("/.well-known/oauth-protected-resource", resourceOrigin).toString(),
    );
    const asList = arrayOfStrings(prm["authorization_servers"]);
    if (asList.length > 0) {
      return await fetchAuthServerMetadata(asList[0]!);
    }
  } catch {
    // PRM missing — fine, try AS metadata at the same origin.
  }

  // 2. Authorization Server Metadata (RFC 8414) at the resource origin
  try {
    return await fetchAuthServerMetadata(resourceOrigin);
  } catch {
    // ignore — fall back below
  }

  // 3. OpenID Connect discovery (some servers ship that instead)
  try {
    const oidc = await fetchJson(
      new URL("/.well-known/openid-configuration", resourceOrigin).toString(),
    );
    return normalizeMetadata(oidc, resourceOrigin);
  } catch {
    // ignore
  }

  throw new Error(`Could not discover OAuth metadata for ${resourceUrl}`);
}

async function fetchAuthServerMetadata(
  authServerUrl: string,
): Promise<AuthorizationServerMetadata> {
  const base = authServerUrl.replace(/\/$/, "");
  // HTTPS 強制（discovery URL）
  assertSecureOAuthUrl(base, "discovery URL");
  const candidate = `${base}/.well-known/oauth-authorization-server`;
  const data = await fetchJson(candidate);
  return normalizeMetadata(data, base);
}

function normalizeMetadata(
  raw: Record<string, unknown>,
  fallbackIssuer: string,
): AuthorizationServerMetadata {
  const issuer = stringOr(raw["issuer"], fallbackIssuer);
  const authEndpoint = stringOrThrow(raw["authorization_endpoint"], "authorization_endpoint missing");
  const tokenEndpoint = stringOrThrow(raw["token_endpoint"], "token_endpoint missing");
  // 取得した全エンドポイントの HTTPS を検証（攻撃 AS の混入防止）
  assertSecureOAuthUrl(authEndpoint, "authorization_endpoint");
  assertSecureOAuthUrl(tokenEndpoint, "token_endpoint");
  const registration =
    typeof raw["registration_endpoint"] === "string"
      ? (raw["registration_endpoint"] as string)
      : undefined;
  if (registration !== undefined) {
    assertSecureOAuthUrl(registration, "registration_endpoint");
  }
  return {
    issuer,
    authorization_endpoint: authEndpoint,
    token_endpoint: tokenEndpoint,
    registration_endpoint: registration,
    scopes_supported: arrayOfStrings(raw["scopes_supported"]),
    code_challenge_methods_supported: arrayOfStrings(raw["code_challenge_methods_supported"]),
  };
}

// ---------------------------------------------------------------------------
// Dynamic client registration (RFC 7591)
// ---------------------------------------------------------------------------

export interface DynamicClientRegistrationResult {
  clientId: string;
  clientSecret?: string;
}

export async function registerClient(
  registrationEndpoint: string,
  redirectUri: string,
  clientName: string,
): Promise<DynamicClientRegistrationResult> {
  assertSecureOAuthUrl(registrationEndpoint, "registration_endpoint");
  const response = await timedFetch(registrationEndpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_name: clientName,
      redirect_uris: [redirectUri],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none", // public PKCE client
      application_type: "native",
    }),
  });
  if (!response.ok) {
    throw new Error(`Dynamic client registration failed: ${response.status}`);
  }
  const data = (await readJsonCapped(response)) as Record<string, unknown>;
  const clientId = stringOrThrow(data["client_id"], "client_id missing in registration response");
  return {
    clientId,
    clientSecret:
      typeof data["client_secret"] === "string" ? (data["client_secret"] as string) : undefined,
  };
}

// ---------------------------------------------------------------------------
// PKCE
// ---------------------------------------------------------------------------

export interface PkcePair {
  verifier: string;
  challenge: string;
  method: "S256";
}

export function generatePkcePair(): PkcePair {
  const verifier = crypto.randomBytes(32).toString("base64url");
  const challenge = crypto.createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge, method: "S256" };
}

// ---------------------------------------------------------------------------
// Token exchange + refresh
// ---------------------------------------------------------------------------

export interface ExchangeAuthCodeArgs {
  metadata: AuthorizationServerMetadata;
  code: string;
  codeVerifier: string;
  clientId: string;
  clientSecret?: string;
  redirectUri: string;
}

export async function exchangeAuthCode(args: ExchangeAuthCodeArgs): Promise<StoredOAuthToken> {
  assertSecureOAuthUrl(args.metadata.token_endpoint, "token_endpoint");
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code: args.code,
    redirect_uri: args.redirectUri,
    client_id: args.clientId,
    code_verifier: args.codeVerifier,
  });
  if (args.clientSecret !== undefined) body.set("client_secret", args.clientSecret);

  const response = await timedFetch(args.metadata.token_endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });
  if (!response.ok) {
    throw new Error(`Token exchange failed: ${response.status} ${await safeText(response)}`);
  }
  const data = (await readJsonCapped(response)) as Record<string, unknown>;
  return tokenResponseToStored(data, args.metadata, args.clientId, args.clientSecret);
}

export interface RefreshTokenArgs {
  metadata: AuthorizationServerMetadata;
  refreshToken: string;
  clientId: string;
  clientSecret?: string;
}

export async function refreshAccessToken(args: RefreshTokenArgs): Promise<StoredOAuthToken> {
  assertSecureOAuthUrl(args.metadata.token_endpoint, "token_endpoint");
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: args.refreshToken,
    client_id: args.clientId,
  });
  if (args.clientSecret !== undefined) body.set("client_secret", args.clientSecret);

  const response = await timedFetch(args.metadata.token_endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });
  if (!response.ok) {
    throw new Error(`Token refresh failed: ${response.status} ${await safeText(response)}`);
  }
  const data = (await readJsonCapped(response)) as Record<string, unknown>;
  return tokenResponseToStored(data, args.metadata, args.clientId, args.clientSecret);
}

function tokenResponseToStored(
  data: Record<string, unknown>,
  metadata: AuthorizationServerMetadata,
  clientId: string,
  clientSecret: string | undefined,
): StoredOAuthToken {
  const accessToken = stringOrThrow(data["access_token"], "access_token missing");
  const refreshToken = typeof data["refresh_token"] === "string" ? (data["refresh_token"] as string) : undefined;
  const tokenType = typeof data["token_type"] === "string" ? (data["token_type"] as string) : "Bearer";
  const scope = typeof data["scope"] === "string" ? (data["scope"] as string) : undefined;

  // expires_in は number / string の両方を受け入れる（壊れた IdP 互換）。
  // クロックスキュー分（60秒）を引いて格納し、エッジケースで期限切れトークンを使い続けないようにする。
  const expiresInRaw = data["expires_in"];
  let expiresInSec: number | null = null;
  if (typeof expiresInRaw === "number" && Number.isFinite(expiresInRaw) && expiresInRaw > 0) {
    expiresInSec = expiresInRaw;
  } else if (typeof expiresInRaw === "string") {
    const parsed = Number(expiresInRaw);
    if (Number.isFinite(parsed) && parsed > 0) expiresInSec = parsed;
  }
  const expiresAt =
    expiresInSec !== null
      ? Date.now() + expiresInSec * 1_000 - TOKEN_EXPIRY_SKEW_MS
      : undefined;
  return {
    accessToken,
    refreshToken,
    tokenType,
    scope,
    expiresAt,
    metadata,
    clientId,
    clientSecret,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function fetchJson(url: string): Promise<Record<string, unknown>> {
  // discovery 系は GET。HTTPS 強制 + タイムアウト + サイズ上限。
  assertSecureOAuthUrl(url, "discovery URL");
  const response = await timedFetch(url, {
    headers: { Accept: "application/json" },
  });
  if (!response.ok) throw new Error(`fetch ${url} returned ${response.status}`);
  return (await readJsonCapped(response)) as Record<string, unknown>;
}

/** タイムアウト＋manual redirect のラッパー fetch。すべての OAuth エンドポイントで使用。 */
async function timedFetch(url: string, init: RequestInit): Promise<Response> {
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), OAUTH_FETCH_TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: abort.signal, redirect: "manual" });
  } finally {
    clearTimeout(timer);
  }
}

/** JSON 本文をサイズ上限付きで読む（巨大レスポンスによる OOM 防止）。 */
async function readJsonCapped(response: Response): Promise<unknown> {
  if (response.body === null) return {};
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const chunks: string[] = [];
  let total = 0;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > OAUTH_RESPONSE_MAX_BYTES) {
      await reader.cancel("response too large").catch(() => undefined);
      throw new Error("OAuth response exceeded size cap");
    }
    chunks.push(decoder.decode(value, { stream: true }));
  }
  chunks.push(decoder.decode());
  return JSON.parse(chunks.join(""));
}

async function safeText(response: Response): Promise<string> {
  try {
    const text = await response.text();
    // 機密情報リスクを考慮し 256 文字で truncate する
    return text.length > 256 ? `${text.slice(0, 256)}…` : text;
  } catch {
    return "";
  }
}

function stringOr(value: unknown, fallback: string): string {
  return typeof value === "string" && value.length > 0 ? value : fallback;
}

function stringOrThrow(value: unknown, message: string): string {
  if (typeof value !== "string" || value.length === 0) throw new Error(message);
  return value;
}

function arrayOfStrings(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((v): v is string => typeof v === "string");
}

/**
 * Build the standard authorization-code URL with PKCE params attached.
 */
export function buildAuthorizationUrl(args: {
  metadata: AuthorizationServerMetadata;
  clientId: string;
  redirectUri: string;
  scope?: string;
  state: string;
  pkce: PkcePair;
}): string {
  const url = new URL(args.metadata.authorization_endpoint);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", args.clientId);
  url.searchParams.set("redirect_uri", args.redirectUri);
  url.searchParams.set("state", args.state);
  url.searchParams.set("code_challenge", args.pkce.challenge);
  url.searchParams.set("code_challenge_method", args.pkce.method);
  if (args.scope !== undefined && args.scope.length > 0) {
    url.searchParams.set("scope", args.scope);
  }
  return url.toString();
}
