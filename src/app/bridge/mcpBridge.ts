import type {
  McpPromptGetResult,
  McpRendererEvent,
  McpResourceReadResult,
  McpRoot,
  McpServerConfigInput,
  McpServerConfigPatch,
  McpServerStatus,
  McpToolCallResult,
} from "../electron-api.js";

export async function listMcpServers(): Promise<McpServerStatus[]> {
  return window.localFileAgent.mcpListServers();
}

export async function addMcpServer(input: McpServerConfigInput): Promise<McpServerStatus> {
  return window.localFileAgent.mcpAddServer(input);
}

export async function updateMcpServer(
  id: string,
  patch: McpServerConfigPatch,
): Promise<McpServerStatus | null> {
  return window.localFileAgent.mcpUpdateServer(id, patch);
}

export async function removeMcpServer(id: string): Promise<boolean> {
  return window.localFileAgent.mcpRemoveServer(id);
}

export async function connectMcpServer(id: string): Promise<McpServerStatus | null> {
  return window.localFileAgent.mcpConnectServer(id);
}

export async function disconnectMcpServer(id: string): Promise<McpServerStatus | null> {
  return window.localFileAgent.mcpDisconnectServer(id);
}

export async function pingMcpServer(id: string): Promise<boolean> {
  return window.localFileAgent.mcpPing(id);
}

export async function refreshMcpServer(id: string): Promise<McpServerStatus | null> {
  return window.localFileAgent.mcpRefresh(id);
}

export async function authorizeMcpServer(args: {
  serverId: string;
  scope?: string;
  clientId?: string;
  clientSecret?: string;
}): Promise<{ ok: true } | { ok: false; error: string }> {
  return window.localFileAgent.mcpAuthorize(args);
}

export async function clearMcpAuthorization(serverId: string): Promise<void> {
  return window.localFileAgent.mcpClearAuthorization(serverId);
}

export async function callMcpTool(args: {
  serverId: string;
  toolName: string;
  arguments?: unknown;
}): Promise<McpToolCallResult> {
  return window.localFileAgent.mcpCallTool(args);
}

export async function readMcpResource(args: {
  serverId: string;
  uri: string;
}): Promise<McpResourceReadResult> {
  return window.localFileAgent.mcpReadResource(args);
}

export async function getMcpPrompt(args: {
  serverId: string;
  name: string;
  arguments?: Record<string, string>;
}): Promise<McpPromptGetResult> {
  return window.localFileAgent.mcpGetPrompt(args);
}

export async function setMcpRoots(args: {
  serverId: string;
  roots: McpRoot[];
}): Promise<McpServerStatus | null> {
  return window.localFileAgent.mcpSetRoots(args);
}

export function onMcpEvent(listener: (event: McpRendererEvent) => void): () => void {
  return window.localFileAgent.mcpOnEvent(listener);
}
