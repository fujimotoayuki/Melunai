/**
 * stdio transport — spawns a child process and exchanges newline-delimited
 * JSON-RPC messages over its stdin/stdout. stderr is forwarded to the
 * `onStderr` handler so the host can surface server logs.
 */

import { spawn, type ChildProcessWithoutNullStreams } from "child_process";
import type { JsonRpcMessage } from "./mcpTypes.js";
import type { McpTransport, McpTransportHandlers } from "./mcpTransport.js";

export interface StdioTransportOptions {
  command: string;
  args: string[];
  env?: Record<string, string>;
  cwd?: string;
}

/**
 * 子プロセスに継承する環境変数のホワイトリスト。
 * `process.env` 全体を渡すと、AWS_* / GITHUB_TOKEN / OPENAI_API_KEY 等のホスト鍵が
 * 任意 MCP サーバに漏洩する。最低限必要な PATH / 言語ロケール / TEMP 系のみ通す。
 */
const STDIO_ENV_ALLOWLIST = new Set([
  "PATH", "PATHEXT",
  "HOME", "USERPROFILE",
  "TEMP", "TMP", "TMPDIR",
  "LANG", "LANGUAGE", "LC_ALL", "LC_CTYPE", "LC_MESSAGES",
  "TZ",
  // Windows 必須
  "SYSTEMROOT", "SYSTEMDRIVE", "WINDIR", "COMSPEC",
  "APPDATA", "LOCALAPPDATA", "PROGRAMDATA", "PROGRAMFILES", "PROGRAMFILES(X86)",
  "USERNAME", "COMPUTERNAME",
  // Node 言語ランタイム互換
  "NODE_OPTIONS", "NODE_PATH",
  // Python 言語ランタイム互換（pip install されたツール用）
  "PYTHONPATH", "PYTHONHOME", "VIRTUAL_ENV",
]);

/**
 * `process.env` から MCP 子プロセスに渡しても安全な変数だけをコピーする。
 * 大文字/小文字を保ったまま、ホワイトリストに一致するキーだけ通す。
 */
function buildSanitizedChildEnv(extra: Record<string, string> | undefined): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (typeof value !== "string") continue;
    if (STDIO_ENV_ALLOWLIST.has(key.toUpperCase())) result[key] = value;
  }
  if (extra !== undefined) {
    for (const [key, value] of Object.entries(extra)) {
      if (typeof value === "string") result[key] = value;
    }
  }
  return result;
}

export class StdioTransport implements McpTransport {
  private child: ChildProcessWithoutNullStreams | null = null;
  private handlers: McpTransportHandlers | null = null;
  private stdoutBuffer = "";
  private stderrBuffer = "";
  /** onClose を 1 回しか呼ばないためのガード */
  private closeNotified = false;

  constructor(private readonly options: StdioTransportOptions) {}

  private notifyClose(reason: string): void {
    if (this.closeNotified) return;
    this.closeNotified = true;
    this.handlers?.onClose(reason);
  }

  start(handlers: McpTransportHandlers): Promise<void> {
    if (this.child !== null) {
      return Promise.reject(new Error("stdio transport already started"));
    }
    this.handlers = handlers;

    // 引数の最終サニタイズ — null バイトや未文字列を含む引数を弾く
    for (const arg of this.options.args) {
      if (typeof arg !== "string" || arg.includes("\0")) {
        return Promise.reject(new Error("stdio transport: invalid argument"));
      }
    }
    if (typeof this.options.command !== "string" || this.options.command.includes("\0")) {
      return Promise.reject(new Error("stdio transport: invalid command"));
    }

    const child = spawn(this.options.command, this.options.args, {
      stdio: ["pipe", "pipe", "pipe"],
      // ホスト全環境を継承せず、ホワイトリストのみコピーする（API キー漏洩防止）
      env: buildSanitizedChildEnv(this.options.env),
      cwd: this.options.cwd,
      windowsHide: true,
      // shell:true は禁止（任意コマンドインジェクションになる）。明示的に false。
      shell: false,
    });
    this.child = child;

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");

    child.stdout.on("data", (chunk: string) => this.handleStdout(chunk));
    child.stderr.on("data", (chunk: string) => this.handleStderr(chunk));

    child.on("error", (err) => {
      handlers.onError?.(err);
    });

    child.on("exit", (code, signal) => {
      const reason = signal !== null
        ? `exited via signal ${signal}`
        : `exited with code ${code ?? "null"}`;
      this.child = null;
      this.notifyClose(reason);
    });

    return Promise.resolve();
  }

  async send(message: JsonRpcMessage): Promise<void> {
    if (this.child === null) throw new Error("stdio transport is not open");
    const payload = JSON.stringify(message) + "\n";
    return new Promise((resolve, reject) => {
      this.child!.stdin.write(payload, (err) => {
        if (err) reject(err);
        else resolve();
      });
    });
  }

  async close(): Promise<void> {
    const child = this.child;
    if (child === null) return;
    this.child = null;
    try {
      child.stdin.end();
    } catch {
      /* ignore */
    }
    // SIGTERM → 5秒待って exit しなければ SIGKILL でエスカレーション。
    // 応答しないサーバが残ると before-quit が無限待ちする。
    const exitPromise = new Promise<void>((resolve) => {
      let settled = false;
      const onExit = () => {
        if (settled) return;
        settled = true;
        resolve();
      };
      child.once("exit", onExit);
      child.once("close", onExit);
    });
    try {
      child.kill("SIGTERM");
    } catch {
      /* ignore */
    }
    await Promise.race([
      exitPromise,
      new Promise<void>((resolve) => setTimeout(resolve, 5000)),
    ]);
    // 5秒経っても生きていれば SIGKILL
    if (child.exitCode === null && child.signalCode === null) {
      try { child.kill("SIGKILL"); } catch { /* ignore */ }
    }
    // close() 呼び出し起源のクローズも notifyClose で 1 回だけ通知（exit イベントとの重複防止）
    this.notifyClose("closed by client");
  }

  isOpen(): boolean {
    return this.child !== null;
  }

  // -------------------------------------------------------------------------

  private handleStdout(chunk: string): void {
    this.stdoutBuffer += chunk;
    const lines = this.stdoutBuffer.split(/\r?\n/);
    this.stdoutBuffer = lines.pop() ?? "";
    for (const raw of lines) {
      const line = raw.trim();
      if (line.length === 0) continue;
      let parsed: JsonRpcMessage;
      try {
        parsed = JSON.parse(line) as JsonRpcMessage;
      } catch {
        // Some servers print non-JSON banners; ignore.
        continue;
      }
      this.handlers?.onMessage(parsed);
    }
  }

  private handleStderr(chunk: string): void {
    this.stderrBuffer += chunk;
    const lines = this.stderrBuffer.split(/\r?\n/);
    this.stderrBuffer = lines.pop() ?? "";
    for (const line of lines) {
      if (line.length > 0) this.handlers?.onStderr?.(line);
    }
  }
}
