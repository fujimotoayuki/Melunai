import type { ToolResult } from "../types/index.js";

export const DEFAULT_OLLAMA_ENDPOINT = "http://localhost:11434";
export const DEFAULT_TIMEOUT_MS = 120_000;

export interface OllamaClientConfig {
  endpoint?: string;
  timeoutMs?: number;
  systemPrompt?: string;
  temperature?: number;
  contextWindow?: number;
}

export interface OllamaModel {
  name: string;
  modifiedAt: string;
  size: number;
  digest: string;
}

export type OllamaChatRole = "system" | "user" | "assistant";

export interface OllamaChatMessage {
  role: OllamaChatRole;
  content: string;
}

export interface OllamaChatRequest {
  model: string;
  messages: OllamaChatMessage[];
  config?: OllamaClientConfig;
}

export type OllamaListModelsResult = ToolResult<OllamaModel[]>;
export type OllamaChatResult = ToolResult<string>;

// --- Internal Ollama API shapes ---

export interface OllamaApiModelDetail {
  format?: string;
  family?: string;
  parameter_size?: string;
  quantization_level?: string;
}

export interface OllamaApiModel {
  name: string;
  modified_at: string;
  size: number;
  digest: string;
  details?: OllamaApiModelDetail;
}

export interface OllamaApiTagsResponse {
  models: OllamaApiModel[];
}

export interface OllamaApiChatMessage {
  role: string;
  content: string;
}

export interface OllamaApiChatResponse {
  model: string;
  message: OllamaApiChatMessage;
  done: boolean;
}
