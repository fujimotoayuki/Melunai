import React from "react";

import {
  addMcpServer,
  authorizeMcpServer,
  callMcpTool,
  clearMcpAuthorization,
  connectMcpServer,
  disconnectMcpServer,
  getMcpPrompt,
  listMcpServers,
  onMcpEvent,
  pingMcpServer,
  readMcpResource,
  refreshMcpServer,
  removeMcpServer,
  setMcpRoots,
} from "../bridge/mcpBridge.js";
import type {
  McpPromptDescriptor,
  McpRendererEvent,
  McpResourceDescriptor,
  McpServerConfigInput,
  McpServerStatus,
  McpToolDescriptor,
} from "../electron-api.js";

interface McpSettingsPanelProps {
  onClose: () => void;
}

type TransportKind = "stdio" | "http";
type McpTab = "tools" | "resources" | "prompts" | "events";

export function McpSettingsPanel({ onClose }: McpSettingsPanelProps): React.ReactElement {
  const [servers, setServers] = React.useState<McpServerStatus[]>([]);
  const [selectedServerId, setSelectedServerId] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [notice, setNotice] = React.useState<string | null>(null);
  const [tab, setTab] = React.useState<McpTab>("tools");
  const [events, setEvents] = React.useState<Array<{ id: string; text: string }>>([]);

  const [serverName, setServerName] = React.useState("");
  const [transportKind, setTransportKind] = React.useState<TransportKind>("http");
  const [httpUrl, setHttpUrl] = React.useState("");
  const [httpHeadersJson, setHttpHeadersJson] = React.useState("{}");
  const [stdioCommand, setStdioCommand] = React.useState("");
  const [stdioArgs, setStdioArgs] = React.useState("");
  const [stdioCwd, setStdioCwd] = React.useState("");
  const [rootUri, setRootUri] = React.useState("");

  const [selectedToolName, setSelectedToolName] = React.useState("");
  const [toolArgsJson, setToolArgsJson] = React.useState("{}");
  const [selectedResourceUri, setSelectedResourceUri] = React.useState("");
  const [selectedPromptName, setSelectedPromptName] = React.useState("");
  const [promptArgsJson, setPromptArgsJson] = React.useState("{}");
  const [operationResult, setOperationResult] = React.useState<string>("");

  React.useEffect(() => {
    void reloadServers();
    const unsubscribe = onMcpEvent((event) => {
      setEvents((current) => [
        { id: `${Date.now()}-${Math.random()}`, text: describeMcpEvent(event) },
        ...current,
      ].slice(0, 80));
      if (event.type === "status") {
        upsertServer(event.status);
      }
    });
    return unsubscribe;
  }, []);

  React.useEffect(() => {
    const selected = servers.find((server) => server.id === selectedServerId) ?? null;
    if (selected === null) return;
    setSelectedToolName((current) => current || selected.tools[0]?.name || "");
    setSelectedResourceUri((current) => current || selected.resources[0]?.uri || "");
    setSelectedPromptName((current) => current || selected.prompts[0]?.name || "");
  }, [selectedServerId, servers]);

  const selectedServer = servers.find((server) => server.id === selectedServerId) ?? null;

  const reloadServers = async () => {
    setBusy(true);
    setError(null);
    try {
      const next = await listMcpServers();
      setServers(next);
      setSelectedServerId((current) => current ?? next[0]?.id ?? null);
    } catch (cause) {
      setError(formatError(cause));
    } finally {
      setBusy(false);
    }
  };

  const upsertServer = (status: McpServerStatus) => {
    setServers((current) => {
      const exists = current.some((server) => server.id === status.id);
      return exists
        ? current.map((server) => (server.id === status.id ? status : server))
        : [status, ...current];
    });
    setSelectedServerId((current) => current ?? status.id);
  };

  const runAction = async (action: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await action();
    } catch (cause) {
      setError(formatError(cause));
    } finally {
      setBusy(false);
    }
  };

  const handleAddServer = async () => {
    await runAction(async () => {
      const input = buildServerInput({
        name: serverName,
        transportKind,
        httpUrl,
        httpHeadersJson,
        stdioCommand,
        stdioArgs,
        stdioCwd,
      });
      const created = await addMcpServer(input);
      upsertServer(created);
      setNotice("MCPサーバーを追加しました。接続ボタンで起動できます。");
      setServerName("");
      setHttpUrl("");
      setHttpHeadersJson("{}");
      setStdioCommand("");
      setStdioArgs("");
      setStdioCwd("");
    });
  };

  const handleConnect = async (serverId: string) => {
    await runAction(async () => {
      const status = await connectMcpServer(serverId);
      if (status !== null) upsertServer(status);
      setNotice("接続を試行しました。tools/resources/prompts が表示されれば成功です。");
    });
  };

  const handleDisconnect = async (serverId: string) => {
    await runAction(async () => {
      const status = await disconnectMcpServer(serverId);
      if (status !== null) upsertServer(status);
      setNotice("切断しました。");
    });
  };

  const handleRefresh = async (serverId: string) => {
    await runAction(async () => {
      const status = await refreshMcpServer(serverId);
      if (status !== null) upsertServer(status);
      setNotice("MCPサーバー情報を更新しました。");
    });
  };

  const handlePing = async (serverId: string) => {
    await runAction(async () => {
      const ok = await pingMcpServer(serverId);
      setNotice(ok ? "ping 成功。接続は生きています。" : "ping 失敗。未接続か応答がありません。");
    });
  };

  const handleRemove = async (serverId: string) => {
    const confirmed = window.confirm("このMCPサーバー設定を削除しますか？");
    if (!confirmed) return;
    await runAction(async () => {
      const ok = await removeMcpServer(serverId);
      if (ok) {
        setServers((current) => current.filter((server) => server.id !== serverId));
        setSelectedServerId((current) => (current === serverId ? null : current));
      }
    });
  };

  const handleAuthorize = async (serverId: string) => {
    await runAction(async () => {
      const result = await authorizeMcpServer({ serverId });
      if (!result.ok) throw new Error(result.error);
      setNotice("認証が完了しました。次に接続してください。");
    });
  };

  const handleClearAuth = async (serverId: string) => {
    await runAction(async () => {
      await clearMcpAuthorization(serverId);
      setNotice("保存済み認証情報を削除しました。");
    });
  };

  const handleSetRoot = async (serverId: string) => {
    await runAction(async () => {
      if (rootUri.trim().length === 0) throw new Error("Root URIを入力してください。");
      const status = await setMcpRoots({
        serverId,
        roots: [{ uri: rootUri.trim(), name: "Melunai root" }],
      });
      if (status !== null) upsertServer(status);
      setNotice("Rootを設定しました。");
    });
  };

  const handleCallTool = async () => {
    if (selectedServer === null) return;
    await runAction(async () => {
      if (selectedToolName.length === 0) throw new Error("Toolを選択してください。");
      const result = await callMcpTool({
        serverId: selectedServer.id,
        toolName: selectedToolName,
        arguments: parseJson(toolArgsJson, "Tool arguments"),
      });
      setOperationResult(JSON.stringify(result, null, 2));
    });
  };

  const handleReadResource = async () => {
    if (selectedServer === null) return;
    await runAction(async () => {
      if (selectedResourceUri.length === 0) throw new Error("Resourceを選択してください。");
      const result = await readMcpResource({
        serverId: selectedServer.id,
        uri: selectedResourceUri,
      });
      setOperationResult(JSON.stringify(result, null, 2));
    });
  };

  const handleGetPrompt = async () => {
    if (selectedServer === null) return;
    await runAction(async () => {
      if (selectedPromptName.length === 0) throw new Error("Promptを選択してください。");
      const parsedArgs = parseJson(promptArgsJson, "Prompt arguments");
      const result = await getMcpPrompt({
        serverId: selectedServer.id,
        name: selectedPromptName,
        arguments: coercePromptArgs(parsedArgs),
      });
      setOperationResult(JSON.stringify(result, null, 2));
    });
  };

  return (
    <div style={styles.backdrop}>
      <section style={styles.panel} aria-label="MCP settings">
        <header style={styles.header}>
          <div>
            <div style={styles.kicker}>Model Context Protocol</div>
            <h2 style={styles.title}>MCP接続</h2>
          </div>
          <button className="ml-btn-glass" style={styles.closeButton} onClick={onClose} title="閉じる">
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
              <path d="M3 3l8 8M11 3l-8 8" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
            </svg>
          </button>
        </header>

        <div style={styles.body}>
          <aside style={styles.sidebar}>
            <div style={styles.addBox}>
              <div style={styles.sectionTitle}>サーバー追加</div>
              <input
                style={styles.input}
                value={serverName}
                onChange={(event) => setServerName(event.currentTarget.value)}
                placeholder="例: GitHub / Slack"
              />
              <div style={styles.segment}>
                <button
                  style={segmentStyle(transportKind === "http")}
                  onClick={() => setTransportKind("http")}
                  type="button"
                >
                  HTTP
                </button>
                <button
                  style={segmentStyle(transportKind === "stdio")}
                  onClick={() => setTransportKind("stdio")}
                  type="button"
                >
                  Local
                </button>
              </div>
              {transportKind === "http" ? (
                <>
                  <input
                    style={styles.input}
                    value={httpUrl}
                    onChange={(event) => setHttpUrl(event.currentTarget.value)}
                    placeholder="https://.../mcp"
                  />
                  <textarea
                    style={styles.textarea}
                    value={httpHeadersJson}
                    onChange={(event) => setHttpHeadersJson(event.currentTarget.value)}
                    placeholder='{"Header": "value"}'
                  />
                </>
              ) : (
                <>
                  <input
                    style={styles.input}
                    value={stdioCommand}
                    onChange={(event) => setStdioCommand(event.currentTarget.value)}
                    placeholder="command: npx / node / python"
                  />
                  <input
                    style={styles.input}
                    value={stdioArgs}
                    onChange={(event) => setStdioArgs(event.currentTarget.value)}
                    placeholder="args: -y package-name ..."
                  />
                  <input
                    style={styles.input}
                    value={stdioCwd}
                    onChange={(event) => setStdioCwd(event.currentTarget.value)}
                    placeholder="cwd 任意"
                  />
                </>
              )}
              <button className="ml-btn-accent" style={styles.fullButton} onClick={() => void handleAddServer()} disabled={busy}>
                追加
              </button>
            </div>

            <div style={styles.serverListHeader}>
              <span>登録済み</span>
              <button className="ml-btn-glass" style={styles.smallIconButton} onClick={() => void reloadServers()} disabled={busy}>
                <svg width="13" height="13" viewBox="0 0 14 14" fill="none" aria-hidden="true">
                  <path d="M12.5 7A5.5 5.5 0 1 1 7 1.5c2.1 0 3.9 1.2 4.8 2.8" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
                  <path d="M12 1.5v3H9" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              </button>
            </div>

            <div style={styles.serverList}>
              {servers.length === 0 ? (
                <div style={styles.empty}>まだMCPサーバーがありません。</div>
              ) : (
                servers.map((server) => (
                  <button
                    key={server.id}
                    style={serverItemStyle(server.id === selectedServerId)}
                    onClick={() => setSelectedServerId(server.id)}
                  >
                    <span style={styles.statusDot(server.connected)} />
                    <span style={styles.serverName}>{server.name}</span>
                    <span style={styles.countBadge}>{server.tools.length}</span>
                  </button>
                ))
              )}
            </div>
          </aside>

          <main style={styles.content}>
            {error !== null && <div style={styles.error}>{error}</div>}
            {notice !== null && <div style={styles.notice}>{notice}</div>}

            {selectedServer === null ? (
              <div style={styles.placeholder}>
                GitHubやSlackのMCP URL、またはローカルMCP起動コマンドを追加してください。
              </div>
            ) : (
              <>
                <section style={styles.serverHeader}>
                  <div>
                    <div style={styles.serverTitleRow}>
                      <span style={styles.statusDot(selectedServer.connected)} />
                      <h3 style={styles.serverTitle}>{selectedServer.name}</h3>
                    </div>
                    <div style={styles.meta}>
                      {selectedServer.connected ? "connected" : "disconnected"}
                      {selectedServer.protocolVersion ? ` · MCP ${selectedServer.protocolVersion}` : ""}
                      {selectedServer.serverInfo ? ` · ${selectedServer.serverInfo.name} ${selectedServer.serverInfo.version}` : ""}
                    </div>
                    {selectedServer.error ? <div style={styles.inlineError}>{selectedServer.error}</div> : null}
                  </div>
                  <div style={styles.actions}>
                    {selectedServer.connected ? (
                      <button className="ml-btn-glass" style={styles.actionButton} onClick={() => void handleDisconnect(selectedServer.id)} disabled={busy}>
                        切断
                      </button>
                    ) : (
                      <button className="ml-btn-accent" style={styles.actionButton} onClick={() => void handleConnect(selectedServer.id)} disabled={busy}>
                        接続
                      </button>
                    )}
                    <button className="ml-btn-glass" style={styles.actionButton} onClick={() => void handlePing(selectedServer.id)} disabled={busy}>
                      ping
                    </button>
                    <button className="ml-btn-glass" style={styles.actionButton} onClick={() => void handleRefresh(selectedServer.id)} disabled={busy || !selectedServer.connected}>
                      更新
                    </button>
                    <button className="ml-btn-glass" style={styles.actionButton} onClick={() => void handleAuthorize(selectedServer.id)} disabled={busy}>
                      認証
                    </button>
                    <button className="ml-btn-glass" style={styles.actionButton} onClick={() => void handleClearAuth(selectedServer.id)} disabled={busy}>
                      認証削除
                    </button>
                    <button className="ml-btn-glass" style={styles.dangerButton} onClick={() => void handleRemove(selectedServer.id)} disabled={busy}>
                      削除
                    </button>
                  </div>
                </section>

                <section style={styles.rootBox}>
                  <input
                    style={styles.input}
                    value={rootUri}
                    onChange={(event) => setRootUri(event.currentTarget.value)}
                    placeholder="Root URI 例: file:///path/to/folder"
                  />
                  <button className="ml-btn-glass" style={styles.actionButton} onClick={() => void handleSetRoot(selectedServer.id)} disabled={busy}>
                    Root設定
                  </button>
                </section>

                <div style={styles.tabs}>
                  {(["tools", "resources", "prompts", "events"] as const).map((name) => (
                    <button key={name} style={tabStyle(tab === name)} onClick={() => setTab(name)}>
                      {tabLabel(name)}
                    </button>
                  ))}
                </div>

                {tab === "tools" && (
                  <ToolTab
                    tools={selectedServer.tools}
                    selectedToolName={selectedToolName}
                    setSelectedToolName={setSelectedToolName}
                    toolArgsJson={toolArgsJson}
                    setToolArgsJson={setToolArgsJson}
                    onCallTool={handleCallTool}
                    busy={busy || !selectedServer.connected}
                  />
                )}
                {tab === "resources" && (
                  <ResourceTab
                    resources={selectedServer.resources}
                    selectedResourceUri={selectedResourceUri}
                    setSelectedResourceUri={setSelectedResourceUri}
                    onReadResource={handleReadResource}
                    busy={busy || !selectedServer.connected}
                  />
                )}
                {tab === "prompts" && (
                  <PromptTab
                    prompts={selectedServer.prompts}
                    selectedPromptName={selectedPromptName}
                    setSelectedPromptName={setSelectedPromptName}
                    promptArgsJson={promptArgsJson}
                    setPromptArgsJson={setPromptArgsJson}
                    onGetPrompt={handleGetPrompt}
                    busy={busy || !selectedServer.connected}
                  />
                )}
                {tab === "events" && (
                  <div style={styles.eventList}>
                    {events.length === 0 ? (
                      <div style={styles.empty}>イベントはまだありません。</div>
                    ) : (
                      events.map((event) => <div key={event.id} style={styles.eventItem}>{event.text}</div>)
                    )}
                  </div>
                )}

                {operationResult.length > 0 && (
                  <section style={styles.resultBox}>
                    <div style={styles.sectionTitle}>Result</div>
                    <pre style={styles.resultPre}>{operationResult}</pre>
                  </section>
                )}
              </>
            )}
          </main>
        </div>
      </section>
    </div>
  );
}

function ToolTab(props: {
  tools: McpToolDescriptor[];
  selectedToolName: string;
  setSelectedToolName: (value: string) => void;
  toolArgsJson: string;
  setToolArgsJson: (value: string) => void;
  onCallTool: () => Promise<void>;
  busy: boolean;
}): React.ReactElement {
  return (
    <section style={styles.toolPanel}>
      <InventoryList
        items={props.tools.map((tool) => ({
          id: tool.name,
          title: tool.annotations?.title ?? tool.name,
          description: tool.description,
          meta: tool.annotations?.destructiveHint ? "destructive" : tool.annotations?.readOnlyHint ? "read-only" : "tool",
        }))}
      />
      <div style={styles.operationBox}>
        <select
          className="ml-select"
          style={styles.select}
          value={props.selectedToolName}
          onChange={(event) => props.setSelectedToolName(event.currentTarget.value)}
        >
          <option value="">Toolを選択</option>
          {props.tools.map((tool) => <option key={tool.name} value={tool.name}>{tool.name}</option>)}
        </select>
        <textarea
          style={styles.codeTextarea}
          value={props.toolArgsJson}
          onChange={(event) => props.setToolArgsJson(event.currentTarget.value)}
          spellCheck={false}
        />
        <button className="ml-btn-accent" style={styles.fullButton} onClick={() => void props.onCallTool()} disabled={props.busy}>
          Toolを実行
        </button>
      </div>
    </section>
  );
}

function ResourceTab(props: {
  resources: McpResourceDescriptor[];
  selectedResourceUri: string;
  setSelectedResourceUri: (value: string) => void;
  onReadResource: () => Promise<void>;
  busy: boolean;
}): React.ReactElement {
  return (
    <section style={styles.toolPanel}>
      <InventoryList
        items={props.resources.map((resource) => ({
          id: resource.uri,
          title: resource.name ?? resource.uri,
          description: resource.description,
          meta: resource.mimeType ?? "resource",
        }))}
      />
      <div style={styles.operationBox}>
        <select
          className="ml-select"
          style={styles.select}
          value={props.selectedResourceUri}
          onChange={(event) => props.setSelectedResourceUri(event.currentTarget.value)}
        >
          <option value="">Resourceを選択</option>
          {props.resources.map((resource) => <option key={resource.uri} value={resource.uri}>{resource.name ?? resource.uri}</option>)}
        </select>
        <button className="ml-btn-accent" style={styles.fullButton} onClick={() => void props.onReadResource()} disabled={props.busy}>
          Resourceを読む
        </button>
      </div>
    </section>
  );
}

function PromptTab(props: {
  prompts: McpPromptDescriptor[];
  selectedPromptName: string;
  setSelectedPromptName: (value: string) => void;
  promptArgsJson: string;
  setPromptArgsJson: (value: string) => void;
  onGetPrompt: () => Promise<void>;
  busy: boolean;
}): React.ReactElement {
  return (
    <section style={styles.toolPanel}>
      <InventoryList
        items={props.prompts.map((prompt) => ({
          id: prompt.name,
          title: prompt.name,
          description: prompt.description,
          meta: `${prompt.arguments?.length ?? 0} args`,
        }))}
      />
      <div style={styles.operationBox}>
        <select
          className="ml-select"
          style={styles.select}
          value={props.selectedPromptName}
          onChange={(event) => props.setSelectedPromptName(event.currentTarget.value)}
        >
          <option value="">Promptを選択</option>
          {props.prompts.map((prompt) => <option key={prompt.name} value={prompt.name}>{prompt.name}</option>)}
        </select>
        <textarea
          style={styles.codeTextarea}
          value={props.promptArgsJson}
          onChange={(event) => props.setPromptArgsJson(event.currentTarget.value)}
          spellCheck={false}
        />
        <button className="ml-btn-accent" style={styles.fullButton} onClick={() => void props.onGetPrompt()} disabled={props.busy}>
          Promptを取得
        </button>
      </div>
    </section>
  );
}

function InventoryList(props: {
  items: Array<{ id: string; title: string; description?: string; meta: string }>;
}): React.ReactElement {
  if (props.items.length === 0) return <div style={styles.empty}>接続後に一覧が表示されます。</div>;
  return (
    <div style={styles.inventoryList}>
      {props.items.map((item) => (
        <article key={item.id} style={styles.inventoryItem}>
          <div style={styles.inventoryTop}>
            <strong style={styles.inventoryTitle}>{item.title}</strong>
            <span style={styles.inventoryMeta}>{item.meta}</span>
          </div>
          {item.description ? <p style={styles.inventoryDescription}>{item.description}</p> : null}
        </article>
      ))}
    </div>
  );
}

function buildServerInput(args: {
  name: string;
  transportKind: TransportKind;
  httpUrl: string;
  httpHeadersJson: string;
  stdioCommand: string;
  stdioArgs: string;
  stdioCwd: string;
}): McpServerConfigInput {
  const name = args.name.trim();
  if (name.length === 0) throw new Error("サーバー名を入力してください。");

  if (args.transportKind === "http") {
    const url = args.httpUrl.trim();
    if (url.length === 0) throw new Error("HTTP URLを入力してください。");
    const headers = parseJson(args.httpHeadersJson, "HTTP headers");
    if (!isRecord(headers)) throw new Error("HTTP headersはJSON objectで入力してください。");
    return {
      name,
      enabled: true,
      transport: {
        kind: "http",
        url,
        headers: stringifyRecord(headers),
      },
    };
  }

  const command = args.stdioCommand.trim();
  if (command.length === 0) throw new Error("commandを入力してください。");
  return {
    name,
    enabled: true,
    transport: {
      kind: "stdio",
      command,
      args: splitCommandArgs(args.stdioArgs),
      cwd: args.stdioCwd.trim().length > 0 ? args.stdioCwd.trim() : undefined,
    },
  };
}

function parseJson(value: string, label: string): unknown {
  try {
    return JSON.parse(value.trim().length > 0 ? value : "{}");
  } catch {
    throw new Error(`${label} のJSONが正しくありません。`);
  }
}

function coercePromptArgs(value: unknown): Record<string, string> {
  if (!isRecord(value)) throw new Error("Prompt argumentsはJSON objectで入力してください。");
  const next: Record<string, string> = {};
  for (const [key, raw] of Object.entries(value)) {
    next[key] = typeof raw === "string" ? raw : JSON.stringify(raw);
  }
  return next;
}

function stringifyRecord(value: Record<string, unknown>): Record<string, string> {
  const next: Record<string, string> = {};
  for (const [key, raw] of Object.entries(value)) {
    if (raw === undefined || raw === null) continue;
    next[key] = typeof raw === "string" ? raw : String(raw);
  }
  return next;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function splitCommandArgs(value: string): string[] {
  return value
    .split(" ")
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}

function describeMcpEvent(event: McpRendererEvent): string {
  switch (event.type) {
    case "status":
      return `status: ${event.status.name} ${event.status.connected ? "connected" : "disconnected"}`;
    case "log":
      return `log(${event.message.level}): ${JSON.stringify(event.message.data)}`;
    case "stderr":
      return `stderr: ${event.line}`;
    case "progress":
      return `progress: ${event.update.progress}/${event.update.total ?? "?"}`;
    case "resource_updated":
      return `resource updated: ${event.uri}`;
    case "tools_list_changed":
      return "tools list changed";
    case "resources_list_changed":
      return "resources list changed";
    case "prompts_list_changed":
      return "prompts list changed";
    case "sampling_request":
      return "sampling request received";
  }
}

function formatError(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

function tabLabel(tab: McpTab): string {
  switch (tab) {
    case "tools":
      return "Tools";
    case "resources":
      return "Resources";
    case "prompts":
      return "Prompts";
    case "events":
      return "Events";
  }
}

function segmentStyle(active: boolean): React.CSSProperties {
  return {
    flex: 1,
    height: 32,
    border: 0,
    borderRadius: 999,
    background: active ? "linear-gradient(135deg, #D5F2EA 0%, #9BCFCC 45%, #6E98BC 100%)" : "transparent",
    color: active ? "#1D1D1F" : "#A1A1A6",
    fontWeight: 800,
    cursor: "pointer",
  };
}

function tabStyle(active: boolean): React.CSSProperties {
  return {
    height: 34,
    padding: "0 16px",
    border: "1px solid rgba(255,255,255,0.1)",
    borderRadius: 999,
    background: active ? "rgba(255,255,255,0.14)" : "rgba(255,255,255,0.05)",
    color: active ? "#F5F5F7" : "#A1A1A6",
    fontWeight: 700,
    cursor: "pointer",
  };
}

function serverItemStyle(active: boolean): React.CSSProperties {
  return {
    width: "100%",
    display: "grid",
    gridTemplateColumns: "10px 1fr auto",
    alignItems: "center",
    gap: 10,
    padding: "11px 12px",
    border: "1px solid rgba(255,255,255,0.09)",
    borderRadius: 12,
    background: active ? "rgba(255,255,255,0.12)" : "rgba(255,255,255,0.045)",
    color: "#F5F5F7",
    cursor: "pointer",
    textAlign: "left",
  };
}

const styles = {
  backdrop: {
    position: "fixed",
    inset: 0,
    zIndex: 60,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    padding: 24,
    background: "rgba(0,0,0,0.5)",
    backdropFilter: "blur(18px)",
  } as React.CSSProperties,
  panel: {
    width: "min(1180px, 100%)",
    height: "min(760px, calc(100vh - 48px))",
    display: "flex",
    flexDirection: "column",
    borderRadius: 22,
    border: "1px solid rgba(255,255,255,0.12)",
    background: "linear-gradient(180deg, rgba(38,38,42,0.98), rgba(29,29,31,0.98))",
    boxShadow: "0 40px 120px rgba(0,0,0,0.58)",
    overflow: "hidden",
  } as React.CSSProperties,
  header: {
    height: 70,
    flexShrink: 0,
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    padding: "0 24px",
    borderBottom: "1px solid rgba(255,255,255,0.08)",
  } as React.CSSProperties,
  kicker: {
    color: "#6E98BC",
    fontSize: 11,
    fontWeight: 800,
    letterSpacing: "0.08em",
    textTransform: "uppercase",
  } as React.CSSProperties,
  title: {
    margin: 0,
    color: "#F5F5F7",
    fontSize: 24,
    lineHeight: 1.1,
  } as React.CSSProperties,
  closeButton: {
    width: 34,
    height: 34,
  } as React.CSSProperties,
  body: {
    flex: 1,
    minHeight: 0,
    display: "grid",
    gridTemplateColumns: "320px 1fr",
  } as React.CSSProperties,
  sidebar: {
    minHeight: 0,
    display: "flex",
    flexDirection: "column",
    gap: 14,
    padding: 18,
    borderRight: "1px solid rgba(255,255,255,0.08)",
    overflowY: "auto",
  } as React.CSSProperties,
  content: {
    minHeight: 0,
    overflowY: "auto",
    padding: 22,
  } as React.CSSProperties,
  addBox: {
    display: "flex",
    flexDirection: "column",
    gap: 10,
    padding: 14,
    borderRadius: 16,
    background: "rgba(255,255,255,0.045)",
    border: "1px solid rgba(255,255,255,0.08)",
  } as React.CSSProperties,
  sectionTitle: {
    color: "#F5F5F7",
    fontSize: 13,
    fontWeight: 800,
  } as React.CSSProperties,
  input: {
    width: "100%",
    height: 36,
    borderRadius: 999,
    border: "1px solid rgba(255,255,255,0.1)",
    background: "rgba(255,255,255,0.06)",
    color: "#F5F5F7",
    outline: "none",
    padding: "0 13px",
    fontFamily: "inherit",
  } as React.CSSProperties,
  textarea: {
    width: "100%",
    minHeight: 66,
    borderRadius: 12,
    border: "1px solid rgba(255,255,255,0.1)",
    background: "rgba(255,255,255,0.06)",
    color: "#F5F5F7",
    outline: "none",
    padding: 10,
    fontFamily: "ui-monospace, SFMono-Regular, Consolas, monospace",
    resize: "vertical",
  } as React.CSSProperties,
  segment: {
    display: "flex",
    padding: 3,
    gap: 4,
    borderRadius: 999,
    background: "rgba(255,255,255,0.06)",
  } as React.CSSProperties,
  fullButton: {
    height: 38,
    padding: "0 18px",
  } as React.CSSProperties,
  serverListHeader: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    color: "#A1A1A6",
    fontSize: 12,
    fontWeight: 800,
    padding: "0 2px",
  } as React.CSSProperties,
  smallIconButton: {
    width: 28,
    height: 28,
  } as React.CSSProperties,
  serverList: {
    display: "flex",
    flexDirection: "column",
    gap: 8,
  } as React.CSSProperties,
  statusDot: (connected: boolean): React.CSSProperties => ({
    width: 8,
    height: 8,
    borderRadius: 999,
    background: connected ? "#9BCFCC" : "#5A5A60",
    boxShadow: connected ? "0 0 12px rgba(155,207,204,0.65)" : "none",
  }),
  serverName: {
    minWidth: 0,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    fontSize: 13,
    fontWeight: 700,
  } as React.CSSProperties,
  countBadge: {
    minWidth: 22,
    height: 22,
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 999,
    color: "#1D1D1F",
    background: "linear-gradient(135deg, #D5F2EA, #6E98BC)",
    fontSize: 11,
    fontWeight: 900,
  } as React.CSSProperties,
  error: {
    marginBottom: 12,
    padding: "10px 12px",
    borderRadius: 12,
    color: "#ffb199",
    background: "rgba(255,120,90,0.09)",
    border: "1px solid rgba(255,120,90,0.16)",
    fontSize: 13,
  } as React.CSSProperties,
  notice: {
    marginBottom: 12,
    padding: "10px 12px",
    borderRadius: 12,
    color: "#D5F2EA",
    background: "rgba(155,207,204,0.09)",
    border: "1px solid rgba(155,207,204,0.18)",
    fontSize: 13,
  } as React.CSSProperties,
  placeholder: {
    height: "100%",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    color: "#6E6E73",
    textAlign: "center",
  } as React.CSSProperties,
  serverHeader: {
    display: "flex",
    justifyContent: "space-between",
    gap: 18,
    paddingBottom: 16,
    borderBottom: "1px solid rgba(255,255,255,0.08)",
  } as React.CSSProperties,
  serverTitleRow: {
    display: "flex",
    alignItems: "center",
    gap: 10,
  } as React.CSSProperties,
  serverTitle: {
    margin: 0,
    fontSize: 24,
    color: "#F5F5F7",
  } as React.CSSProperties,
  meta: {
    marginTop: 7,
    color: "#A1A1A6",
    fontSize: 12,
  } as React.CSSProperties,
  inlineError: {
    marginTop: 8,
    color: "#ffb199",
    fontSize: 12,
  } as React.CSSProperties,
  actions: {
    display: "flex",
    flexWrap: "wrap",
    justifyContent: "flex-end",
    alignContent: "flex-start",
    gap: 8,
  } as React.CSSProperties,
  actionButton: {
    minWidth: 72,
    height: 34,
    padding: "0 14px",
    fontSize: 12,
    fontWeight: 800,
  } as React.CSSProperties,
  dangerButton: {
    minWidth: 58,
    height: 34,
    padding: "0 14px",
    color: "#ffb199",
  } as React.CSSProperties,
  rootBox: {
    display: "grid",
    gridTemplateColumns: "1fr auto",
    gap: 10,
    marginTop: 16,
  } as React.CSSProperties,
  tabs: {
    display: "flex",
    gap: 8,
    marginTop: 18,
    marginBottom: 16,
  } as React.CSSProperties,
  toolPanel: {
    display: "grid",
    gridTemplateColumns: "minmax(0, 1fr) 320px",
    gap: 16,
    alignItems: "start",
  } as React.CSSProperties,
  inventoryList: {
    display: "grid",
    gap: 10,
  } as React.CSSProperties,
  inventoryItem: {
    padding: 14,
    borderRadius: 14,
    border: "1px solid rgba(255,255,255,0.08)",
    background: "rgba(255,255,255,0.045)",
  } as React.CSSProperties,
  inventoryTop: {
    display: "flex",
    justifyContent: "space-between",
    gap: 12,
  } as React.CSSProperties,
  inventoryTitle: {
    color: "#F5F5F7",
    fontSize: 13,
    lineHeight: 1.4,
  } as React.CSSProperties,
  inventoryMeta: {
    color: "#6E98BC",
    fontSize: 11,
    fontWeight: 800,
    whiteSpace: "nowrap",
  } as React.CSSProperties,
  inventoryDescription: {
    margin: "8px 0 0",
    color: "#A1A1A6",
    fontSize: 12,
    lineHeight: 1.5,
  } as React.CSSProperties,
  operationBox: {
    display: "flex",
    flexDirection: "column",
    gap: 10,
    padding: 14,
    borderRadius: 16,
    background: "rgba(255,255,255,0.045)",
    border: "1px solid rgba(255,255,255,0.08)",
  } as React.CSSProperties,
  select: {
    height: 36,
    padding: "0 12px",
    width: "100%",
  } as React.CSSProperties,
  codeTextarea: {
    width: "100%",
    minHeight: 160,
    borderRadius: 12,
    border: "1px solid rgba(255,255,255,0.1)",
    background: "rgba(0,0,0,0.26)",
    color: "#F5F5F7",
    outline: "none",
    padding: 10,
    resize: "vertical",
    fontFamily: "ui-monospace, SFMono-Regular, Consolas, monospace",
    fontSize: 12,
    lineHeight: 1.5,
  } as React.CSSProperties,
  resultBox: {
    marginTop: 16,
    padding: 14,
    borderRadius: 16,
    border: "1px solid rgba(255,255,255,0.08)",
    background: "rgba(0,0,0,0.22)",
  } as React.CSSProperties,
  resultPre: {
    maxHeight: 260,
    overflow: "auto",
    margin: "10px 0 0",
    color: "#D5F2EA",
    fontSize: 12,
    lineHeight: 1.5,
    whiteSpace: "pre-wrap",
    wordBreak: "break-word",
  } as React.CSSProperties,
  eventList: {
    display: "grid",
    gap: 8,
  } as React.CSSProperties,
  eventItem: {
    padding: "9px 11px",
    borderRadius: 10,
    background: "rgba(255,255,255,0.045)",
    border: "1px solid rgba(255,255,255,0.07)",
    color: "#A1A1A6",
    fontSize: 12,
  } as React.CSSProperties,
  empty: {
    color: "#6E6E73",
    fontSize: 13,
    lineHeight: 1.5,
    padding: 12,
  } as React.CSSProperties,
} as const;
