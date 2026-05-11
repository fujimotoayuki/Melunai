/**
 * Electron Preload Script — Melunai chat-only reset.
 *
 * The renderer can only:
 *   - list local Ollama models
 *   - send a normal chat message
 *
 * File operations, workspace APIs, execution APIs, and document APIs are not
 * exposed in this reset build.
 */

import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("localFileAgent", {
  fetchModels: (
    config?: { endpoint?: string },
  ): Promise<unknown> =>
    ipcRenderer.invoke("lfa:fetch-models", config),

  chatMessage: (args: {
    userInstruction: string;
    model: string;
    ollamaConfig?: {
      endpoint?: string;
      timeoutMs?: number;
      systemPrompt?: string;
      temperature?: number;
      contextWindow?: number;
    };
    filePreviews?: [];
    sessionId?: string;
  }): Promise<unknown> =>
    ipcRenderer.invoke("lfa:chat-message", args),

  chatMessageStream: (
    args: {
      requestId: string;
      userInstruction: string;
      model: string;
      ollamaConfig?: {
        endpoint?: string;
        timeoutMs?: number;
        systemPrompt?: string;
        temperature?: number;
        contextWindow?: number;
      };
      sessionId?: string;
      useCorpus?: boolean;
    },
    onEvent: (event: unknown) => void,
  ): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, payload: unknown) => {
      if (
        typeof payload === "object" &&
        payload !== null &&
        "requestId" in payload &&
        (payload as { requestId?: unknown }).requestId === args.requestId
      ) {
        onEvent(payload);
      }
    };
    ipcRenderer.on("lfa:chat-stream-event", listener);
    void ipcRenderer.invoke("lfa:chat-message-stream", args);
    return () => {
      ipcRenderer.removeListener("lfa:chat-stream-event", listener);
      void ipcRenderer.invoke("lfa:cancel-chat-message-stream", args.requestId);
    };
  },

  chatHistoryList: (): Promise<unknown> =>
    ipcRenderer.invoke("lfa:chat-history-list"),

  chatHistoryCreate: (args?: { messages?: unknown[] }): Promise<unknown> =>
    ipcRenderer.invoke("lfa:chat-history-create", args),

  chatHistoryLoad: (id: string): Promise<unknown> =>
    ipcRenderer.invoke("lfa:chat-history-load", id),

  chatHistorySave: (args: { id: string; messages: unknown[]; title?: string }): Promise<unknown> =>
    ipcRenderer.invoke("lfa:chat-history-save", args),

  chatHistoryRename: (args: { id: string; title: string }): Promise<unknown> =>
    ipcRenderer.invoke("lfa:chat-history-rename", args),

  chatHistoryDelete: (id: string): Promise<unknown> =>
    ipcRenderer.invoke("lfa:chat-history-delete", id),

  canvasStart: (): Promise<unknown> =>
    ipcRenderer.invoke("lfa:canvas-start"),

  canvasOpen: (): Promise<unknown> =>
    ipcRenderer.invoke("lfa:canvas-open"),

  canvasSave: (args: { filePath: string; content: string }): Promise<unknown> =>
    ipcRenderer.invoke("lfa:canvas-save", args),

  corpusBuild: (): Promise<unknown> =>
    ipcRenderer.invoke("lfa:corpus-build"),

  corpusLoad: (): Promise<unknown> =>
    ipcRenderer.invoke("lfa:corpus-load"),

  corpusStatus: (): Promise<unknown> =>
    ipcRenderer.invoke("lfa:corpus-status"),

  corpusNavigate: (args: { query: string; maxHits?: number }): Promise<unknown> =>
    ipcRenderer.invoke("lfa:corpus-navigate", args),

  // ---- MCP (Model Context Protocol) ---------------------------------------
  // Full MCP surface: server CRUD, lifecycle, tools, resources, prompts,
  // logging, roots, sampling. Server-initiated events arrive through
  // `mcpOnEvent`.
  mcpListServers: (): Promise<unknown> =>
    ipcRenderer.invoke("lfa:mcp-list-servers"),

  mcpAddServer: (input: unknown): Promise<unknown> =>
    ipcRenderer.invoke("lfa:mcp-add-server", input),

  mcpUpdateServer: (id: string, patch: unknown): Promise<unknown> =>
    ipcRenderer.invoke("lfa:mcp-update-server", id, patch),

  mcpRemoveServer: (id: string): Promise<unknown> =>
    ipcRenderer.invoke("lfa:mcp-remove-server", id),

  mcpConnectServer: (id: string): Promise<unknown> =>
    ipcRenderer.invoke("lfa:mcp-connect-server", id),

  mcpDisconnectServer: (id: string): Promise<unknown> =>
    ipcRenderer.invoke("lfa:mcp-disconnect-server", id),

  mcpPing: (id: string): Promise<unknown> =>
    ipcRenderer.invoke("lfa:mcp-ping", id),

  mcpRefresh: (id: string): Promise<unknown> =>
    ipcRenderer.invoke("lfa:mcp-refresh", id),

  mcpCallTool: (args: {
    serverId: string;
    toolName: string;
    arguments?: unknown;
  }): Promise<unknown> => ipcRenderer.invoke("lfa:mcp-call-tool", args),

  mcpReadResource: (args: { serverId: string; uri: string }): Promise<unknown> =>
    ipcRenderer.invoke("lfa:mcp-read-resource", args),

  mcpSubscribeResource: (args: { serverId: string; uri: string }): Promise<unknown> =>
    ipcRenderer.invoke("lfa:mcp-subscribe-resource", args),

  mcpUnsubscribeResource: (args: { serverId: string; uri: string }): Promise<unknown> =>
    ipcRenderer.invoke("lfa:mcp-unsubscribe-resource", args),

  mcpGetPrompt: (args: {
    serverId: string;
    name: string;
    arguments?: Record<string, string>;
  }): Promise<unknown> => ipcRenderer.invoke("lfa:mcp-get-prompt", args),

  mcpSetLogLevel: (args: { serverId: string; level: string }): Promise<unknown> =>
    ipcRenderer.invoke("lfa:mcp-set-log-level", args),

  mcpSetRoots: (args: {
    serverId: string;
    roots: Array<{ uri: string; name?: string }>;
  }): Promise<unknown> => ipcRenderer.invoke("lfa:mcp-set-roots", args),

  mcpResolveSampling: (args: { requestId: string; result: unknown | null }): Promise<unknown> =>
    ipcRenderer.invoke("lfa:mcp-resolve-sampling", args),

  mcpRejectSampling: (args: { requestId: string; reason?: string }): Promise<unknown> =>
    ipcRenderer.invoke("lfa:mcp-reject-sampling", args),

  mcpSetSamplingPolicy: (args: {
    policy: "auto" | "ask" | "never";
    graceMs?: number;
  }): Promise<unknown> => ipcRenderer.invoke("lfa:mcp-set-sampling-policy", args),

  mcpComplete: (args: {
    serverId: string;
    ref: { type: "ref/prompt"; name: string } | { type: "ref/resource"; uri: string };
    argument: { name: string; value: string };
  }): Promise<unknown> => ipcRenderer.invoke("lfa:mcp-complete", args),

  mcpAuthorize: (args: {
    serverId: string;
    scope?: string;
    clientId?: string;
    clientSecret?: string;
  }): Promise<unknown> => ipcRenderer.invoke("lfa:mcp-authorize", args),

  mcpClearAuthorization: (serverId: string): Promise<unknown> =>
    ipcRenderer.invoke("lfa:mcp-clear-authorization", serverId),

  /**
   * Subscribe to server-originated MCP events (status changes, logs,
   * progress, resource updates, sampling requests, etc.).
   * Returns an unsubscribe function.
   */
  mcpOnEvent: (listener: (event: unknown) => void): (() => void) => {
    const handler = (_event: Electron.IpcRendererEvent, payload: unknown) => listener(payload);
    ipcRenderer.on("lfa:mcp-event", handler);
    return () => ipcRenderer.removeListener("lfa:mcp-event", handler);
  },

  canvasGenerateMarkdownStream: (
    args: {
      requestId: string;
      userInstruction: string;
      currentMarkdown: string;
      targetMarkdown?: string;
      editMode?: "append" | "selection" | "replace";
      model: string;
      ollamaConfig?: { endpoint?: string; timeoutMs?: number };
    },
    onEvent: (event: unknown) => void,
  ): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, payload: unknown) => {
      if (
        typeof payload === "object" &&
        payload !== null &&
        "requestId" in payload &&
        (payload as { requestId?: unknown }).requestId === args.requestId
      ) {
        onEvent(payload);
      }
    };
    ipcRenderer.on("lfa:canvas-markdown-stream-event", listener);
    void ipcRenderer.invoke("lfa:canvas-generate-markdown-stream", args);
    return () => {
      ipcRenderer.removeListener("lfa:canvas-markdown-stream-event", listener);
    };
  },
});
