import type { ToolResult } from "../types/result.js";

interface OllamaModel {
  name: string;
}

interface RendererChatRequest {
  userInstruction: string;
  model: string;
  ollamaConfig?: {
    endpoint?: string;
    timeoutMs?: number;
    systemPrompt?: string;
    temperature?: number;
    contextWindow?: number;
  };
  filePreviews?: Array<{ path: string; content: string; truncated: boolean }>;
  sessionId?: string;
}

export type ChatStreamEvent =
  | { requestId: string; type: "delta"; delta: string }
  | {
      requestId: string;
      type: "done";
      message: string;
      stats?: { tokenPerSecond: number | null; elapsedSeconds: number | null };
    }
  | { requestId: string; type: "context"; source: "corpus2skill"; summary: string }
  | {
      requestId: string;
      type: "settings";
      model: string;
      hasSystemPrompt: boolean;
      systemPromptChars: number;
      temperature: number | null;
      contextWindow: number | null;
    }
  | { requestId: string; type: "error"; code: string; message: string };

export type CanvasMarkdownStreamEvent =
  | { requestId: string; type: "delta"; delta: string }
  | { requestId: string; type: "done"; markdown: string }
  | { requestId: string; type: "error"; code: string; message: string };

export type CanvasMarkdownEditMode = "append" | "selection" | "replace";

export interface ChatHistoryMessage {
  id: string;
  role: "user" | "assistant" | "system";
  content: string;
  timestamp: string;
  stats?: {
    tokenPerSecond: number | null;
    elapsedSeconds: number | null;
  };
}

export interface ChatHistoryConversation {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  messages: ChatHistoryMessage[];
}

export interface ChatConversationSummary {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  messageCount: number;
  preview: string;
}

export interface CanvasDocument {
  folder: string;
  filePath: string;
  name: string;
  content: string;
}

export interface CorpusBuildLimits {
  maxFiles: number;
  maxCharsPerFile: number;
  maxTotalChars: number;
  maxDepth: number;
}

export interface CorpusDocumentEntry {
  id: string;
  path: string;
  name: string;
  extension: string;
  sizeBytes: number;
  sourceKind: "text" | "document";
  status: "indexed" | "partial";
  segmentCount: number;
  title: string;
  preview: string;
  keywords: string[];
  skillPath: string;
}

export interface CorpusSkillNode {
  id: string;
  name: string;
  relativePath: string;
  skillPath: string;
  summary: string;
  keywords: string[];
  documentIds: string[];
  children: CorpusSkillNode[];
}

export interface CorpusIndex {
  version: 1;
  builtAt: string;
  workspaceRoot: string;
  corpusDir: string;
  limits: CorpusBuildLimits;
  rootSkillPath: string;
  totalFilesScanned: number;
  indexedFileCount: number;
  skippedFileCount: number;
  totalCharsIndexed: number;
  root: CorpusSkillNode;
  documents: CorpusDocumentEntry[];
  warnings: string[];
}

export interface CorpusNavigateHit {
  kind: "skill" | "document";
  score: number;
  title: string;
  path: string;
  summary: string;
  keywords: string[];
}

export interface CorpusNavigateResult {
  query: string;
  rootSkillPath: string;
  hits: CorpusNavigateHit[];
  navigationMarkdown: string;
}

export type McpLogLevel =
  | "debug"
  | "info"
  | "notice"
  | "warning"
  | "error"
  | "critical"
  | "alert"
  | "emergency";

export interface McpRoot {
  uri: string;
  name?: string;
}

export interface McpStdioTransportConfig {
  kind: "stdio";
  command: string;
  args: string[];
  env?: Record<string, string>;
  cwd?: string;
}

export interface McpHttpTransportConfig {
  kind: "http";
  url: string;
  headers?: Record<string, string>;
}

export type McpTransportConfig = McpStdioTransportConfig | McpHttpTransportConfig;

export interface McpServerConfigInput {
  name: string;
  transport: McpTransportConfig;
  enabled?: boolean;
  roots?: McpRoot[];
}

export interface McpServerConfigPatch {
  name?: string;
  transport?: McpTransportConfig;
  enabled?: boolean;
  roots?: McpRoot[];
}

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

export interface McpServerCapabilities {
  tools?: { listChanged?: boolean };
  resources?: { subscribe?: boolean; listChanged?: boolean };
  prompts?: { listChanged?: boolean };
  logging?: Record<string, unknown>;
  experimental?: Record<string, unknown>;
}

export interface McpImplementationInfo {
  name: string;
  version: string;
}

export interface McpServerStatus {
  id: string;
  name: string;
  connected: boolean;
  error?: string;
  serverInfo?: McpImplementationInfo;
  capabilities?: McpServerCapabilities;
  protocolVersion?: string;
  tools: McpToolDescriptor[];
  resources: McpResourceDescriptor[];
  resourceTemplates: McpResourceTemplate[];
  prompts: McpPromptDescriptor[];
  subscriptions: string[];
}

export interface McpContentBlock {
  type: string;
  text?: string;
  data?: string;
  mimeType?: string;
  uri?: string;
  [key: string]: unknown;
}

export interface McpToolCallResult {
  ok: boolean;
  content?: McpContentBlock[];
  isError?: boolean;
  error?: string;
}

export interface McpResourceContents {
  uri: string;
  mimeType?: string;
  text?: string;
  blob?: string;
}

export interface McpResourceReadResult {
  ok: boolean;
  contents?: McpResourceContents[];
  error?: string;
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

export interface McpLogMessage {
  level: McpLogLevel;
  logger?: string;
  data: unknown;
}

export interface McpProgressUpdate {
  progressToken: string | number;
  progress: number;
  total?: number;
}

export interface McpSamplingRequestParams {
  messages: Array<{ role: "user" | "assistant"; content: McpContentBlock | McpContentBlock[] }>;
  modelPreferences?: unknown;
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

export type McpRendererEvent =
  | { type: "status"; status: McpServerStatus }
  | { type: "log"; serverId: string; message: McpLogMessage }
  | { type: "stderr"; serverId: string; line: string }
  | { type: "progress"; serverId: string; update: McpProgressUpdate }
  | { type: "resource_updated"; serverId: string; uri: string }
  | { type: "tools_list_changed"; serverId: string }
  | { type: "resources_list_changed"; serverId: string }
  | { type: "prompts_list_changed"; serverId: string }
  | {
      type: "sampling_request";
      serverId: string;
      requestId: string;
      params: McpSamplingRequestParams;
    };

declare global {
  interface Window {
    localFileAgent: {
      fetchModels(config?: {
        endpoint?: string;
      }): Promise<ToolResult<OllamaModel[]>>;

      chatMessage(request: RendererChatRequest): Promise<ToolResult<string>>;

      planAction(request: unknown): Promise<any>;

      localActionDraft(request: unknown): Promise<any>;

      recordTrace(sessionId: string | undefined, fields: unknown): Promise<void>;

      selectFolder(): Promise<string | null>;

      listFolder(): Promise<ToolResult<unknown>>;

      readFile(relativePath: string): Promise<ToolResult<unknown>>;

      createWorkspaceEntry(request: unknown): Promise<ToolResult<{ path: string }>>;

      readMultipleFiles(request: unknown): Promise<ToolResult<any>>;

      readDocuments(request: unknown): Promise<ToolResult<any>>;

      prepareDocumentDraft(request: unknown): Promise<ToolResult<any>>;

      createDocumentDraft(generationToken: string, sessionId: string): Promise<ToolResult<any>>;

      runExecution(planToken: string, sessionId: string): Promise<any>;

      logEvent(event: unknown): Promise<void>;

      chatMessageStream(
        request: {
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
        onEvent: (event: ChatStreamEvent) => void,
      ): () => void;

      chatHistoryList(): Promise<ToolResult<ChatConversationSummary[]>>;

      chatHistoryCreate(request?: {
        messages?: ChatHistoryMessage[];
      }): Promise<ToolResult<ChatHistoryConversation>>;

      chatHistoryLoad(id: string): Promise<ToolResult<ChatHistoryConversation>>;

      chatHistorySave(request: {
        id: string;
        messages: ChatHistoryMessage[];
        title?: string;
      }): Promise<ToolResult<ChatConversationSummary>>;

      chatHistoryRename(request: {
        id: string;
        title: string;
      }): Promise<ToolResult<ChatConversationSummary>>;

      chatHistoryDelete(id: string): Promise<ToolResult<{ deleted: boolean; nextId: string | null }>>;

      canvasStart(): Promise<ToolResult<CanvasDocument>>;

      canvasOpen(): Promise<ToolResult<CanvasDocument>>;

      canvasSave(request: {
        filePath: string;
        content: string;
      }): Promise<ToolResult<CanvasDocument>>;

      corpusBuild(): Promise<ToolResult<CorpusIndex>>;

      corpusLoad(): Promise<ToolResult<CorpusIndex>>;

      corpusStatus(): Promise<ToolResult<CorpusIndex | null>>;

      corpusNavigate(request: {
        query: string;
        maxHits?: number;
      }): Promise<ToolResult<CorpusNavigateResult>>;

      mcpListServers(): Promise<McpServerStatus[]>;

      mcpAddServer(input: McpServerConfigInput): Promise<McpServerStatus>;

      mcpUpdateServer(
        id: string,
        patch: McpServerConfigPatch,
      ): Promise<McpServerStatus | null>;

      mcpRemoveServer(id: string): Promise<boolean>;

      mcpConnectServer(id: string): Promise<McpServerStatus | null>;

      mcpDisconnectServer(id: string): Promise<McpServerStatus | null>;

      mcpPing(id: string): Promise<boolean>;

      mcpRefresh(id: string): Promise<McpServerStatus | null>;

      mcpCallTool(args: {
        serverId: string;
        toolName: string;
        arguments?: unknown;
      }): Promise<McpToolCallResult>;

      mcpReadResource(args: {
        serverId: string;
        uri: string;
      }): Promise<McpResourceReadResult>;

      mcpSubscribeResource(args: {
        serverId: string;
        uri: string;
      }): Promise<boolean>;

      mcpUnsubscribeResource(args: {
        serverId: string;
        uri: string;
      }): Promise<boolean>;

      mcpGetPrompt(args: {
        serverId: string;
        name: string;
        arguments?: Record<string, string>;
      }): Promise<McpPromptGetResult>;

      mcpSetLogLevel(args: {
        serverId: string;
        level: McpLogLevel;
      }): Promise<boolean>;

      mcpSetRoots(args: {
        serverId: string;
        roots: McpRoot[];
      }): Promise<McpServerStatus | null>;

      mcpResolveSampling(args: {
        requestId: string;
        result: McpSamplingResult | null;
      }): Promise<void>;

      mcpRejectSampling(args: {
        requestId: string;
        reason?: string;
      }): Promise<void>;

      mcpComplete(args: {
        serverId: string;
        ref: McpCompletionRef;
        argument: { name: string; value: string };
      }): Promise<McpCompletionResult>;

      mcpSetSamplingPolicy(args: {
        policy: "auto" | "ask" | "never";
        graceMs?: number;
      }): Promise<void>;

      mcpAuthorize(args: {
        serverId: string;
        scope?: string;
        clientId?: string;
        clientSecret?: string;
      }): Promise<{ ok: true } | { ok: false; error: string }>;

      mcpClearAuthorization(serverId: string): Promise<void>;

      mcpOnEvent(listener: (event: McpRendererEvent) => void): () => void;

      canvasGenerateMarkdownStream(
        request: {
          requestId: string;
          userInstruction: string;
          currentMarkdown: string;
          targetMarkdown?: string;
          editMode?: CanvasMarkdownEditMode;
          model: string;
          ollamaConfig?: { endpoint?: string; timeoutMs?: number };
        },
        onEvent: (event: CanvasMarkdownStreamEvent) => void,
      ): () => void;
    };
  }
}

export {};
