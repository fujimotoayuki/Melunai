/**
 * MCP (Model Context Protocol) — full type surface used by Melunai.
 *
 * Mirrors the public spec at https://spec.modelcontextprotocol.io/ at the
 * 2024-11-05 protocol revision. Only the bits Melunai actually wires through
 * are documented here; opaque server payloads are kept as `unknown` rather
 * than re-typing every nested object.
 */

// ---------------------------------------------------------------------------
// JSON-RPC primitives
// ---------------------------------------------------------------------------

export type JsonRpcId = number | string;

export interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: JsonRpcId;
  method: string;
  params?: unknown;
}

export interface JsonRpcNotification {
  jsonrpc: "2.0";
  method: string;
  params?: unknown;
}

export interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: JsonRpcId;
  result?: unknown;
  error?: JsonRpcError;
}

export interface JsonRpcError {
  code: number;
  message: string;
  data?: unknown;
}

export type JsonRpcMessage = JsonRpcRequest | JsonRpcNotification | JsonRpcResponse;

// Standard JSON-RPC error codes used by MCP.
export const RPC_ERROR_PARSE = -32700;
export const RPC_ERROR_INVALID_REQUEST = -32600;
export const RPC_ERROR_METHOD_NOT_FOUND = -32601;
export const RPC_ERROR_INVALID_PARAMS = -32602;
export const RPC_ERROR_INTERNAL = -32603;

// ---------------------------------------------------------------------------
// Server / client identity + capabilities
// ---------------------------------------------------------------------------

export interface McpImplementationInfo {
  name: string;
  version: string;
}

export interface McpServerCapabilities {
  tools?: { listChanged?: boolean };
  resources?: { subscribe?: boolean; listChanged?: boolean };
  prompts?: { listChanged?: boolean };
  logging?: Record<string, unknown>;
  experimental?: Record<string, unknown>;
}

export interface McpClientCapabilities {
  roots?: { listChanged?: boolean };
  sampling?: Record<string, unknown>;
  experimental?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Transport configuration (renderer-facing)
// ---------------------------------------------------------------------------

export interface McpStdioTransportConfig {
  kind: "stdio";
  command: string;
  args: string[];
  env?: Record<string, string>;
  /** Optional working directory for the spawned process. */
  cwd?: string;
}

export interface McpHttpTransportConfig {
  kind: "http";
  /**
   * Base URL of the Streamable HTTP endpoint. Single endpoint per
   * MCP 2025 spec — the same URL handles POST (client→server) and
   * GET (server→client SSE stream).
   */
  url: string;
  /** Headers added to every request (e.g. "Authorization: Bearer …"). */
  headers?: Record<string, string>;
}

export type McpTransportConfig = McpStdioTransportConfig | McpHttpTransportConfig;

// ---------------------------------------------------------------------------
// Persisted server config + runtime status
// ---------------------------------------------------------------------------

export interface McpServerConfig {
  /** Stable identifier (generated when added). */
  id: string;
  /** Human-readable name shown in the UI. */
  name: string;
  /** Transport definition. */
  transport: McpTransportConfig;
  /** Whether this server should auto-connect on app start. */
  enabled: boolean;
  /**
   * Workspace roots advertised to the server when it queries `roots/list`.
   * Empty array = no roots advertised. Servers can reject if they need them.
   */
  roots?: McpRoot[];
}

export interface McpRoot {
  uri: string;
  name?: string;
}

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

/**
 * Behavioural hints declared by a tool. None are authoritative — they're
 * advisory metadata the host can use to decide things like "auto-approve
 * read-only tools" vs "require confirmation for destructive ones".
 */
export interface McpToolAnnotations {
  title?: string;
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
  [key: string]: unknown;
}

export interface McpToolDescriptor {
  name: string;
  description?: string;
  inputSchema?: unknown;
  annotations?: McpToolAnnotations;
}

// ---------------------------------------------------------------------------
// Pagination — every list method may return a `nextCursor` to be passed back
// in a subsequent call. Cursors are opaque strings owned by the server.
// ---------------------------------------------------------------------------
export interface McpListPage<T> {
  items: T[];
  nextCursor?: string;
}

// ---------------------------------------------------------------------------
// Completion (`completion/complete`) — argument auto-suggest for prompts +
// resource templates.
// ---------------------------------------------------------------------------
export type McpCompletionRef =
  | { type: "ref/prompt"; name: string }
  | { type: "ref/resource"; uri: string };

export interface McpCompletionResult {
  ok: boolean;
  values?: string[];
  total?: number;
  hasMore?: boolean;
  error?: string;
}

export interface McpContentBlock {
  type: string;
  // text blocks
  text?: string;
  // image / resource blocks
  data?: string;
  mimeType?: string;
  uri?: string;
  // catch-all for forward compatibility
  [key: string]: unknown;
}

export interface McpToolCallResult {
  ok: boolean;
  content?: McpContentBlock[];
  isError?: boolean;
  error?: string;
}

// ---------------------------------------------------------------------------
// Resources
// ---------------------------------------------------------------------------

export interface McpResourceDescriptor {
  uri: string;
  name?: string;
  description?: string;
  mimeType?: string;
}

export interface McpResourceTemplate {
  uriTemplate: string;
  name?: string;
  description?: string;
  mimeType?: string;
}

export interface McpResourceContents {
  uri: string;
  mimeType?: string;
  text?: string;
  blob?: string; // base64
}

export interface McpResourceReadResult {
  ok: boolean;
  contents?: McpResourceContents[];
  error?: string;
}

// ---------------------------------------------------------------------------
// Prompts
// ---------------------------------------------------------------------------

export interface McpPromptArgumentSpec {
  name: string;
  description?: string;
  required?: boolean;
}

export interface McpPromptDescriptor {
  name: string;
  description?: string;
  arguments?: McpPromptArgumentSpec[];
}

export interface McpPromptMessage {
  role: "user" | "assistant" | "system";
  content: McpContentBlock | McpContentBlock[];
}

export interface McpPromptGetResult {
  ok: boolean;
  description?: string;
  messages?: McpPromptMessage[];
  error?: string;
}

// ---------------------------------------------------------------------------
// Sampling (server → client → LLM)
// ---------------------------------------------------------------------------

export interface McpSamplingMessage {
  role: "user" | "assistant";
  content: McpContentBlock | McpContentBlock[];
}

export interface McpSamplingRequestParams {
  messages: McpSamplingMessage[];
  modelPreferences?: {
    hints?: Array<{ name?: string }>;
    costPriority?: number;
    speedPriority?: number;
    intelligencePriority?: number;
  };
  systemPrompt?: string;
  includeContext?: "none" | "thisServer" | "allServers";
  temperature?: number;
  maxTokens?: number;
  stopSequences?: string[];
  metadata?: Record<string, unknown>;
}

export interface McpSamplingResult {
  role: "assistant";
  content: McpContentBlock;
  model: string;
  stopReason?: string;
}

/**
 * Renderer-supplied callback that fulfills sampling requests.
 * Receiving `null` means the host declines to sample.
 */
export type McpSamplingHandler = (
  serverId: string,
  params: McpSamplingRequestParams,
) => Promise<McpSamplingResult | null>;

// ---------------------------------------------------------------------------
// Logging messages emitted by servers
// ---------------------------------------------------------------------------

export type McpLogLevel =
  | "debug"
  | "info"
  | "notice"
  | "warning"
  | "error"
  | "critical"
  | "alert"
  | "emergency";

export interface McpLogMessage {
  level: McpLogLevel;
  logger?: string;
  data: unknown;
}

// ---------------------------------------------------------------------------
// Progress notifications
// ---------------------------------------------------------------------------

export interface McpProgressUpdate {
  progressToken: string | number;
  progress: number;
  total?: number;
}

// ---------------------------------------------------------------------------
// Status snapshot returned to the renderer
// ---------------------------------------------------------------------------

export interface McpServerStatus {
  id: string;
  name: string;
  connected: boolean;
  /** Last connection / runtime error message, if any. */
  error?: string;
  /** Server identity reported during initialize. */
  serverInfo?: McpImplementationInfo;
  /** Capabilities declared by the server. */
  capabilities?: McpServerCapabilities;
  /** Negotiated protocol version. */
  protocolVersion?: string;
  tools: McpToolDescriptor[];
  resources: McpResourceDescriptor[];
  resourceTemplates: McpResourceTemplate[];
  prompts: McpPromptDescriptor[];
  /** Resource URIs the client is currently subscribed to. */
  subscriptions: string[];
}

// ---------------------------------------------------------------------------
// Renderer-bound event payloads (delivered via webContents.send).
// One discriminated union — easy to handle in React with a switch.
// ---------------------------------------------------------------------------

export type McpRendererEvent =
  | {
      type: "status";
      status: McpServerStatus;
    }
  | {
      type: "log";
      serverId: string;
      message: McpLogMessage;
    }
  | {
      type: "stderr";
      serverId: string;
      line: string;
    }
  | {
      type: "progress";
      serverId: string;
      update: McpProgressUpdate;
    }
  | {
      type: "resource_updated";
      serverId: string;
      uri: string;
    }
  | {
      type: "tools_list_changed";
      serverId: string;
    }
  | {
      type: "resources_list_changed";
      serverId: string;
    }
  | {
      type: "prompts_list_changed";
      serverId: string;
    }
  | {
      type: "sampling_request";
      serverId: string;
      requestId: string;
      params: McpSamplingRequestParams;
    };
