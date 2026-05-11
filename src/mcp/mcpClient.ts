/**
 * McpClient — full MCP protocol client (transport-agnostic).
 *
 * Implements the 2024-11-05 protocol revision plus the 2025 Streamable HTTP
 * transport. Covers:
 *   • Lifecycle    — initialize / initialized notification / ping / shutdown
 *   • Tools        — list, call, list_changed
 *   • Resources    — list, read, templates, subscribe / unsubscribe, updated
 *   • Prompts      — list, get
 *   • Logging      — setLevel + notifications/message
 *   • Roots        — server can query the host for workspace roots
 *   • Sampling     — server can ask the host's LLM for a completion
 *   • Cancellation — bidirectional notifications/cancelled
 *   • Progress     — notifications/progress (forwarded to host)
 *
 * The client itself is fully reactive — it dispatches inbound notifications
 * through callbacks instead of buffering them, so the manager can forward
 * them to the renderer in real time.
 */

import type { McpTransport } from "./mcpTransport.js";
import {
  type JsonRpcError,
  type JsonRpcId,
  type JsonRpcMessage,
  type JsonRpcRequest,
  type JsonRpcResponse,
  type McpClientCapabilities,
  type McpCompletionRef,
  type McpCompletionResult,
  type McpImplementationInfo,
  type McpLogLevel,
  type McpLogMessage,
  type McpProgressUpdate,
  type McpPromptDescriptor,
  type McpPromptGetResult,
  type McpPromptMessage,
  type McpResourceContents,
  type McpResourceDescriptor,
  type McpResourceReadResult,
  type McpResourceTemplate,
  type McpRoot,
  type McpSamplingHandler,
  type McpSamplingRequestParams,
  type McpServerCapabilities,
  type McpToolCallResult,
  type McpToolDescriptor,
  RPC_ERROR_INTERNAL,
  RPC_ERROR_METHOD_NOT_FOUND,
} from "./mcpTypes.js";

const PROTOCOL_VERSION = "2024-11-05";
const REQUEST_TIMEOUT_MS = 30_000;

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
  timer: NodeJS.Timeout;
  method: string;
}

export interface McpClientHandlers {
  onLog?: (msg: McpLogMessage) => void;
  onProgress?: (update: McpProgressUpdate) => void;
  onResourceUpdated?: (uri: string) => void;
  onToolsListChanged?: () => void;
  onResourcesListChanged?: () => void;
  onPromptsListChanged?: () => void;
  onClose?: (reason: string | null) => void;
  onError?: (err: Error) => void;
  onStderr?: (line: string) => void;
  /** Returns the workspace roots the host advertises to this server. */
  getRoots?: () => McpRoot[];
  /** Fulfills server-initiated `sampling/createMessage` requests. */
  onSamplingRequest?: McpSamplingHandler;
}

export class McpClient {
  private nextId = 1;
  private pending = new Map<JsonRpcId, PendingRequest>();
  private serverInfo: McpImplementationInfo | null = null;
  private serverCapabilities: McpServerCapabilities | null = null;
  private negotiatedProtocolVersion: string | null = null;
  private handlers: McpClientHandlers = {};
  private started = false;

  // Cached server-state — refreshed lazily by the manager.
  private tools: McpToolDescriptor[] = [];
  private resources: McpResourceDescriptor[] = [];
  private resourceTemplates: McpResourceTemplate[] = [];
  private prompts: McpPromptDescriptor[] = [];
  private subscriptions = new Set<string>();

  constructor(
    private readonly transport: McpTransport,
    private readonly serverId: string,
  ) {}

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  async start(handlers: McpClientHandlers): Promise<void> {
    if (this.started) throw new Error("McpClient already started");
    this.started = true;
    this.handlers = handlers;

    await this.transport.start({
      onMessage: (msg) => this.handleMessage(msg),
      onClose: (reason) => {
        this.failAllPending(new Error(reason ?? "transport closed"));
        this.started = false;
        handlers.onClose?.(reason);
      },
      onError: (err) => handlers.onError?.(err),
      onStderr: (line) => handlers.onStderr?.(line),
    });

    const clientCapabilities: McpClientCapabilities = {
      roots: { listChanged: true },
    };
    if (handlers.onSamplingRequest !== undefined) {
      clientCapabilities.sampling = {};
    }

    const initResult = await this.request<{
      protocolVersion?: string;
      serverInfo?: McpImplementationInfo;
      capabilities?: McpServerCapabilities;
    }>("initialize", {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: clientCapabilities,
      clientInfo: { name: "melunai", version: "0.1.0" },
    });

    this.serverInfo = initResult.serverInfo ?? null;
    this.serverCapabilities = initResult.capabilities ?? null;
    this.negotiatedProtocolVersion = initResult.protocolVersion ?? PROTOCOL_VERSION;

    this.notify("notifications/initialized", {});

    // Refresh caches up front so the manager has something to surface.
    await Promise.all([
      this.refreshTools().catch(() => undefined),
      this.refreshResources().catch(() => undefined),
      this.refreshResourceTemplates().catch(() => undefined),
      this.refreshPrompts().catch(() => undefined),
    ]);
  }

  async stop(): Promise<void> {
    this.failAllPending(new Error("client stopped"));
    this.started = false;
    await this.transport.close();
  }

  isRunning(): boolean {
    return this.started && this.transport.isOpen();
  }

  // -------------------------------------------------------------------------
  // Snapshot accessors
  // -------------------------------------------------------------------------

  getServerInfo(): McpImplementationInfo | null {
    return this.serverInfo;
  }

  getCapabilities(): McpServerCapabilities | null {
    return this.serverCapabilities;
  }

  getProtocolVersion(): string | null {
    return this.negotiatedProtocolVersion;
  }

  getTools(): McpToolDescriptor[] {
    return [...this.tools];
  }

  getResources(): McpResourceDescriptor[] {
    return [...this.resources];
  }

  getResourceTemplates(): McpResourceTemplate[] {
    return [...this.resourceTemplates];
  }

  getPrompts(): McpPromptDescriptor[] {
    return [...this.prompts];
  }

  getSubscriptions(): string[] {
    return [...this.subscriptions];
  }

  // -------------------------------------------------------------------------
  // High-level operations
  // -------------------------------------------------------------------------

  async ping(): Promise<boolean> {
    try {
      await this.request("ping", {});
      return true;
    } catch {
      return false;
    }
  }

  async refreshTools(): Promise<McpToolDescriptor[]> {
    if (this.serverCapabilities?.tools === undefined) {
      this.tools = [];
      return [];
    }
    this.tools = await this.fetchAllPaginated<McpToolDescriptor>(
      "tools/list",
      (page) => (Array.isArray(page.tools) ? (page.tools as McpToolDescriptor[]) : []),
    );
    return [...this.tools];
  }

  async callTool(name: string, args: unknown): Promise<McpToolCallResult> {
    try {
      const result = await this.request<{
        content?: McpToolCallResult["content"];
        isError?: boolean;
      }>("tools/call", { name, arguments: args ?? {} });
      return {
        ok: true,
        content: result.content,
        isError: result.isError === true,
      };
    } catch (cause) {
      return {
        ok: false,
        error: cause instanceof Error ? cause.message : String(cause),
      };
    }
  }

  async refreshResources(): Promise<McpResourceDescriptor[]> {
    if (this.serverCapabilities?.resources === undefined) {
      this.resources = [];
      return [];
    }
    this.resources = await this.fetchAllPaginated<McpResourceDescriptor>(
      "resources/list",
      (page) =>
        Array.isArray(page.resources) ? (page.resources as McpResourceDescriptor[]) : [],
    );
    return [...this.resources];
  }

  async refreshResourceTemplates(): Promise<McpResourceTemplate[]> {
    if (this.serverCapabilities?.resources === undefined) {
      this.resourceTemplates = [];
      return [];
    }
    try {
      this.resourceTemplates = await this.fetchAllPaginated<McpResourceTemplate>(
        "resources/templates/list",
        (page) =>
          Array.isArray(page.resourceTemplates)
            ? (page.resourceTemplates as McpResourceTemplate[])
            : [],
      );
    } catch {
      // Templates are optional even when resources is supported.
      this.resourceTemplates = [];
    }
    return [...this.resourceTemplates];
  }

  async readResource(uri: string): Promise<McpResourceReadResult> {
    try {
      const result = await this.request<{ contents?: McpResourceContents[] }>(
        "resources/read",
        { uri },
      );
      return { ok: true, contents: result.contents ?? [] };
    } catch (cause) {
      return {
        ok: false,
        error: cause instanceof Error ? cause.message : String(cause),
      };
    }
  }

  async subscribeResource(uri: string): Promise<boolean> {
    if (this.serverCapabilities?.resources?.subscribe !== true) return false;
    try {
      await this.request("resources/subscribe", { uri });
      this.subscriptions.add(uri);
      return true;
    } catch {
      return false;
    }
  }

  async unsubscribeResource(uri: string): Promise<boolean> {
    if (this.serverCapabilities?.resources?.subscribe !== true) return false;
    try {
      await this.request("resources/unsubscribe", { uri });
      this.subscriptions.delete(uri);
      return true;
    } catch {
      return false;
    }
  }

  async refreshPrompts(): Promise<McpPromptDescriptor[]> {
    if (this.serverCapabilities?.prompts === undefined) {
      this.prompts = [];
      return [];
    }
    this.prompts = await this.fetchAllPaginated<McpPromptDescriptor>(
      "prompts/list",
      (page) => (Array.isArray(page.prompts) ? (page.prompts as McpPromptDescriptor[]) : []),
    );
    return [...this.prompts];
  }

  /**
   * `completion/complete` — argument auto-suggest for prompts and resource
   * templates. Servers that don't implement it surface as `ok: false`.
   */
  async complete(
    ref: McpCompletionRef,
    argument: { name: string; value: string },
  ): Promise<McpCompletionResult> {
    try {
      const result = await this.request<{
        completion?: { values?: string[]; total?: number; hasMore?: boolean };
      }>("completion/complete", { ref, argument });
      const completion = result.completion ?? {};
      return {
        ok: true,
        values: completion.values ?? [],
        total: completion.total,
        hasMore: completion.hasMore,
      };
    } catch (cause) {
      return {
        ok: false,
        error: cause instanceof Error ? cause.message : String(cause),
      };
    }
  }

  async getPrompt(name: string, args?: Record<string, string>): Promise<McpPromptGetResult> {
    try {
      const result = await this.request<{
        description?: string;
        messages?: McpPromptMessage[];
      }>("prompts/get", { name, arguments: args ?? {} });
      return { ok: true, description: result.description, messages: result.messages ?? [] };
    } catch (cause) {
      return {
        ok: false,
        error: cause instanceof Error ? cause.message : String(cause),
      };
    }
  }

  async setLogLevel(level: McpLogLevel): Promise<boolean> {
    if (this.serverCapabilities?.logging === undefined) return false;
    try {
      await this.request("logging/setLevel", { level });
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Cancel a pending request the client previously sent.
   * Idempotent — silently succeeds if the request has already completed.
   */
  cancel(requestId: JsonRpcId, reason?: string): void {
    const pending = this.pending.get(requestId);
    if (pending !== undefined) {
      clearTimeout(pending.timer);
      this.pending.delete(requestId);
      pending.reject(new Error(reason ?? "cancelled"));
    }
    this.notify("notifications/cancelled", {
      requestId,
      reason: reason ?? "cancelled by host",
    });
  }

  /** Tell the server the host's roots list changed. */
  notifyRootsChanged(): void {
    this.notify("notifications/roots/list_changed", {});
  }

  // -------------------------------------------------------------------------
  // Inbound dispatch
  // -------------------------------------------------------------------------

  private handleMessage(message: JsonRpcMessage): void {
    if ("id" in message && (message as JsonRpcResponse).result !== undefined) {
      this.handleResponse(message as JsonRpcResponse);
      return;
    }
    if ("id" in message && (message as JsonRpcResponse).error !== undefined) {
      this.handleResponse(message as JsonRpcResponse);
      return;
    }
    if ("method" in message) {
      // Could be a request (has id) or a notification (no id).
      if ("id" in message && message.id !== undefined && message.id !== null) {
        void this.handleServerRequest(message as JsonRpcRequest);
      } else {
        this.handleServerNotification(message);
      }
    }
  }

  private handleResponse(response: JsonRpcResponse): void {
    const pending = this.pending.get(response.id);
    if (pending === undefined) return;
    this.pending.delete(response.id);
    clearTimeout(pending.timer);
    if (response.error !== undefined) {
      pending.reject(new Error(this.formatRpcError(response.error)));
    } else {
      pending.resolve(response.result);
    }
  }

  private async handleServerRequest(request: JsonRpcRequest): Promise<void> {
    const respond = (result: unknown): void => {
      void this.transport
        .send({ jsonrpc: "2.0", id: request.id, result })
        .catch((err) => this.handlers.onError?.(err));
    };
    const respondError = (code: number, message: string, data?: unknown): void => {
      void this.transport
        .send({
          jsonrpc: "2.0",
          id: request.id,
          error: { code, message, data },
        })
        .catch((err) => this.handlers.onError?.(err));
    };

    try {
      switch (request.method) {
        case "ping": {
          respond({});
          return;
        }
        case "roots/list": {
          const roots = this.handlers.getRoots?.() ?? [];
          respond({ roots });
          return;
        }
        case "sampling/createMessage": {
          if (this.handlers.onSamplingRequest === undefined) {
            respondError(RPC_ERROR_METHOD_NOT_FOUND, "sampling not supported");
            return;
          }
          const params = (request.params ?? {}) as McpSamplingRequestParams;
          try {
            const result = await this.handlers.onSamplingRequest(this.serverId, params);
            if (result === null) {
              respondError(RPC_ERROR_INTERNAL, "host declined sampling request");
              return;
            }
            respond(result);
          } catch (cause) {
            respondError(
              RPC_ERROR_INTERNAL,
              cause instanceof Error ? cause.message : String(cause),
            );
          }
          return;
        }
        default: {
          respondError(RPC_ERROR_METHOD_NOT_FOUND, `Unknown method: ${request.method}`);
        }
      }
    } catch (cause) {
      respondError(
        RPC_ERROR_INTERNAL,
        cause instanceof Error ? cause.message : String(cause),
      );
    }
  }

  private handleServerNotification(message: JsonRpcMessage): void {
    if (!("method" in message)) return;
    const params = (message.params ?? {}) as Record<string, unknown>;
    switch (message.method) {
      case "notifications/message": {
        const log: McpLogMessage = {
          level: (params.level as McpLogLevel) ?? "info",
          logger: typeof params.logger === "string" ? params.logger : undefined,
          data: params.data,
        };
        this.handlers.onLog?.(log);
        return;
      }
      case "notifications/progress": {
        const update: McpProgressUpdate = {
          progressToken: (params.progressToken as string | number) ?? "",
          progress: typeof params.progress === "number" ? params.progress : 0,
          total: typeof params.total === "number" ? params.total : undefined,
        };
        this.handlers.onProgress?.(update);
        return;
      }
      case "notifications/resources/updated": {
        if (typeof params.uri === "string") this.handlers.onResourceUpdated?.(params.uri);
        return;
      }
      case "notifications/tools/list_changed": {
        this.handlers.onToolsListChanged?.();
        void this.refreshTools().catch(() => undefined);
        return;
      }
      case "notifications/resources/list_changed": {
        this.handlers.onResourcesListChanged?.();
        void this.refreshResources().catch(() => undefined);
        void this.refreshResourceTemplates().catch(() => undefined);
        return;
      }
      case "notifications/prompts/list_changed": {
        this.handlers.onPromptsListChanged?.();
        void this.refreshPrompts().catch(() => undefined);
        return;
      }
      case "notifications/cancelled": {
        // Server cancelled one of its own requests to us — we don't track those
        // long-form (handleServerRequest is awaited), so this is informational.
        return;
      }
      default: {
        // Unknown notification — ignore per JSON-RPC convention.
      }
    }
  }

  // -------------------------------------------------------------------------
  // Send helpers
  // -------------------------------------------------------------------------

  private request<T>(method: string, params: unknown): Promise<T> {
    if (!this.transport.isOpen()) {
      return Promise.reject(new Error("transport not open"));
    }
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`MCP request timed out: ${method}`));
      }, REQUEST_TIMEOUT_MS);
      this.pending.set(id, {
        resolve: (value) => resolve(value as T),
        reject,
        timer,
        method,
      });
      this.transport
        .send({ jsonrpc: "2.0", id, method, params })
        .catch((err) => {
          clearTimeout(timer);
          this.pending.delete(id);
          reject(err instanceof Error ? err : new Error(String(err)));
        });
    });
  }

  private notify(method: string, params: unknown): void {
    if (!this.transport.isOpen()) return;
    void this.transport
      .send({ jsonrpc: "2.0", method, params })
      .catch((err) => this.handlers.onError?.(err));
  }

  private failAllPending(err: Error): void {
    for (const [, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(err);
    }
    this.pending.clear();
  }

  private formatRpcError(err: JsonRpcError): string {
    return `MCP error ${err.code}: ${err.message}`;
  }

  /**
   * Walk every page of a `*list` method and return the flattened items.
   * Stops after `MAX_PAGES` pages as a runaway-cursor safety net.
   */
  private async fetchAllPaginated<T>(
    method: string,
    extract: (page: Record<string, unknown>) => T[],
  ): Promise<T[]> {
    const MAX_PAGES = 64;
    const items: T[] = [];
    let cursor: string | undefined;
    for (let i = 0; i < MAX_PAGES; i++) {
      const params: Record<string, unknown> = {};
      if (cursor !== undefined) params.cursor = cursor;
      const page = await this.request<Record<string, unknown>>(method, params);
      items.push(...extract(page));
      const next = page.nextCursor;
      if (typeof next !== "string" || next.length === 0) return items;
      cursor = next;
    }
    return items;
  }
}
