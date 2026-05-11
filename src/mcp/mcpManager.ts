/**
 * McpManager — owns the lifecycle of every configured MCP server connection
 * and pumps server-originated events to the renderer.
 *
 * Lives in the Electron main process. Persists server configurations to
 * `<userData>/mcp-servers.json`, spawns/stops `McpClient` instances, and
 * exposes a flat API the IPC layer can call directly.
 */

import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";
import { McpClient } from "./mcpClient.js";
import { StdioTransport } from "./stdioTransport.js";
import { StreamableHttpTransport, type HttpAuthProvider } from "./httpTransport.js";
import { OllamaSamplingBridge } from "./samplingBridge.js";
import { OAuthTokenStore, refreshAccessToken } from "./oauth.js";
import { runOAuthFlow } from "./oauthFlow.js";
import type { McpTransport } from "./mcpTransport.js";
import type {
  McpCompletionRef,
  McpCompletionResult,
  McpLogLevel,
  McpPromptGetResult,
  McpRendererEvent,
  McpResourceReadResult,
  McpRoot,
  McpSamplingRequestParams,
  McpSamplingResult,
  McpServerConfig,
  McpServerStatus,
  McpToolCallResult,
} from "./mcpTypes.js";

interface ServerEntry {
  config: McpServerConfig;
  client: McpClient | null;
  transport: McpTransport | null;
  lastError: string | null;
  /**
   * 設定ファイルから読み込んだ時点での transport フィンガープリント。
   * 自動接続時にこれが現在の config と一致するか検証することで、
   * 設定ファイル汚染（disk 上で command を書き換える攻撃）を検知する。
   */
  fingerprint: string;
}

/**
 * MCP サーバ設定の transport から、command/args/url を含む正規化フィンガープリントを作る。
 * 自動接続前にユーザー承認時の値と一致するか検証するために使う。
 */
function transportFingerprint(config: McpServerConfig): string {
  const tr = config.transport;
  if (tr.kind === "stdio") {
    return crypto
      .createHash("sha256")
      .update(JSON.stringify({ kind: "stdio", command: tr.command, args: tr.args ?? [] }))
      .digest("hex");
  }
  return crypto
    .createHash("sha256")
    .update(JSON.stringify({ kind: "http", url: tr.url }))
    .digest("hex");
}

export type McpEventListener = (event: McpRendererEvent) => void;

export interface McpManagerOptions {
  /** Function used to launch the OS browser during OAuth (e.g. shell.openExternal). */
  openBrowser?: (url: string) => Promise<void> | void;
}

export class McpManager {
  private configPath: string;
  private tokenStore: OAuthTokenStore;
  private openBrowser: ((url: string) => Promise<void> | void) | null;
  private servers = new Map<string, ServerEntry>();
  private loaded = false;
  private listeners = new Set<McpEventListener>();
  /** Local LLM bridge that fulfills sampling requests when no veto arrives. */
  private samplingBridge: OllamaSamplingBridge | null = null;
  /**
   * Behaviour for server-initiated sampling requests:
   *   • "auto"        — fulfilled by the local Ollama bridge with no UI prompt.
   *   • "ask"         — emit `sampling_request` to renderer, fall back to the
   *                     bridge after `samplingPromptGraceMs` if no answer.
   *   • "never"       — always reject with "host declined sampling".
   */
  private samplingPolicy: "auto" | "ask" | "never" = "ask";
  private samplingPromptGraceMs = 30_000;
  /** In-flight server-initiated sampling requests awaiting a renderer answer. */
  private samplingPending = new Map<
    string,
    {
      resolve: (value: McpSamplingResult | null) => void;
      reject: (reason: Error) => void;
      timer: NodeJS.Timeout;
      params: McpSamplingRequestParams;
    }
  >();

  constructor(userDataDir: string, options: McpManagerOptions = {}) {
    this.configPath = path.join(userDataDir, "mcp-servers.json");
    this.tokenStore = new OAuthTokenStore(path.join(userDataDir, "mcp-oauth-tokens.json"));
    this.openBrowser = options.openBrowser ?? null;
  }

  // -------------------------------------------------------------------------
  // Event subscription (used by IPC layer to forward to renderer)
  // -------------------------------------------------------------------------

  subscribe(listener: McpEventListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(event: McpRendererEvent): void {
    for (const listener of this.listeners) listener(event);
  }

  // -------------------------------------------------------------------------
  // Persistence
  // -------------------------------------------------------------------------

  private async load(): Promise<void> {
    if (this.loaded) return;
    this.loaded = true;
    try {
      let raw = await fs.promises.readFile(this.configPath, "utf8");
      if (raw.charCodeAt(0) === 0xfeff) raw = raw.slice(1); // BOM
      const parsed = JSON.parse(raw) as {
        servers?: McpServerConfig[];
        fingerprints?: Record<string, string>;
      };
      const list = Array.isArray(parsed.servers) ? parsed.servers : [];
      const fingerprints = parsed.fingerprints ?? {};
      for (const cfg of list) {
        if (typeof cfg.id !== "string" || cfg.transport === undefined) continue;
        const currentFp = transportFingerprint(cfg);
        const expected = fingerprints[cfg.id];
        // 期待 fingerprint が無い、または一致しない場合は disable + lastError でユーザーに再承認を促す。
        // これにより disk 上の改ざん（cmd.exe へのすり替え等）を起動時に検知できる。
        let lastError: string | null = null;
        let safeConfig = cfg;
        if (expected === undefined) {
          // 旧フォーマット互換 — fingerprint を初期化（ユーザー操作を介さないので enabled を維持しつつ保存）
        } else if (expected !== currentFp) {
          safeConfig = { ...cfg, enabled: false };
          lastError =
            "設定ファイルが外部から変更された可能性があります。MCPパネルで内容を確認し、再度有効化してください。";
        }
        this.servers.set(cfg.id, {
          config: safeConfig,
          client: null,
          transport: null,
          lastError,
          fingerprint: transportFingerprint(safeConfig),
        });
      }
      // fingerprint が無かったエントリの初期化を反映保存（書き込みエラーは無視）
      if (parsed.fingerprints === undefined) {
        await this.persist().catch(() => undefined);
      }
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code !== "ENOENT") {
        // eslint-disable-next-line no-console
        console.warn("[mcp] failed to load config:", cause);
      }
    }
  }

  /**
   * persist は atomic write + fingerprint 同梱で保存する。
   * 同時書き込みは writeQueue で直列化。
   */
  private writeQueue: Promise<void> = Promise.resolve();
  private async persist(): Promise<void> {
    const previous = this.writeQueue;
    const next = previous.catch(() => undefined).then(() => this.persistNow());
    this.writeQueue = next.catch(() => undefined);
    await next;
  }
  private async persistNow(): Promise<void> {
    const fingerprints: Record<string, string> = {};
    for (const entry of this.servers.values()) {
      fingerprints[entry.config.id] = entry.fingerprint;
    }
    const payload = {
      servers: Array.from(this.servers.values()).map((entry) => entry.config),
      fingerprints,
    };
    await fs.promises.mkdir(path.dirname(this.configPath), { recursive: true });
    const tmp = `${this.configPath}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`;
    try {
      await fs.promises.writeFile(tmp, JSON.stringify(payload, null, 2), {
        encoding: "utf8",
        mode: 0o600,
      });
      await fs.promises.rename(tmp, this.configPath);
    } catch (cause) {
      await fs.promises.unlink(tmp).catch(() => undefined);
      throw cause;
    }
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  /** Register the local LLM bridge used to fulfill sampling requests. */
  setSamplingBridge(bridge: OllamaSamplingBridge | null): void {
    this.samplingBridge = bridge;
  }

  setSamplingPolicy(policy: "auto" | "ask" | "never", graceMs?: number): void {
    this.samplingPolicy = policy;
    if (typeof graceMs === "number" && graceMs > 0) {
      this.samplingPromptGraceMs = graceMs;
    }
  }

  /**
   * Renderer-supplied result for a previously-emitted sampling_request.
   * If `result` is `null`, the request is declined and the server gets an error.
   */
  resolveSamplingRequest(requestId: string, result: McpSamplingResult | null): void {
    const pending = this.samplingPending.get(requestId);
    if (pending === undefined) return;
    this.samplingPending.delete(requestId);
    clearTimeout(pending.timer);
    if (result === null) {
      pending.reject(new Error("sampling declined by host"));
    } else {
      pending.resolve(result);
    }
  }

  rejectSamplingRequest(requestId: string, reason: string): void {
    const pending = this.samplingPending.get(requestId);
    if (pending === undefined) return;
    this.samplingPending.delete(requestId);
    clearTimeout(pending.timer);
    pending.reject(new Error(reason));
  }

  /**
   * Core sampling dispatcher — invoked by every connected client whenever a
   * server issues `sampling/createMessage`. Honors the configured policy.
   */
  private async handleSamplingRequest(
    serverId: string,
    params: McpSamplingRequestParams,
  ): Promise<McpSamplingResult | null> {
    if (this.samplingPolicy === "never") return null;

    if (this.samplingPolicy === "auto") {
      if (this.samplingBridge === null) return null;
      return this.samplingBridge.fulfill(params);
    }

    // policy === "ask"
    // ユーザー応答が無い場合は「拒否」で fail-close する。
    // 以前はタイムアウト後に Ollama bridge が自動応答してしまい、
    // 不在時の prompt-injection に対して human-in-the-loop が崩れていた。
    const requestId = `sampling-${Date.now()}-${crypto.randomBytes(4).toString("hex")}`;
    const rendererPromise = new Promise<McpSamplingResult | null>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.samplingPending.delete(requestId);
        // null を返すと spec 上は「リクエスト拒否」として MCP server に返る
        resolve(null);
      }, this.samplingPromptGraceMs);
      this.samplingPending.set(requestId, {
        resolve,
        reject,
        timer,
        params,
      });
    });

    this.emit({ type: "sampling_request", serverId, requestId, params });
    return rendererPromise;
  }

  async listServers(): Promise<McpServerStatus[]> {
    await this.load();
    return Array.from(this.servers.values()).map((entry) => this.snapshot(entry));
  }

  async addServer(input: Omit<McpServerConfig, "id">): Promise<McpServerStatus> {
    await this.load();
    const id = `mcp-${Date.now()}-${crypto.randomBytes(4).toString("hex")}`;
    const config: McpServerConfig = {
      id,
      name: input.name.trim().length > 0 ? input.name.trim() : "Unnamed MCP server",
      transport: input.transport,
      enabled: input.enabled !== false,
      roots: input.roots ?? [],
    };
    const entry: ServerEntry = {
      config,
      client: null,
      transport: null,
      lastError: null,
      fingerprint: transportFingerprint(config),
    };
    this.servers.set(id, entry);
    await this.persist();
    return this.snapshot(entry);
  }

  async updateServer(
    id: string,
    patch: Partial<Omit<McpServerConfig, "id">>,
  ): Promise<McpServerStatus | null> {
    await this.load();
    const entry = this.servers.get(id);
    if (entry === undefined) return null;

    if (entry.client !== null) {
      await entry.client.stop();
      entry.client = null;
      entry.transport = null;
    }

    entry.config = {
      ...entry.config,
      ...patch,
      id: entry.config.id,
      transport: patch.transport ?? entry.config.transport,
      roots: patch.roots ?? entry.config.roots,
    };
    // ユーザー承認を伴った変更なので fingerprint を更新
    entry.fingerprint = transportFingerprint(entry.config);
    entry.lastError = null;
    await this.persist();
    return this.snapshot(entry);
  }

  async removeServer(id: string): Promise<boolean> {
    await this.load();
    const entry = this.servers.get(id);
    if (entry === undefined) return false;
    if (entry.client !== null) await entry.client.stop();
    this.servers.delete(id);
    await this.persist();
    return true;
  }

  async connectServer(id: string): Promise<McpServerStatus | null> {
    await this.load();
    const entry = this.servers.get(id);
    if (entry === undefined) return null;
    if (entry.client !== null && entry.client.isRunning()) {
      return this.snapshot(entry);
    }

    const transport = this.buildTransport(entry.config);
    const client = new McpClient(transport, entry.config.id);
    entry.transport = transport;
    entry.client = client;
    entry.lastError = null;

    try {
      await client.start({
        getRoots: () => entry.config.roots ?? [],
        onStderr: (line) => this.emit({ type: "stderr", serverId: id, line }),
        onLog: (message) => this.emit({ type: "log", serverId: id, message }),
        onProgress: (update) => this.emit({ type: "progress", serverId: id, update }),
        onResourceUpdated: (uri) =>
          this.emit({ type: "resource_updated", serverId: id, uri }),
        onToolsListChanged: () => {
          this.emit({ type: "tools_list_changed", serverId: id });
          this.emit({ type: "status", status: this.snapshot(entry) });
        },
        onResourcesListChanged: () => {
          this.emit({ type: "resources_list_changed", serverId: id });
          this.emit({ type: "status", status: this.snapshot(entry) });
        },
        onPromptsListChanged: () => {
          this.emit({ type: "prompts_list_changed", serverId: id });
          this.emit({ type: "status", status: this.snapshot(entry) });
        },
        onClose: (reason) => {
          if (entry.client === client) {
            entry.client = null;
            entry.transport = null;
            if (reason !== null && reason !== "closed by client" && reason !== "client stopped") {
              entry.lastError = reason;
            }
            this.emit({ type: "status", status: this.snapshot(entry) });
          }
        },
        onError: (err) => {
          entry.lastError = err.message;
        },
        onSamplingRequest: (serverId, params) => this.handleSamplingRequest(serverId, params),
      });
      this.emit({ type: "status", status: this.snapshot(entry) });
    } catch (cause) {
      entry.client = null;
      entry.transport = null;
      entry.lastError = cause instanceof Error ? cause.message : String(cause);
      this.emit({ type: "status", status: this.snapshot(entry) });
    }

    return this.snapshot(entry);
  }

  async disconnectServer(id: string): Promise<McpServerStatus | null> {
    await this.load();
    const entry = this.servers.get(id);
    if (entry === undefined) return null;
    if (entry.client !== null) {
      await entry.client.stop();
      entry.client = null;
      entry.transport = null;
    }
    this.emit({ type: "status", status: this.snapshot(entry) });
    return this.snapshot(entry);
  }

  // ---- Tool / Resource / Prompt operations -------------------------------

  async callTool(serverId: string, toolName: string, args: unknown): Promise<McpToolCallResult> {
    const client = this.requireClient(serverId);
    if (client === null) return { ok: false, error: "MCP server is not connected." };
    return client.callTool(toolName, args);
  }

  async readResource(serverId: string, uri: string): Promise<McpResourceReadResult> {
    const client = this.requireClient(serverId);
    if (client === null) return { ok: false, error: "MCP server is not connected." };
    return client.readResource(uri);
  }

  async subscribeResource(serverId: string, uri: string): Promise<boolean> {
    const client = this.requireClient(serverId);
    if (client === null) return false;
    const ok = await client.subscribeResource(uri);
    const entry = this.servers.get(serverId);
    if (entry !== undefined) {
      this.emit({ type: "status", status: this.snapshot(entry) });
    }
    return ok;
  }

  async unsubscribeResource(serverId: string, uri: string): Promise<boolean> {
    const client = this.requireClient(serverId);
    if (client === null) return false;
    const ok = await client.unsubscribeResource(uri);
    const entry = this.servers.get(serverId);
    if (entry !== undefined) {
      this.emit({ type: "status", status: this.snapshot(entry) });
    }
    return ok;
  }

  async getPrompt(
    serverId: string,
    name: string,
    args?: Record<string, string>,
  ): Promise<McpPromptGetResult> {
    const client = this.requireClient(serverId);
    if (client === null) return { ok: false, error: "MCP server is not connected." };
    return client.getPrompt(name, args);
  }

  async setLogLevel(serverId: string, level: McpLogLevel): Promise<boolean> {
    const client = this.requireClient(serverId);
    if (client === null) return false;
    return client.setLogLevel(level);
  }

  async ping(serverId: string): Promise<boolean> {
    const client = this.requireClient(serverId);
    if (client === null) return false;
    return client.ping();
  }

  async complete(
    serverId: string,
    ref: McpCompletionRef,
    argument: { name: string; value: string },
  ): Promise<McpCompletionResult> {
    const client = this.requireClient(serverId);
    if (client === null) return { ok: false, error: "MCP server is not connected." };
    return client.complete(ref, argument);
  }

  async refreshAll(serverId: string): Promise<McpServerStatus | null> {
    const client = this.requireClient(serverId);
    if (client === null) return null;
    await Promise.all([
      client.refreshTools().catch(() => undefined),
      client.refreshResources().catch(() => undefined),
      client.refreshResourceTemplates().catch(() => undefined),
      client.refreshPrompts().catch(() => undefined),
    ]);
    const entry = this.servers.get(serverId);
    if (entry === undefined) return null;
    this.emit({ type: "status", status: this.snapshot(entry) });
    return this.snapshot(entry);
  }

  async setRoots(serverId: string, roots: McpRoot[]): Promise<McpServerStatus | null> {
    const entry = this.servers.get(serverId);
    if (entry === undefined) return null;
    entry.config.roots = roots;
    await this.persist();
    if (entry.client !== null) {
      entry.client.notifyRootsChanged();
    }
    this.emit({ type: "status", status: this.snapshot(entry) });
    return this.snapshot(entry);
  }

  /** Stop every connected client. Call from app `before-quit`. */
  async shutdownAll(): Promise<void> {
    // 未応答の sampling リクエストをクリーンアップ（タイマー解放＋拒否で resolve）
    for (const pending of this.samplingPending.values()) {
      clearTimeout(pending.timer);
      try { pending.resolve(null); } catch { /* ignore */ }
    }
    this.samplingPending.clear();

    // 各サーバ停止に 5 秒タイムアウト + allSettled で 1 つの失敗が他をブロックしないように
    const tasks: Promise<unknown>[] = [];
    for (const entry of this.servers.values()) {
      if (entry.client !== null) {
        const client = entry.client;
        entry.client = null;
        entry.transport = null;
        tasks.push(
          Promise.race([
            client.stop(),
            new Promise<void>((resolve) => setTimeout(resolve, 5000)),
          ]).catch(() => undefined),
        );
      }
    }
    await Promise.allSettled(tasks);
  }

  /** Auto-connect every server marked enabled. Errors are stored, not thrown. */
  async autoConnectEnabled(): Promise<void> {
    await this.load();
    const tasks: Promise<unknown>[] = [];
    for (const entry of this.servers.values()) {
      if (entry.config.enabled && entry.client === null) {
        tasks.push(this.connectServer(entry.config.id));
      }
    }
    await Promise.all(tasks);
  }

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  private buildTransport(config: McpServerConfig): McpTransport {
    switch (config.transport.kind) {
      case "stdio":
        return new StdioTransport({
          command: config.transport.command,
          args: config.transport.args,
          env: config.transport.env,
          cwd: config.transport.cwd,
        });
      case "http":
        return new StreamableHttpTransport({
          url: config.transport.url,
          headers: config.transport.headers,
          auth: this.buildAuthProvider(config.id, config.transport.url),
        });
      default: {
        const _exhaustive: never = config.transport;
        throw new Error(`Unsupported MCP transport: ${JSON.stringify(_exhaustive)}`);
      }
    }
  }

  /**
   * Auth provider backed by `OAuthTokenStore`. Refreshes via the stored
   * `refresh_token` when 401 hits; on terminal failure emits a status update
   * containing the auth error so the UI can prompt for re-authorization.
   */
  private buildAuthProvider(serverId: string, resourceUrl: string): HttpAuthProvider {
    return {
      getAccessToken: async () => {
        const token = await this.tokenStore.get(serverId);
        if (token === null) return null;
        if (token.expiresAt !== undefined && token.expiresAt - Date.now() < 30_000) {
          // Token expires soon (or already expired). Try refresh proactively.
          if (token.refreshToken === undefined) return null;
          try {
            const refreshed = await refreshAccessToken({
              metadata: token.metadata,
              refreshToken: token.refreshToken,
              clientId: token.clientId,
              clientSecret: token.clientSecret,
            });
            await this.tokenStore.set(serverId, refreshed);
            return refreshed.accessToken;
          } catch {
            return null;
          }
        }
        return token.accessToken;
      },
      refresh: async () => {
        const token = await this.tokenStore.get(serverId);
        if (token === null || token.refreshToken === undefined) return false;
        try {
          const refreshed = await refreshAccessToken({
            metadata: token.metadata,
            refreshToken: token.refreshToken,
            clientId: token.clientId,
            clientSecret: token.clientSecret,
          });
          await this.tokenStore.set(serverId, refreshed);
          return true;
        } catch {
          return false;
        }
      },
      onAuthRequired: () => {
        const entry = this.servers.get(serverId);
        if (entry === undefined) return;
        entry.lastError = `Authorization required for ${resourceUrl}. Run mcpAuthorize.`;
        this.emit({ type: "status", status: this.snapshot(entry) });
      },
    };
  }

  /**
   * Run the full OAuth 2.1 PKCE flow for an HTTP server, persisting the
   * resulting token. The caller (renderer via IPC) typically follows up
   * with `connectServer` once authorization completes.
   */
  async authorizeServer(
    serverId: string,
    options: { scope?: string; clientId?: string; clientSecret?: string } = {},
  ): Promise<{ ok: true } | { ok: false; error: string }> {
    await this.load();
    const entry = this.servers.get(serverId);
    if (entry === undefined) return { ok: false, error: "unknown server" };
    if (entry.config.transport.kind !== "http") {
      return { ok: false, error: "OAuth only applies to HTTP transports." };
    }
    if (this.openBrowser === null) {
      return { ok: false, error: "Browser launcher not configured." };
    }
    try {
      await runOAuthFlow({
        serverId,
        serverName: entry.config.name,
        resourceUrl: entry.config.transport.url,
        scope: options.scope,
        clientId: options.clientId,
        clientSecret: options.clientSecret,
        store: this.tokenStore,
        openBrowser: this.openBrowser,
      });
      entry.lastError = null;
      this.emit({ type: "status", status: this.snapshot(entry) });
      return { ok: true };
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      entry.lastError = message;
      this.emit({ type: "status", status: this.snapshot(entry) });
      return { ok: false, error: message };
    }
  }

  /** Discard stored OAuth tokens for a server. */
  async clearAuthorization(serverId: string): Promise<void> {
    await this.tokenStore.clear(serverId);
    const entry = this.servers.get(serverId);
    if (entry !== undefined) this.emit({ type: "status", status: this.snapshot(entry) });
  }

  private requireClient(serverId: string): McpClient | null {
    const entry = this.servers.get(serverId);
    if (entry === undefined) return null;
    if (entry.client === null || !entry.client.isRunning()) return null;
    return entry.client;
  }

  private snapshot(entry: ServerEntry): McpServerStatus {
    const connected = entry.client !== null && entry.client.isRunning();
    const client = entry.client;
    return {
      id: entry.config.id,
      name: entry.config.name,
      connected,
      error: entry.lastError ?? undefined,
      serverInfo: connected && client !== null ? client.getServerInfo() ?? undefined : undefined,
      capabilities: connected && client !== null ? client.getCapabilities() ?? undefined : undefined,
      protocolVersion: connected && client !== null
        ? client.getProtocolVersion() ?? undefined
        : undefined,
      tools: connected && client !== null ? client.getTools() : [],
      resources: connected && client !== null ? client.getResources() : [],
      resourceTemplates: connected && client !== null ? client.getResourceTemplates() : [],
      prompts: connected && client !== null ? client.getPrompts() : [],
      subscriptions: connected && client !== null ? client.getSubscriptions() : [],
    };
  }
}
