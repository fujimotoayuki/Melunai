/**
 * Electron Main Process — Melunai
 *
 * All backend operations (file tools, agent controller, Ollama client,
 * JSONL logger) run here in the Node.js main process.
 *
 * The renderer (React) communicates exclusively through contextBridge IPC.
 * contextIsolation: true, nodeIntegration: false (DEC-012).
 *
 * IPC Security Design (Codex review 2026-04-29):
 *   - Workspace path owned by main after folder selection; renderer cannot override.
 *   - lfa:plan-action stores the validated plan + issues a single-use token.
 *   - lfa:run-execution accepts only the token (no actions from renderer).
 *     Main uses the stored actions, re-validates with real fs.existsSync pathExists,
 *     then executes. Token is invalidated after first use.
 *   - Log path derived from main-owned workspace; renderer cannot redirect writes.
 *
 * IPC channels:
 *   lfa:select-folder  — native folder picker; stores workspace + clears plan token
 *   lfa:fetch-models   — list Ollama models
 *   lfa:plan-action    — planning flow; stores validated plan + returns plan token
 *   lfa:list-folder    — list workspace (no renderer-supplied root)
 *   lfa:read-file      — read file (no renderer-supplied root)
 *   lfa:run-execution  — token-gated; re-validates with real pathExists; one-time use
 *   lfa:log-event      — JSONL write; log path derived from main-owned workspace
 */

import { app, BrowserWindow, dialog, ipcMain, safeStorage, shell } from "electron";
import * as path from "path";
import * as fs from "fs";
import * as crypto from "crypto";

// Backend modules — run in Node.js main process only
import { planAction } from "../agent/agentController.js";
import { replyToConversation } from "../agent/conversationController.js";
import { tryBuildLocalActionPlan } from "../agent/localActionDraft.js";
import type { OllamaClientConfig } from "../llm/index.js";
import { DEFAULT_OLLAMA_ENDPOINT, DEFAULT_TIMEOUT_MS, listModels } from "../llm/index.js";
import { createFile, createFolder, listFolder, readFile } from "../tools/index.js";
import { buildMultiFileTextContext } from "../agent/multiFileContextBuilder.js";
import { extractDocuments } from "../document/documentExtractionRunner.js";
import { prepareDocumentDraftPlan } from "../documentGeneration/documentDraftPlanner.js";
import { createApprovedDocumentDraft } from "../documentGeneration/documentGenerationRunner.js";
import { buildCorpusContextPrompt, buildCorpusFocusTerms, focusCorpusText } from "../corpus/corpusPrompt.js";
import { buildCorpusSkill, loadCorpusIndex, navigateCorpus } from "../corpus/index.js";
import type { CorpusIndex, CorpusNavigateHit } from "../corpus/index.js";
import { executeApprovedPlan } from "../agent/taskRunner.js";
import { validateActionPlanSafety } from "../agent/safetyValidator.js";
import { recordPerformanceTrace, writeJsonlEvent } from "../storage/index.js";
import type { LogEvent, TraceFields } from "../storage/index.js";
import { McpManager, OllamaSamplingBridge } from "../mcp/index.js";
import { assertSafeMcpUrl } from "../mcp/httpTransport.js";
import { setSafeStorage } from "../mcp/oauth.js";
import type {
  McpCompletionRef,
  McpLogLevel,
  McpRendererEvent,
  McpRoot,
  McpSamplingResult,
  McpServerConfig,
} from "../mcp/index.js";
import type {
  ActionPlan,
  DocumentExtractionLimits,
  DocumentGenerationPlan,
  FileAction,
  GeneratedDocumentKind,
  SourceFileLimits,
  SourceFileSelection,
} from "../types/index.js";

// ---------------------------------------------------------------------------
// Main-process state
// ---------------------------------------------------------------------------

/** Absolute path selected by the user via the native folder picker. */
let currentWorkspace: string | null = null;

/**
 * Stores the last plan that was successfully validated by the main process.
 * Cleared on folder change and consumed (one-time) on execution.
 */
interface StoredPlan {
  /** Single-use token issued with this plan. Renderer must present it to execute. */
  token: string;
  /** The validatedActions from the main-side SafetyValidator run. */
  validatedActions: FileAction[];
}

let lastStoredPlan: StoredPlan | null = null;

interface StoredDocumentGenerationPlan {
  token: string;
  plan: DocumentGenerationPlan;
}

let lastStoredDocumentGenerationPlan: StoredDocumentGenerationPlan | null = null;
let currentCanvasFolder: string | null = null;
let currentCanvasFile: string | null = null;
let currentCorpusWorkspace: string | null = null;
const chatStreamControllers = new Map<string, AbortController>();

interface StoredChatMessage {
  id: string;
  role: "user" | "assistant" | "system";
  content: string;
  timestamp: string;
  stats?: {
    tokenPerSecond: number | null;
    elapsedSeconds: number | null;
  };
}

interface StoredChatConversation {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  messages: StoredChatMessage[];
}

interface ChatHistoryDatabase {
  version: 1;
  conversations: StoredChatConversation[];
}

interface ChatConversationSummary {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  messageCount: number;
  preview: string;
}

/**
 * MCP manager — owns every configured MCP server connection.
 * Initialized lazily in `app.whenReady` because it needs `app.getPath`.
 */
let mcpManager: McpManager | null = null;

/** Issues a cryptographically random single-use plan token. */
function issuePlanToken(): string {
  return `plan-${Date.now()}-${crypto.randomBytes(8).toString("hex")}`;
}

function issueDocumentGenerationToken(): string {
  return `docgen-${Date.now()}-${crypto.randomBytes(8).toString("hex")}`;
}

function getChatHistoryPath(): string {
  return path.join(app.getPath("userData"), "chat-history.json");
}

function getCorpusWorkspaceCachePath(): string {
  return path.join(app.getPath("userData"), "corpus-workspace.json");
}

async function saveCorpusWorkspaceCache(workspaceRoot: string): Promise<void> {
  const target = getCorpusWorkspaceCachePath();
  const tmp = `${target}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`;
  try {
    await fs.promises.mkdir(path.dirname(target), { recursive: true });
    await fs.promises.writeFile(tmp, JSON.stringify({ workspaceRoot }, null, 2), {
      encoding: "utf8",
      mode: 0o600,
    });
    await fs.promises.rename(tmp, target);
  } catch {
    await fs.promises.unlink(tmp).catch(() => undefined);
    // cache failure is non-fatal
  }
}

async function loadCorpusWorkspaceCache(): Promise<string | null> {
  try {
    let raw = await fs.promises.readFile(getCorpusWorkspaceCachePath(), "utf8");
    if (raw.charCodeAt(0) === 0xfeff) raw = raw.slice(1);
    const parsed = JSON.parse(raw) as { workspaceRoot?: unknown };
    return typeof parsed.workspaceRoot === "string" ? parsed.workspaceRoot : null;
  } catch {
    return null;
  }
}

async function readChatHistory(): Promise<ChatHistoryDatabase> {
  const historyPath = getChatHistoryPath();
  try {
    let raw = await fs.promises.readFile(historyPath, "utf8");
    // UTF-8 BOM を除去（Windows のメモ帳等が付与する）
    if (raw.charCodeAt(0) === 0xfeff) raw = raw.slice(1);
    let parsed: Partial<ChatHistoryDatabase>;
    try {
      parsed = JSON.parse(raw) as Partial<ChatHistoryDatabase>;
    } catch {
      // 破損ファイルはバックアップして空で再開（ユーザーデータを失わないように温存）
      const backupPath = `${historyPath}.corrupted-${Date.now()}.bak`;
      await fs.promises.copyFile(historyPath, backupPath).catch(() => undefined);
      console.warn(`[main] chat history corrupted, backed up to ${backupPath}`);
      return { version: 1, conversations: [] };
    }
    if (parsed.version !== 1 || !Array.isArray(parsed.conversations)) {
      return { version: 1, conversations: [] };
    }
    return {
      version: 1,
      conversations: parsed.conversations
        .filter(isStoredConversation)
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)),
    };
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") {
      return { version: 1, conversations: [] };
    }
    throw cause;
  }
}

/**
 * 同一プロセス内のチャット履歴書き込みを直列化するキュー。
 * 並行 IPC 呼び出しによる lost-update / JSON 破損を防ぐ。
 */
let chatHistoryWriteQueue: Promise<void> = Promise.resolve();

async function writeChatHistory(database: ChatHistoryDatabase): Promise<void> {
  const previous = chatHistoryWriteQueue;
  const next = previous.catch(() => undefined).then(() => writeChatHistoryNow(database));
  chatHistoryWriteQueue = next.catch(() => undefined);
  await next;
}

/** 履歴ファイル全体の最大会話数。これを超えると古い会話を捨てる。 */
const CHAT_HISTORY_MAX_CONVERSATIONS = 500;

async function writeChatHistoryNow(database: ChatHistoryDatabase): Promise<void> {
  const historyPath = getChatHistoryPath();
  await fs.promises.mkdir(path.dirname(historyPath), { recursive: true });
  const sorted = database.conversations.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  // 上限超過時は古い会話を archive ファイルへ退避してから本体を切り詰める。
  // archive することで「データ消失」を最小化しつつ JSON サイズの暴走を抑える。
  let conversations = sorted;
  if (sorted.length > CHAT_HISTORY_MAX_CONVERSATIONS) {
    const keep = sorted.slice(0, CHAT_HISTORY_MAX_CONVERSATIONS);
    const archive = sorted.slice(CHAT_HISTORY_MAX_CONVERSATIONS);
    const archivePath = `${historyPath}.archive-${Date.now()}.json`;
    await fs.promises
      .writeFile(archivePath, JSON.stringify({ version: 1, conversations: archive }, null, 2), {
        encoding: "utf8",
        mode: 0o600,
      })
      .catch(() => undefined);
    conversations = keep;
  }
  const normalized: ChatHistoryDatabase = {
    version: 1,
    conversations,
  };
  // tmp + rename パターンによる atomic write。途中でクラッシュしても元ファイルは無傷。
  const tmpPath = `${historyPath}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`;
  try {
    await fs.promises.writeFile(tmpPath, JSON.stringify(normalized, null, 2), {
      encoding: "utf8",
      mode: 0o600,
    });
    await fs.promises.rename(tmpPath, historyPath);
  } catch (cause) {
    // tmp の片付け（rename 失敗時）。失敗してもログのみ。
    await fs.promises.unlink(tmpPath).catch(() => undefined);
    throw cause;
  }
}

function isStoredConversation(value: unknown): value is StoredChatConversation {
  if (typeof value !== "object" || value === null) return false;
  const conversation = value as Partial<StoredChatConversation>;
  return (
    typeof conversation.id === "string" &&
    typeof conversation.title === "string" &&
    typeof conversation.createdAt === "string" &&
    typeof conversation.updatedAt === "string" &&
    Array.isArray(conversation.messages)
  );
}

/** 1 メッセージあたりの最大文字数。LLM 出力の暴走で履歴 JSON が肥大化するのを抑える。 */
const CHAT_MESSAGE_CONTENT_LIMIT = 256 * 1024; // 256KB
/** 1 会話あたりのメッセージ最大件数。これを超えると古いものから切り詰める。 */
const CHAT_MESSAGES_PER_CONVERSATION_LIMIT = 2_000;
/** ID/timestamp 文字列の長さ上限（不正値防止） */
const CHAT_FIELD_STRING_LIMIT = 256;

function sanitizeChatMessages(value: unknown): StoredChatMessage[] {
  if (!Array.isArray(value)) return [];
  const filtered = value
    .filter((message): message is StoredChatMessage => {
      if (typeof message !== "object" || message === null) return false;
      const candidate = message as Partial<StoredChatMessage>;
      return (
        typeof candidate.id === "string" &&
        candidate.id.length > 0 &&
        candidate.id.length <= CHAT_FIELD_STRING_LIMIT &&
        (candidate.role === "user" || candidate.role === "assistant" || candidate.role === "system") &&
        typeof candidate.content === "string" &&
        typeof candidate.timestamp === "string" &&
        candidate.timestamp.length <= CHAT_FIELD_STRING_LIMIT
      );
    })
    .map((message) => ({
      id: message.id,
      role: message.role,
      // content の極端な肥大化を防ぐ（DoS / 履歴ファイル肥大化対策）
      content: message.content.length > CHAT_MESSAGE_CONTENT_LIMIT
        ? message.content.slice(0, CHAT_MESSAGE_CONTENT_LIMIT)
        : message.content,
      timestamp: message.timestamp,
      stats: message.stats,
    }));
  // 件数上限。先頭 (古いもの) を捨てる方が UX 的に許容しやすい（最新が見えるべき）。
  if (filtered.length > CHAT_MESSAGES_PER_CONVERSATION_LIMIT) {
    return filtered.slice(filtered.length - CHAT_MESSAGES_PER_CONVERSATION_LIMIT);
  }
  return filtered;
}

function summarizeConversation(conversation: StoredChatConversation): ChatConversationSummary {
  const firstUser = conversation.messages.find((message) => message.role === "user" && message.content.trim().length > 0);
  const lastText = [...conversation.messages]
    .reverse()
    .find((message) => message.content.trim().length > 0)?.content.trim() ?? "";
  return {
    id: conversation.id,
    title: conversation.title.trim().length > 0
      ? conversation.title
      : titleFromMessages(conversation.messages),
    createdAt: conversation.createdAt,
    updatedAt: conversation.updatedAt,
    messageCount: conversation.messages.length,
    preview: compactOneLine(firstUser?.content ?? lastText, 82),
  };
}

function hasUserMessage(conversation: StoredChatConversation): boolean {
  return conversation.messages.some((message) => message.role === "user" && message.content.trim().length > 0);
}

function titleFromMessages(messages: StoredChatMessage[]): string {
  const firstUser = messages.find((message) => message.role === "user" && message.content.trim().length > 0);
  if (firstUser !== undefined) {
    return compactOneLine(firstUser.content, 28);
  }
  return "新しいチャット";
}

/**
 * 会話 ID は内部生成（`chat-<ts>-<hex>`）か、再現性を持たせる為に
 * 一定の文字集合に限定する。任意文字列を受け入れるとログ偽造に繋がる。
 */
function isValidConversationId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 128 && /^[A-Za-z0-9_\-]+$/.test(value);
}

/**
 * MCP サーバ ID も会話 ID と同じく英数字限定。
 * preload→main に任意文字列が来ないことを保証して、ID 衝突や Map キー注入を防ぐ。
 */
function assertMcpId(value: unknown): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 128 || !/^[A-Za-z0-9_\-]+$/.test(value)) {
    throw new Error("Invalid MCP server id.");
  }
  return value;
}

/** chat-message ハンドラ用の標準 fail 形式。replyToConversation が返すのと同じ shape を保つ。 */
function failChatResult(code: string, userMessage: string) {
  return {
    ok: false as const,
    error: { code, message: userMessage, userMessage },
  };
}

/** IPC 引数がオブジェクトかを保証する。null は明示的に弾く。 */
function assertObject(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label}: arguments must be an object.`);
  }
  return value as Record<string, unknown>;
}

/** MCP の URI は 2KB 上限の string とし、null バイト・改行を弾く。 */
function assertReasonableUri(value: unknown): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 2048) {
    throw new Error("Invalid URI.");
  }
  if (/[\u0000-\u001F\u007F]/.test(value)) {
    throw new Error("URI contains invalid characters.");
  }
  return value;
}

function compactOneLine(text: string, maxLength: number): string {
  const compacted = text.replace(/\s+/g, " ").trim();
  if (compacted.length <= maxLength) return compacted;
  return `${compacted.slice(0, Math.max(0, maxLength - 1))}…`;
}

/**
 * Derives the JSONL log file path from the main-owned workspace.
 * Matches the formula in logBridge.getLogFilePath() for display consistency.
 */
function getLogFilePath(workspace: string): string {
  return path.join(workspace, ".local-file-agent", "session.jsonl");
}

/**
 * Real pathExists check using the filesystem.
 * Passed to SafetyValidator for accurate source/target existence checks.
 */
function realPathExists(absolutePath: string): boolean {
  try {
    return fs.existsSync(absolutePath);
  } catch {
    return false;
  }
}

/**
 * Ollama エンドポイントを解決し、loopback (127.0.0.1 / localhost / ::1) のみに制限する。
 * 任意 URL を許してしまうと、レンダラ起因の SSRF やプロンプト本文の外部送信に直結する
 * （Melunai は「ローカル完結」が価値命題のため、これは絶対防衛ライン）。
 *
 * IPv4-mapped IPv6 (`[::ffff:127.0.0.1]` 等) も解析して内部の IPv4 を判定し、
 * `[::ffff:169.254.169.254]` 等のメタデータエンドポイント詐称を遮断する。
 */
function resolveOllamaEndpoint(config: OllamaClientConfig | undefined): string {
  const raw = (config?.endpoint ?? DEFAULT_OLLAMA_ENDPOINT).replace(/\/$/, "");
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return DEFAULT_OLLAMA_ENDPOINT.replace(/\/$/, "");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return DEFAULT_OLLAMA_ENDPOINT.replace(/\/$/, "");
  }
  const host = parsed.hostname.toLowerCase();
  const v4Mapped = host.match(/^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
  const effectiveHost = v4Mapped !== null ? v4Mapped[1]! : host;
  const allowed = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);
  if (allowed.has(effectiveHost) || /^127\./.test(effectiveHost)) {
    return raw;
  }
  console.warn(
    `[main] Ollama endpoint '${parsed.hostname}' is not loopback; falling back to default.`,
  );
  return DEFAULT_OLLAMA_ENDPOINT.replace(/\/$/, "");
}

function resolveOllamaTimeoutMs(config: OllamaClientConfig | undefined): number {
  const timeoutMs = config?.timeoutMs;
  return typeof timeoutMs === "number" && Number.isFinite(timeoutMs) && timeoutMs > 0
    ? Math.floor(timeoutMs)
    : DEFAULT_TIMEOUT_MS;
}

function buildOllamaGenerateOptions(
  config: (OllamaClientConfig & { temperature?: number; contextWindow?: number }) | undefined,
): Record<string, number> {
  const options: Record<string, number> = {};
  const temperature = config?.temperature;
  if (typeof temperature === "number" && Number.isFinite(temperature)) {
    options.temperature = Math.round(Math.min(1, Math.max(0, temperature)) * 10) / 10;
  }
  const contextWindow = config?.contextWindow;
  if (typeof contextWindow === "number" && Number.isFinite(contextWindow)) {
    options.num_ctx = Math.floor(Math.min(131_072, Math.max(1024, contextWindow)));
  }
  return options;
}

function resolveOllamaSystemPrompt(
  config: (OllamaClientConfig & { systemPrompt?: string }) | undefined,
): string | undefined {
  const systemPrompt = config?.systemPrompt;
  if (typeof systemPrompt !== "string") return undefined;
  const trimmed = systemPrompt.trim();
  return trimmed.length > 0 ? trimmed.slice(0, 8192) : undefined;
}

function buildWeakModelPrompt(systemPrompt: string | undefined, userPrompt: string): string {
  if (systemPrompt === undefined) return userPrompt;
  return [
    "必ず守る会話ルール:",
    systemPrompt,
    "",
    "上の会話ルールを最優先で守って、次のユーザー入力に答えてください。",
    "",
    "ユーザー入力:",
    userPrompt,
    "",
    "回答直前の最終確認:",
    systemPrompt,
    "上の会話ルールを破らずに、回答だけを書いてください。",
  ].join("\n");
}

function applyWeakModelOutputGuard(systemPrompt: string | undefined, answer: string): string {
  if (systemPrompt === undefined || answer.trim().length === 0) return answer.trim();
  if (!shouldForceGowasuEnding(systemPrompt)) return answer.trim();
  return enforceGowasuEnding(answer);
}

function shouldForceGowasuEnding(systemPrompt: string): boolean {
  return /ごわす/.test(systemPrompt) && /(語尾|文末|末尾|最後)/.test(systemPrompt);
}

function enforceGowasuEnding(answer: string): string {
  const trimmed = answer.trim();
  if (trimmed.length === 0 || /ごわす[。！？!?\s]*$/.test(trimmed)) return trimmed;
  const withoutTrailingPunctuation = trimmed.replace(/[。！？!?]+$/u, "").trimEnd();
  if (withoutTrailingPunctuation.length === 0) return "ごわす";
  return `${withoutTrailingPunctuation}ごわす`;
}

/** Windows の予約名（拡張子付きでも禁止）— `CON.md` 等で OS 例外を起こさないため */
const WINDOWS_RESERVED_NAMES = new Set([
  "CON", "PRN", "AUX", "NUL",
  "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8", "COM9",
  "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9",
]);

function resolveCanvasPath(folder: string, targetPath: string): string {
  if (typeof folder !== "string" || folder.length === 0) {
    throw new Error("Canvas folder is not set.");
  }
  if (typeof targetPath !== "string" || targetPath.length === 0) {
    throw new Error("Canvas target path is empty.");
  }
  // null バイト・改行注入を遮断
  if (/[\u0000-\u001F\u007F]/.test(targetPath)) {
    throw new Error("Canvas target path contains invalid characters.");
  }
  // UNC / DOS デバイス（\\?\、\\.\）を拒否
  if (/^[\\/]{2}[?.]/.test(targetPath)) {
    throw new Error("Canvas target path is not allowed.");
  }

  const resolvedFolder = path.resolve(folder);
  const resolvedTarget = path.resolve(resolvedFolder, targetPath);
  const relative = path.relative(resolvedFolder, resolvedTarget);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("Canvas file must stay inside the selected folder.");
  }

  const baseName = path.basename(resolvedTarget);
  const stem = baseName.replace(/\.[^.]+$/, "").toUpperCase();
  if (WINDOWS_RESERVED_NAMES.has(stem)) {
    throw new Error("Canvas file name is reserved by the OS.");
  }

  const extension = path.extname(resolvedTarget).toLowerCase();
  if (extension !== ".md" && extension !== ".markdown") {
    throw new Error("Canvas only supports Markdown files.");
  }
  return resolvedTarget;
}

/**
 * Canvas 用フォルダ／ファイルがシンボリックリンク・ジャンクションでないか
 * 同期チェックする（lstat ベース）。リンクなら例外を投げる。
 */
async function assertNotSymlink(absolutePath: string, label: string): Promise<void> {
  try {
    const stat = await fs.promises.lstat(absolutePath);
    if (stat.isSymbolicLink()) {
      throw new Error(`${label} cannot be a symbolic link.`);
    }
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") return;
    throw cause;
  }
}

/**
 * 起動時に corpus-workspace.json から復元したパスが、自動 attach しても
 * 安全な Workspace かを検証する。
 * 攻撃者が userData 配下のキャッシュを書き換えるシナリオで、起動次回から
 * 任意ディレクトリを scan させるのを防ぐ。
 */
async function isCachedCorpusWorkspaceSafe(absolutePath: string): Promise<boolean> {
  if (typeof absolutePath !== "string" || absolutePath.length === 0) return false;
  if (!path.isAbsolute(absolutePath)) return false;
  try {
    const stat = await fs.promises.lstat(absolutePath);
    if (stat.isSymbolicLink()) return false;
    if (!stat.isDirectory()) return false;
    return true;
  } catch {
    return false;
  }
}

function defaultCanvasFilename(): string {
  const stamp = new Date()
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\..+$/, "")
    .replace("T", "-");
  return `melunai-canvas-${stamp}.md`;
}

function compactMarkdownForCanvas(markdown: string): string {
  const normalized = markdown.replace(/\r\n/g, "\n").replace(/\r/g, "\n").trim();
  const maxChars = 12_000;
  if (normalized.length <= maxChars) return normalized;

  const headChars = 7_000;
  const tailChars = 4_000;
  return [
    normalized.slice(0, headChars),
    "\n\n<!-- Middle of the existing Markdown was omitted to keep local generation fast. Preserve the document intent and rebuild coherently. -->\n\n",
    normalized.slice(-tailChars),
  ].join("");
}

type CanvasMarkdownEditMode = "append" | "selection" | "replace";

function buildCanvasMarkdownPrompt(args: {
  userInstruction: string;
  currentMarkdown: string;
  targetMarkdown?: string;
  editMode?: CanvasMarkdownEditMode;
}): string {
  const current = compactMarkdownForCanvas(args.currentMarkdown);
  const target = compactMarkdownForCanvas(args.targetMarkdown ?? "");
  const hasCurrent = current.length > 0;
  const mode = args.editMode ?? "replace";
  const taskLine =
    mode === "append"
      ? "Return only the Markdown fragment to append to the document."
      : mode === "selection"
        ? "Return only the rewritten Markdown for the selected range."
        : "Return only the final Markdown document body.";

  return [
    "You are Melunai Canvas, a Markdown document writer.",
    taskLine,
    "Do not wrap the result in code fences.",
    "Do not explain what you did.",
    "Use clear Markdown headings, lists, and paragraphs.",
    "Keep the language and tone requested by the user.",
    "",
    "User instruction:",
    args.userInstruction.trim(),
    "",
    hasCurrent ? "Current Markdown document:" : "Current Markdown document: (empty)",
    hasCurrent ? current : "",
    "",
    target.length > 0 ? "Target Markdown range:" : "",
    target.length > 0 ? target : "",
    "",
    mode === "append" ? "Markdown fragment to append:" : mode === "replace" ? "Final Markdown:" : "Rewritten Markdown range:",
  ].join("\n");
}

function buildOllamaStats(parsed: {
  eval_count?: number;
  eval_duration?: number;
  total_duration?: number;
}): { tokenPerSecond: number | null; elapsedSeconds: number | null } {
  const evalCount = typeof parsed.eval_count === "number" ? parsed.eval_count : null;
  const evalDurationNs = typeof parsed.eval_duration === "number" ? parsed.eval_duration : null;
  const totalDurationNs = typeof parsed.total_duration === "number" ? parsed.total_duration : evalDurationNs;
  const elapsedSeconds = totalDurationNs === null ? null : totalDurationNs / 1_000_000_000;
  const tokenPerSecond =
    evalCount === null || evalDurationNs === null || evalDurationNs <= 0
      ? null
      : evalCount / (evalDurationNs / 1_000_000_000);
  return {
    tokenPerSecond,
    elapsedSeconds,
  };
}

async function buildCorpusAugmentedPrompt(args: {
  userInstruction: string;
  useCorpus?: boolean;
}): Promise<{
  prompt: string;
  contextSummary: string | null;
  unavailableReason: "no_corpus_workspace" | "corpus_missing" | "corpus_empty" | null;
}> {
  if (args.useCorpus !== true) {
    return { prompt: args.userInstruction, contextSummary: null, unavailableReason: null };
  }

  if (currentCorpusWorkspace === null) {
    return { prompt: args.userInstruction, contextSummary: null, unavailableReason: "no_corpus_workspace" };
  }

  const index = await loadCorpusIndex(currentCorpusWorkspace);
  if (index === null) {
    return { prompt: args.userInstruction, contextSummary: null, unavailableReason: "corpus_missing" };
  }

  if (index.documents.length === 0) {
    return { prompt: args.userInstruction, contextSummary: null, unavailableReason: "corpus_empty" };
  }

  const navigation = await navigateCorpus({
    workspaceRoot: currentCorpusWorkspace,
    query: args.userInstruction,
    maxHits: 6,
  });

  const effectiveHits = navigation.hits.length > 0
    ? navigation.hits.slice(0, 2)
    : index.documents.slice(0, 2).map((document): CorpusNavigateHit => ({
      kind: "document",
      score: 0,
      title: document.title,
      path: document.path,
      summary: document.preview,
      keywords: document.keywords,
    }));

  const excerpts = await readCorpusHitExcerpts({
    workspaceRoot: currentCorpusWorkspace,
    index,
    hits: effectiveHits,
    query: args.userInstruction,
    maxCharsTotal: 2_800,
  });

  const contextSummary = navigation.hits.length > 0
    ? navigation.hits.slice(0, 4).map((hit) => `${hit.kind}:${hit.title}`).join(", ")
    : `資料検索: 明確な一致なし / 先頭${effectiveHits.length}件を参照`;

  const prompt = buildCorpusContextPrompt({
    userInstruction: args.userInstruction,
    excerpts,
  });

  return { prompt, contextSummary, unavailableReason: null };
}

async function readCorpusHitExcerpts(args: {
  workspaceRoot: string;
  index: CorpusIndex;
  hits: CorpusNavigateHit[];
  query: string;
  maxCharsTotal: number;
}): Promise<string[]> {
  const excerpts: string[] = [];
  let remaining = args.maxCharsTotal;
  const seen = new Set<string>();
  const focusTerms = buildCorpusFocusTerms(args.query);

  for (const hit of args.hits) {
    if (remaining <= 0) break;
    const relativePath = resolveCorpusHitReadPath(args.index, hit);
    if (relativePath === null || seen.has(relativePath)) continue;
    seen.add(relativePath);

    const content = await readWorkspaceRelativeText(args.workspaceRoot, relativePath, Math.min(remaining * 2, 4_000));
    if (content === null || content.trim().length === 0) continue;
    const focused = focusCorpusText(content, focusTerms, Math.min(remaining, 1_250));
    if (focused.trim().length === 0) continue;
    remaining -= focused.length;
    excerpts.push([
      `### ${hit.title}`,
      `Source: ${relativePath}`,
      focused,
    ].join("\n"));
  }

  return excerpts;
}

function resolveCorpusHitReadPath(index: CorpusIndex, hit: CorpusNavigateHit): string | null {
  if (hit.kind === "skill") return hit.path;
  const document = index.documents.find((candidate) => candidate.path === hit.path);
  return document?.skillPath ?? hit.path;
}

/**
 * Corpus index 由来の relativePath は、攻撃者が事前に細工した index.json を
 * 取り込ませると `..\..\..\Users\victim\secret.txt` のようなパスを仕込めるため、
 * 多層ガードで検証する。
 *  1. 相対パス境界チェック（path.relative ベース）
 *  2. POSIX/Windows 両方の絶対パス拒否
 *  3. シンボリックリンク・ジャンクション拒否（lstat による検査）
 *  4. realpath 取得後、ワークスペース実体配下にあるか再確認
 *  5. 拡張子・サイズ上限の強制
 */
async function readWorkspaceRelativeText(
  workspaceRoot: string,
  relativePath: string,
  maxChars: number,
): Promise<string | null> {
  if (typeof relativePath !== "string" || relativePath.length === 0) return null;
  // null バイト・改行による解釈ずらし攻撃を遮断
  if (/[\u0000-\u001F\u007F]/.test(relativePath)) return null;
  // POSIX/Windows 両方の絶対パスを拒否
  if (path.posix.isAbsolute(relativePath) || path.win32.isAbsolute(relativePath)) return null;

  const absoluteRoot = path.resolve(workspaceRoot);
  const absoluteTarget = path.resolve(absoluteRoot, relativePath);
  const relative = path.relative(absoluteRoot, absoluteTarget);
  if (relative.startsWith("..") || path.isAbsolute(relative)) return null;

  try {
    // シンボリックリンク・ジャンクション経由の脱出を防ぐため lstat で検査
    const lst = await fs.promises.lstat(absoluteTarget);
    if (lst.isSymbolicLink()) return null;
    if (!lst.isFile()) return null;
    // 巨大ファイル（デコード時のメモリ使用量を抑制）
    if (lst.size > 4 * 1024 * 1024) return null; // 4MB 上限

    // realpath で最終解決し、それでもワークスペース配下にあることを確認
    const realRoot = await fs.promises.realpath(absoluteRoot);
    const realTarget = await fs.promises.realpath(absoluteTarget);
    const realRelative = path.relative(realRoot, realTarget);
    if (realRelative.startsWith("..") || path.isAbsolute(realRelative)) return null;

    let raw = await fs.promises.readFile(absoluteTarget, "utf8");
    if (raw.charCodeAt(0) === 0xfeff) raw = raw.slice(1); // BOM 除去
    return raw.replace(/\r\n/g, "\n").replace(/\r/g, "\n").slice(0, maxChars);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Chat attempt helper for the Timeout Fallback Controller (Workbench v2 §38)
// ---------------------------------------------------------------------------

interface RunChatAttemptArgs {
  route: string;
  light: boolean;
  previews: Array<{ path: string; content: string; truncated: boolean }>;
  userInstruction: string;
  model: string;
  ollamaConfig?: OllamaClientConfig;
  workspace: { rootPath: string; displayName: string } | null;
  logPath: string | null;
  sessionId?: string;
  fallbackUsed: boolean;
  fallbackKind: string | null;
}

type ChatAttemptOutcome =
  | { kind: "ok"; result: { ok: true; data: string } }
  | { kind: "error"; result: { ok: false; error: { code: string; message: string; userMessage?: string } } }
  | { kind: "timeout"; result: { ok: false; error: { code: string; message: string } } };

async function runChatAttempt(args: RunChatAttemptArgs): Promise<ChatAttemptOutcome> {
  const start = Date.now();
  const result = await replyToConversation({
    userInstruction: args.userInstruction,
    model: args.model,
    workspace: args.workspace,
    ollamaConfig: args.ollamaConfig,
    filePreviews: args.previews,
    light: args.light,
  });
  const elapsedMs = Date.now() - start;

  await recordPerformanceTrace(
    args.logPath,
    args.sessionId,
    args.workspace?.rootPath,
    {
      route: args.route,
      llmCalled: result.meta.llmCalled,
      model: args.model,
      inputChars: result.meta.promptChars,
      estimatedInputTokens: Math.ceil(result.meta.promptChars / 4),
      contextFileCount: result.meta.contextFileCount,
      workspaceTreeEntries: 0, // chat path never serializes the tree
      elapsedMs,
      success: result.ok,
      errorCode: result.ok ? null : result.error.code,
      fallbackUsed: args.fallbackUsed,
      fallbackKind: args.fallbackKind,
      stageTimings: {
        promptBuildMs: result.meta.promptBuildMs,
        llmMs: result.meta.llmMs,
      },
    },
  );

  if (result.ok) {
    return { kind: "ok", result: { ok: true, data: result.data } };
  }
  if (result.error.code === "ollama_timeout") {
    return { kind: "timeout", result: { ok: false, error: { code: result.error.code, message: result.error.message } } };
  }
  return { kind: "error", result: { ok: false, error: { code: result.error.code, message: result.error.message } } };
}

/**
 * Final non-LLM template fallback used by the chat-message handler when both
 * the heavy and light Ollama attempts time out (or when a reference-free
 * light attempt itself times out).
 *
 * Always emits a `performance_trace` with `fallbackKind: "template"` so the
 * operator can correlate the user-facing fallback with the underlying
 * timeouts that came before it.
 */
async function finishWithTemplateFallback(
  logPath: string | null,
  sessionId: string | undefined,
): Promise<{ ok: true; data: string }> {
  await recordPerformanceTrace(logPath, sessionId, currentWorkspace ?? undefined, {
    route: "chat_fallback_template",
    llmCalled: false,
    model: null,
    inputChars: 0,
    estimatedInputTokens: 0,
    contextFileCount: 0,
    workspaceTreeEntries: 0,
    elapsedMs: 0,
    success: true,
    errorCode: null,
    fallbackUsed: true,
    fallbackKind: "template",
  });
  return {
    ok: true,
    data:
      "応答に時間がかかったので、軽い回答に切り替えました。"
      + "もう少し短い指示か、参照ファイルを外して試してみてください。",
  };
}

// ---------------------------------------------------------------------------
// Window management
// ---------------------------------------------------------------------------

let mainWindow: BrowserWindow | null = null;

const VITE_DEV_URL = "http://localhost:1420";

function createWindow(): void {
  // Resolve icon path: dev = repo root /build/icon.png, packaged = app resources.
  const iconPath = app.isPackaged
    ? path.join(process.resourcesPath, "build", "icon.png")
    : path.join(app.getAppPath(), "build", "icon.png");

  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    title: "Melunai",
    icon: iconPath,
    backgroundColor: "#1D1D1F",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,        // required by DEC-012
      nodeIntegration: false,        // required by DEC-012
      sandbox: true,                 // preload は ipcRenderer/contextBridge のみで足りるため有効化
      webSecurity: true,             // CORS / file:// 制限を強制（明示）
      allowRunningInsecureContent: false, // mixed content 禁止
      experimentalFeatures: false,   // Web Platform 実験機能の混入を防ぐ
      navigateOnDragDrop: false,     // ドラッグ＆ドロップでのナビ遷移禁止
      spellcheck: true,
    },
  });

  if (!app.isPackaged) {
    void mainWindow.loadURL(VITE_DEV_URL);
    mainWindow.webContents.openDevTools();
  } else {
    void mainWindow.loadFile(
      path.join(app.getAppPath(), "dist", "index.html"),
    );
  }

  mainWindow.on("closed", () => {
    mainWindow = null;
  });

  // ---------------------------------------------------------------------------
  // Navigation / external link safety (Electron Security Checklist #11, #12, #13)
  // ---------------------------------------------------------------------------
  // すべての window.open() を抑制し、安全と判定した URL のみを OS の既定ブラウザで開く。
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (isSafeExternalUrl(url)) {
      void shell.openExternal(url);
    }
    return { action: "deny" };
  });

  // メインウィンドウ自身の遷移を、開発時の Vite dev URL 以外すべて拒否。
  // file:// 経由の任意ローカルファイル読み込みを完全に防ぐ。
  mainWindow.webContents.on("will-navigate", (event, url) => {
    if (!app.isPackaged && url.startsWith(VITE_DEV_URL)) return;
    event.preventDefault();
  });

  // webview の埋め込みも一切許可しない。
  mainWindow.webContents.on("will-attach-webview", (event) => {
    event.preventDefault();
  });
}

/**
 * shell.openExternal 用の URL ホワイトリスト。
 * http/https/mailto のみ許可し、file://, javascript:, ms-cd-pinned: などの
 * カスタムスキーム経由のハイジャックを防ぐ。
 */
function isSafeExternalUrl(rawUrl: string): boolean {
  try {
    const u = new URL(rawUrl);
    return ["http:", "https:", "mailto:"].includes(u.protocol);
  } catch {
    return false;
  }
}

/**
 * MCP サーバ設定入力の最低限のランタイム検証。
 * preload は unknown を素通りで渡してくるため、ここで必ず型と境界を確認する。
 */
function validateMcpServerInput(input: unknown): asserts input is { name?: unknown; transport: unknown } {
  if (input === null || typeof input !== "object") {
    throw new Error("MCP server config must be an object.");
  }
  const cfg = input as { name?: unknown; transport?: unknown };
  if (cfg.transport === null || typeof cfg.transport !== "object") {
    throw new Error("MCP server transport must be an object.");
  }
  const tr = cfg.transport as { kind?: unknown; command?: unknown; args?: unknown; url?: unknown };
  if (tr.kind !== "stdio" && tr.kind !== "http") {
    throw new Error("MCP server transport.kind must be 'stdio' or 'http'.");
  }
  if (tr.kind === "stdio") {
    if (typeof tr.command !== "string" || tr.command.length === 0) {
      throw new Error("stdio transport requires a non-empty command string.");
    }
    if (tr.command.length > 1024) {
      throw new Error("stdio transport command is suspiciously long.");
    }
    if (tr.args !== undefined && !Array.isArray(tr.args)) {
      throw new Error("stdio transport args must be an array of strings.");
    }
    if (Array.isArray(tr.args)) {
      for (const a of tr.args) {
        if (typeof a !== "string") throw new Error("stdio transport args must all be strings.");
        if (a.length > 4096) throw new Error("stdio transport arg is suspiciously long.");
      }
    }
  }
  if (tr.kind === "http") {
    if (typeof tr.url !== "string" || tr.url.length === 0) {
      throw new Error("http transport requires a non-empty url string.");
    }
    // SSRF / metadata エンドポイント拒否は httpTransport 側で再検証されるが先行チェック
    try {
      assertSafeMcpUrl(tr.url);
    } catch (cause) {
      throw new Error(
        `http transport url is not allowed: ${cause instanceof Error ? cause.message : String(cause)}`,
      );
    }
  }
}

/**
 * ユーザー確認ダイアログ用のサマリー文字列を作る。
 * stdio なら command + args を、http なら URL を可視化する。
 */
function describeMcpServerForUser(input: { name?: unknown; transport: unknown }): string {
  const name = typeof input.name === "string" && input.name.trim().length > 0 ? input.name.trim() : "(無題)";
  const tr = input.transport as { kind: string; command?: string; args?: string[]; url?: string };
  if (tr.kind === "stdio") {
    const argsLine = Array.isArray(tr.args) && tr.args.length > 0 ? `\n引数: ${tr.args.join(" ")}` : "";
    return `名前: ${name}\n種別: stdio (子プロセス起動)\n実行ファイル: ${tr.command ?? "(unset)"}${argsLine}`;
  }
  return `名前: ${name}\n種別: HTTP\nURL: ${tr.url ?? "(unset)"}`;
}

/**
 * 追加/変更前にユーザーへネイティブ確認ダイアログを出す。
 * メインウィンドウが無い場合は安全側で false を返す。
 */
async function confirmMcpServerWithUser(title: string, message: string): Promise<boolean> {
  if (mainWindow === null || mainWindow.isDestroyed()) return false;
  const result = await dialog.showMessageBox(mainWindow, {
    type: "warning",
    buttons: ["キャンセル", "許可"],
    defaultId: 0,
    cancelId: 0,
    title,
    message: "MCPサーバの追加・変更が要求されました。内容を確認してください。",
    detail: `${message}\n\n内容に覚えがない場合は必ずキャンセルしてください。`,
    noLink: true,
  });
  return result.response === 1;
}

// ---------------------------------------------------------------------------
// App lifecycle
// ---------------------------------------------------------------------------

app.whenReady().then(() => {
  // OAuth トークンを OS 鍵束で暗号化保存できるよう safeStorage を注入。
  // safeStorage は app.whenReady 後でないと isEncryptionAvailable が呼べない。
  setSafeStorage({
    isEncryptionAvailable: () => safeStorage.isEncryptionAvailable(),
    encryptString: (s) => safeStorage.encryptString(s),
    decryptString: (b) => safeStorage.decryptString(b),
  });
  mcpManager = new McpManager(app.getPath("userData"), {
    openBrowser: (url) => {
      // OAuth フロー以外でも安全な URL のみ開く（http/https/mailto）
      if (isSafeExternalUrl(url)) {
        void shell.openExternal(url);
      } else {
        console.warn("[main] Blocked unsafe URL via openBrowser:", url);
      }
    },
  });
  // Forward every MCP event to the focused renderer. Renderer subscribes by
  // listening for "lfa:mcp-event" via the preload bridge.
  mcpManager.subscribe((event: McpRendererEvent) => {
    if (mainWindow !== null && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send("lfa:mcp-event", event);
    }
  });
  // Default to "ask" with a local Ollama bridge as the fallback fulfiller.
  // The renderer can change the policy at runtime via lfa:mcp-set-sampling-policy.
  mcpManager.setSamplingBridge(
    new OllamaSamplingBridge({
      endpoint: DEFAULT_OLLAMA_ENDPOINT,
      defaultModel: "llama3.2",
      maxTokensCap: 4096,
    }),
  );
  mcpManager.setSamplingPolicy("ask");
  registerIpcHandlers();
  createWindow();

  // Auto-connect any servers the user has marked enabled. Errors are kept on
  // the per-server status; they don't block app startup.
  void mcpManager.autoConnectEnabled();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
}).catch((cause: unknown) => {
  // 起動シーケンスの予期せぬ例外（safeStorage 取得失敗、userData 不可、McpManager 初期化等）。
  // unhandled rejection で IPC 未登録のままウィンドウを残すと、レンダラからの全呼び出しが
  // "No handler registered" で失敗してユーザーが原因不明のフリーズ画面を見る。
  // ここで dialog を出し、安全側で quit する。
  console.error("[main] Fatal error during app startup:", cause);
  try {
    dialog.showErrorBox(
      "Melunaiの起動に失敗しました",
      cause instanceof Error ? cause.message : String(cause),
    );
  } catch {
    /* dialog すら使えない状況なら諦めて終了 */
  }
  app.exit(1);
});

app.on("before-quit", async (event) => {
  if (mcpManager !== null) {
    event.preventDefault();
    const manager = mcpManager;
    mcpManager = null;
    try {
      // タイムアウト付き shutdown。応答しない MCP サーバでアプリ終了がハングしないよう
      // 5 秒以内に応答がなければ強制続行する。
      await Promise.race([
        manager.shutdownAll(),
        new Promise<void>((resolve) => setTimeout(resolve, 5000)),
      ]);
    } catch (cause) {
      console.warn("[main] MCP shutdown raised, continuing quit:", cause);
    } finally {
      app.quit();
    }
  }
});

app.on("window-all-closed", () => {
  app.quit();
});

// ---------------------------------------------------------------------------
// IPC handlers
// ---------------------------------------------------------------------------

function registerIpcHandlers(): void {

  // -- lfa:chat-history-* ------------------------------------------------------
  // Local desktop chat history. Stored under Electron userData so it survives
  // reloads and app restarts without exposing filesystem paths to the renderer.
  ipcMain.handle("lfa:chat-history-list", async () => {
    const database = await readChatHistory();
    return {
      ok: true,
      data: database.conversations.filter(hasUserMessage).map(summarizeConversation),
    };
  });

  ipcMain.handle("lfa:chat-history-create", async (_event, args?: { messages?: unknown }) => {
    const now = new Date().toISOString();
    const messages = sanitizeChatMessages(args?.messages ?? []);
    const conversation: StoredChatConversation = {
      id: `chat-${Date.now()}-${crypto.randomBytes(5).toString("hex")}`,
      title: titleFromMessages(messages),
      createdAt: now,
      updatedAt: now,
      messages,
    };
    const database = await readChatHistory();
    database.conversations.unshift(conversation);
    await writeChatHistory(database);
    return { ok: true, data: conversation };
  });

  ipcMain.handle("lfa:chat-history-load", async (_event, id: unknown) => {
    if (!isValidConversationId(id)) {
      return { ok: false, error: { code: "invalid_id", message: "Invalid conversation id." } };
    }
    const database = await readChatHistory();
    const conversation = database.conversations.find((item) => item.id === id);
    if (conversation === undefined) {
      return { ok: false, error: { code: "conversation_not_found", message: "Conversation not found." } };
    }
    return { ok: true, data: conversation };
  });

  ipcMain.handle(
    "lfa:chat-history-save",
    async (_event, args: unknown) => {
      if (
        args === null || typeof args !== "object" ||
        !isValidConversationId((args as { id?: unknown }).id)
      ) {
        return { ok: false, error: { code: "invalid_args", message: "Invalid save arguments." } };
      }
      const a = args as { id: string; messages: unknown; title?: unknown };
      const messages = sanitizeChatMessages(a.messages);
      const database = await readChatHistory();
      const existingIndex = database.conversations.findIndex((item) => item.id === a.id);
      const now = new Date().toISOString();
      const existing = existingIndex >= 0 ? database.conversations[existingIndex] : null;
      const explicitTitle = typeof a.title === "string"
        ? a.title.replace(/[\r\n\t]/g, " ").trim().slice(0, 256)
        : "";
      const conversation: StoredChatConversation = {
        id: a.id,
        title: explicitTitle.length > 0
          ? explicitTitle
          : existing?.title.trim().length ? existing.title : titleFromMessages(messages),
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
        messages,
      };
      if (existingIndex >= 0) {
        database.conversations[existingIndex] = conversation;
      } else {
        database.conversations.unshift(conversation);
      }
      await writeChatHistory(database);
      return { ok: true, data: summarizeConversation(conversation) };
    },
  );

  ipcMain.handle("lfa:chat-history-rename", async (_event, args: unknown) => {
    if (args === null || typeof args !== "object") {
      return { ok: false, error: { code: "invalid_args", message: "Invalid rename arguments." } };
    }
    const a = args as { id?: unknown; title?: unknown };
    if (!isValidConversationId(a.id)) {
      return { ok: false, error: { code: "invalid_id", message: "Invalid conversation id." } };
    }
    if (typeof a.title !== "string") {
      return { ok: false, error: { code: "invalid_title", message: "Title must be a string." } };
    }
    // 改行・タブを除去し 256 文字でクランプ（ログ偽造・UI破綻防止）
    const title = a.title.replace(/[\r\n\t]/g, " ").trim().slice(0, 256);
    if (title.length === 0) {
      return { ok: false, error: { code: "empty_title", message: "Title must not be empty." } };
    }
    const database = await readChatHistory();
    const existingIndex = database.conversations.findIndex((item) => item.id === a.id);
    if (existingIndex < 0) {
      return { ok: false, error: { code: "conversation_not_found", message: "Conversation not found." } };
    }
    const existing = database.conversations[existingIndex];
    if (existing === undefined) {
      return { ok: false, error: { code: "conversation_not_found", message: "Conversation not found." } };
    }
    const conversation: StoredChatConversation = {
      ...existing,
      title,
      updatedAt: new Date().toISOString(),
    };
    database.conversations[existingIndex] = conversation;
    await writeChatHistory(database);
    return { ok: true, data: summarizeConversation(conversation) };
  });

  ipcMain.handle("lfa:chat-history-delete", async (_event, id: unknown) => {
    if (!isValidConversationId(id)) {
      return { ok: false, error: { code: "invalid_id", message: "Invalid conversation id." } };
    }
    const database = await readChatHistory();
    const nextConversations = database.conversations.filter((item) => item.id !== id);
    const deleted = nextConversations.length !== database.conversations.length;
    database.conversations = nextConversations;
    await writeChatHistory(database);
    return {
      ok: true,
      data: {
        deleted,
        nextId: database.conversations.find(hasUserMessage)?.id ?? null,
      },
    };
  });

  // -- lfa:select-folder -------------------------------------------------------
  // Opens a native folder picker. Stores the selected path in main-process state.
  // Clears the stored plan (workspace changed → old token is invalid).
  // NOTE: lfa:select-folder / lfa:plan-action / lfa:list-folder / lfa:read-file /
  // lfa:create-workspace-entry / lfa:read-multiple-files / lfa:read-documents /
  // lfa:prepare-document-draft / lfa:create-document-draft / lfa:run-execution /
  // lfa:log-event / lfa:local-action-draft / lfa:record-trace は
  // chat-only リセット移行で preload から外したため、攻撃面削減のため main 側からも削除済み。
  // 将来「ワークスペース付きエージェントモード」を再導入する際は、preload と一緒に復活させること。

  // -- lfa:fetch-models --------------------------------------------------------
  ipcMain.handle(
    "lfa:fetch-models",
    async (_event, config?: { endpoint?: string }) => {
      return listModels(config);
    },
  );

  // -- lfa:plan-action は chat-only リセットで preload から削除済み。
  //    main 側ハンドラも攻撃面削減のため除去。

  // -- lfa:chat-message --------------------------------------------------------
  // Normal conversation. This does not parse or execute ActionPlans.
  // Wrapped in PerformanceTrace + Timeout Fallback Controller (Workbench v2 §34/§38).
  //
  // Routing (TASK-041 fix 1):
  //   • No previews supplied → start LIGHT (route "chat_light"). Falls back to
  //     template only if the light prompt itself times out. Heavy is never
  //     tried because there's nothing heavy to send.
  //   • Previews supplied    → start HEAVY (route "chat"). On ollama_timeout,
  //     fall through to light (no previews), then to template.
  //
  // Each attempt writes its own performance_trace entry so the operator can
  // see the route + fallback ladder in the log.
  ipcMain.handle(
    "lfa:chat-message",
    async (
      _event,
      rawArgs: unknown,
    ) => {
      // ランタイム入力検証 — 全フィールドを実行時にチェックする。
      // 特に ollamaConfig.endpoint は loopback 強制ガードを下層に渡る前にここで正規化する。
      if (rawArgs === null || typeof rawArgs !== "object") {
        return failChatResult("invalid_args", "Invalid chat-message arguments.");
      }
      const a = rawArgs as {
        userInstruction?: unknown;
        model?: unknown;
        ollamaConfig?: unknown;
        filePreviews?: unknown;
        sessionId?: unknown;
      };
      if (typeof a.userInstruction !== "string" || a.userInstruction.length === 0 || a.userInstruction.length > 64_000) {
        return failChatResult("invalid_user_instruction", "userInstruction must be a 1-64000 char string.");
      }
      if (typeof a.model !== "string" || a.model.length === 0 || a.model.length > 256) {
        return failChatResult("invalid_model", "model must be a 1-256 char string.");
      }
      const sessionId = typeof a.sessionId === "string" && /^[A-Za-z0-9_\-]{1,128}$/.test(a.sessionId)
        ? a.sessionId
        : undefined;
      // ollamaConfig.endpoint は必ず loopback 強制で正規化（外部送信防止）
      const safeOllamaConfig: OllamaClientConfig | undefined = a.ollamaConfig === undefined
        ? undefined
        : {
            endpoint: resolveOllamaEndpoint(a.ollamaConfig as OllamaClientConfig),
            timeoutMs: resolveOllamaTimeoutMs(a.ollamaConfig as OllamaClientConfig),
          };
      const previewsRaw = Array.isArray(a.filePreviews) ? a.filePreviews : [];
      const previews: Array<{ path: string; content: string; truncated: boolean }> = [];
      for (const p of previewsRaw.slice(0, 16)) {
        if (p === null || typeof p !== "object") continue;
        const pp = p as { path?: unknown; content?: unknown; truncated?: unknown };
        if (typeof pp.path !== "string" || pp.path.length === 0 || pp.path.length > 2048) continue;
        if (typeof pp.content !== "string" || pp.content.length > 256_000) continue;
        previews.push({
          path: pp.path,
          content: pp.content,
          truncated: typeof pp.truncated === "boolean" ? pp.truncated : false,
        });
      }
      const args = {
        userInstruction: a.userInstruction,
        model: a.model,
        ollamaConfig: safeOllamaConfig,
        filePreviews: previews,
        sessionId,
      };

      const workspace = currentWorkspace === null
        ? null
        : { rootPath: currentWorkspace, displayName: path.basename(currentWorkspace) };
      const logPath = currentWorkspace === null ? null : getLogFilePath(currentWorkspace);
      const hasPreviews = previews.length > 0;

      // ---- Reference-free chat: skip heavy entirely (TASK-041 fix 1) ----
      if (!hasPreviews) {
        const lightFirst = await runChatAttempt({
          route: "chat_light",
          light: true,
          previews: [],
          userInstruction: args.userInstruction,
          model: args.model,
          ollamaConfig: args.ollamaConfig,
          workspace,
          logPath,
          sessionId: args.sessionId,
          fallbackUsed: false,
          fallbackKind: null,
        });
        if (lightFirst.kind !== "timeout") return lightFirst.result;

        // Light path itself timed out → template fallback (still no Ollama).
        return finishWithTemplateFallback(logPath, args.sessionId);
      }

      // ---- Reference-bearing chat: heavy → light → template ladder ----
      const heavy = await runChatAttempt({
        route: "chat",
        light: false,
        previews,
        userInstruction: args.userInstruction,
        model: args.model,
        ollamaConfig: args.ollamaConfig,
        workspace,
        logPath,
        sessionId: args.sessionId,
        fallbackUsed: false,
        fallbackKind: null,
      });
      if (heavy.kind !== "timeout") return heavy.result;

      const light = await runChatAttempt({
        route: "chat_fallback_light",
        light: true,
        previews: [],
        userInstruction: args.userInstruction,
        model: args.model,
        ollamaConfig: args.ollamaConfig,
        workspace,
        logPath,
        sessionId: args.sessionId,
        fallbackUsed: true,
        fallbackKind: "light_prompt",
      });
      if (light.kind !== "timeout") return light.result;

      return finishWithTemplateFallback(logPath, args.sessionId);
    },
  );

  // -- lfa:chat-message-stream ------------------------------------------------
  // Chat-only fast path. Uses Ollama /api/generate with the user's text as the
  // raw prompt, no system/control message, so it behaves much closer to
  // `ollama run <model> "<prompt>"` than the older /api/chat wrapper.
  ipcMain.handle(
    "lfa:chat-message-stream",
    async (
      event,
      rawArgs: unknown,
    ) => {
      // 入力検証 — args が壊れている時は何も流さず即終了。
      // 注意: requestId が無いと event を返す経路がないため、early return する。
      if (rawArgs === null || typeof rawArgs !== "object") return;
      const a = rawArgs as Record<string, unknown>;
      const requestId = a["requestId"];
      if (typeof requestId !== "string" || requestId.length === 0 || requestId.length > 256) {
        return;
      }
      // sender が破棄済みなら何もしない（unmount 後の race）
      if (event.sender.isDestroyed()) return;

      const send = (payload: Record<string, unknown>) => {
        if (event.sender.isDestroyed()) return;
        event.sender.send("lfa:chat-stream-event", {
          requestId,
          ...payload,
        });
      };

      // 必須フィールド検証 — 失敗時は error イベントを送って listener をクリーンに終了させる
      if (typeof a["userInstruction"] !== "string" || (a["userInstruction"] as string).length === 0
          || (a["userInstruction"] as string).length > 64_000) {
        send({ type: "error", code: "invalid_args", message: "userInstruction must be a 1-64000 char string." });
        return;
      }
      if (typeof a["model"] !== "string" || (a["model"] as string).length === 0
          || (a["model"] as string).length > 256) {
        send({ type: "error", code: "invalid_args", message: "model must be a 1-256 char string." });
        return;
      }
      const ollamaConfig = (typeof a["ollamaConfig"] === "object" && a["ollamaConfig"] !== null
        ? a["ollamaConfig"] as OllamaClientConfig & {
            systemPrompt?: string;
            temperature?: number;
            contextWindow?: number;
          }
        : undefined);
      const useCorpus = a["useCorpus"] === true;

      const args = {
        requestId,
        userInstruction: a["userInstruction"] as string,
        model: a["model"] as string,
        ollamaConfig,
        useCorpus,
      };

      const controller = new AbortController();
      chatStreamControllers.set(args.requestId, controller);
      const timer = setTimeout(() => controller.abort(), resolveOllamaTimeoutMs(args.ollamaConfig));

      try {
        const corpusPrompt = await buildCorpusAugmentedPrompt({
          userInstruction: args.userInstruction,
          useCorpus: args.useCorpus,
        });
        if (corpusPrompt.unavailableReason !== null) {
          send({
            type: "error",
            code: corpusPrompt.unavailableReason,
            message: "Corpus reference is not ready.",
          });
          return;
        }
        if (corpusPrompt.contextSummary !== null) {
          send({
            type: "context",
            source: "corpus2skill",
            summary: corpusPrompt.contextSummary,
          });
        }

        const systemPrompt = resolveOllamaSystemPrompt(args.ollamaConfig);
        const prompt = buildWeakModelPrompt(systemPrompt, corpusPrompt.prompt);
        const generateOptions = buildOllamaGenerateOptions(args.ollamaConfig);
        send({
          type: "settings",
          model: args.model,
          hasSystemPrompt: systemPrompt !== undefined,
          systemPromptChars: systemPrompt?.length ?? 0,
          temperature: generateOptions.temperature ?? null,
          contextWindow: generateOptions.num_ctx ?? null,
        });

        const response = await fetch(`${resolveOllamaEndpoint(args.ollamaConfig)}/api/generate`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          signal: controller.signal,
          body: JSON.stringify({
            model: args.model,
            stream: true,
            prompt,
            system: systemPrompt,
            options: generateOptions,
          }),
        });

        if (!response.ok) {
          send({
            type: "error",
            code: response.status === 404 ? "ollama_model_not_found" : "ollama_error",
            message: `Ollama returned status ${response.status}.`,
          });
          return;
        }

        if (response.body === null) {
          send({ type: "error", code: "ollama_invalid_response", message: "Ollama response body was empty." });
          return;
        }

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffered = "";
        let fullText = "";

        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          buffered += decoder.decode(value, { stream: true });

          const lines = buffered.split(/\r?\n/);
          buffered = lines.pop() ?? "";

          for (const line of lines) {
            if (line.trim().length === 0) continue;
            // 部分受信や Ollama 側の壊れたチャンクで JSON.parse が落ちると
            // ストリーム全体が ollama_unavailable で誤誘導されてしまうため、行単位で保護。
            let parsed: {
              response?: unknown;
              done?: boolean;
              error?: string;
              eval_count?: number;
              eval_duration?: number;
              total_duration?: number;
            };
            try {
              parsed = JSON.parse(line);
            } catch {
              // 1 行だけスキップして続行（致命的でない）
              continue;
            }

            if (typeof parsed.error === "string") {
              send({ type: "error", code: "ollama_error", message: parsed.error });
              return;
            }

            const delta = parsed.response;
            if (typeof delta === "string" && delta.length > 0) {
              fullText += delta;
              send({ type: "delta", delta });
            }

            if (parsed.done === true) {
              send({
                type: "done",
                message: applyWeakModelOutputGuard(systemPrompt, fullText),
                stats: buildOllamaStats(parsed),
              });
              return;
            }
          }
        }

        if (buffered.trim().length > 0) {
          try {
            const parsed = JSON.parse(buffered) as {
              response?: unknown;
              done?: boolean;
              eval_count?: number;
              eval_duration?: number;
              total_duration?: number;
            };
            const delta = parsed.response;
            if (typeof delta === "string" && delta.length > 0) {
              fullText += delta;
              send({ type: "delta", delta });
            }
          } catch {
            // 末尾の不完全な JSON は黙って捨てる（次行の done で締める）
          }
        }
        send({ type: "done", message: applyWeakModelOutputGuard(systemPrompt, fullText) });
      } catch (cause) {
        const isAbort =
          cause instanceof Error &&
          (cause.name === "AbortError" || cause.name === "TimeoutError");
        send({
          type: "error",
          code: isAbort ? "ollama_timeout" : "ollama_unavailable",
          message: isAbort ? "Ollama stream timed out." : "Could not connect to Ollama.",
        });
      } finally {
        clearTimeout(timer);
        chatStreamControllers.delete(args.requestId);
      }
    },
  );

  ipcMain.handle("lfa:cancel-chat-message-stream", async (_event, requestId: unknown) => {
    if (typeof requestId !== "string" || requestId.length === 0 || requestId.length > 256) return;
    const controller = chatStreamControllers.get(requestId);
    if (controller !== undefined) {
      controller.abort();
      chatStreamControllers.delete(requestId);
    }
  });

  // -- lfa:corpus-build --------------------------------------------------------
  // Corpus2Skill-style local navigation index. Main owns the selected folder
  // and writes the generated tree under `<workspace>/.melunai/corpus`.
  ipcMain.handle("lfa:corpus-build", async () => {
    if (mainWindow === null) {
      return { ok: false, error: { code: "no_window", message: "Main window is not available." } };
    }

    const selected = await dialog.showOpenDialog(mainWindow, {
      properties: ["openDirectory"],
      title: "Corpus2Skill用フォルダを選択",
    });
    if (selected.canceled || selected.filePaths.length === 0) {
      return { ok: false, error: { code: "cancelled", message: "Folder selection was cancelled." } };
    }

    const workspaceRoot = selected.filePaths[0];
    if (workspaceRoot === undefined) {
      return { ok: false, error: { code: "cancelled", message: "Folder selection was cancelled." } };
    }

    try {
      // 選択フォルダがシンボリックリンク・ジャンクションだとリンク先 (別ドライブ等) に
      // .melunai/corpus/ が書き出されてしまうので拒否する。Canvas 経路と整合させる。
      await assertNotSymlink(workspaceRoot, "Corpus folder");
      currentCorpusWorkspace = workspaceRoot;
      const result = await buildCorpusSkill({ workspaceRoot });
      await saveCorpusWorkspaceCache(workspaceRoot);
      return { ok: true, data: result.index };
    } catch (cause) {
      return {
        ok: false,
        error: {
          code: "corpus_build_failed",
          message: cause instanceof Error ? cause.message : String(cause),
        },
      };
    }
  });

  ipcMain.handle("lfa:corpus-status", async () => {
    // Try to restore from cache if workspace is not yet set
    if (currentCorpusWorkspace === null) {
      const cached = await loadCorpusWorkspaceCache();
      if (cached !== null) {
        // cached 値も検証する（corpus-workspace.json の改竄対策）
        const cachedSafe = await isCachedCorpusWorkspaceSafe(cached);
        if (cachedSafe) {
          const index = await loadCorpusIndex(cached);
          if (index !== null) {
            currentCorpusWorkspace = cached;
            return { ok: true, data: index };
          }
        }
      }
      return { ok: true, data: null };
    }
    const index = await loadCorpusIndex(currentCorpusWorkspace);
    if (index === null) {
      currentCorpusWorkspace = null;
      return { ok: true, data: null };
    }
    return { ok: true, data: index };
  });

  ipcMain.handle("lfa:corpus-load", async () => {
    if (mainWindow === null) {
      return { ok: false, error: { code: "no_window", message: "Main window is not available." } };
    }

    const selected = await dialog.showOpenDialog(mainWindow, {
      properties: ["openDirectory"],
      title: "Corpus2Skill indexがあるフォルダを選択",
    });
    if (selected.canceled || selected.filePaths.length === 0) {
      return { ok: false, error: { code: "cancelled", message: "Folder selection was cancelled." } };
    }
    const workspaceRoot = selected.filePaths[0];
    if (workspaceRoot === undefined) {
      return { ok: false, error: { code: "cancelled", message: "Folder selection was cancelled." } };
    }
    try {
      await assertNotSymlink(workspaceRoot, "Corpus folder");
    } catch (cause) {
      return {
        ok: false,
        error: {
          code: "corpus_unsafe_path",
          message: cause instanceof Error ? cause.message : String(cause),
        },
      };
    }
    currentCorpusWorkspace = workspaceRoot;
    const index = await loadCorpusIndex(currentCorpusWorkspace);
    if (index === null) {
      return { ok: false, error: { code: "corpus_missing", message: "Corpus index does not exist." } };
    }
    await saveCorpusWorkspaceCache(workspaceRoot);
    return { ok: true, data: index };
  });

  ipcMain.handle("lfa:corpus-navigate", async (_event, args: unknown) => {
    if (args === null || typeof args !== "object") {
      return { ok: false, error: { code: "invalid_args", message: "Invalid corpus-navigate arguments." } };
    }
    const a = args as { query?: unknown; maxHits?: unknown };
    if (typeof a.query !== "string" || a.query.length === 0) {
      return { ok: false, error: { code: "invalid_query", message: "Query must be a non-empty string." } };
    }
    // クエリ長さ上限（プロンプトサイズ攻撃防止）
    if (a.query.length > 4096) {
      return { ok: false, error: { code: "query_too_long", message: "Query is too long." } };
    }
    const maxHits =
      typeof a.maxHits === "number" && Number.isFinite(a.maxHits) && a.maxHits > 0
        ? Math.min(Math.floor(a.maxHits), 50)
        : undefined;
    if (currentCorpusWorkspace === null) {
      return { ok: false, error: { code: "no_corpus_workspace", message: "No Corpus2Skill workspace selected." } };
    }
    try {
      const result = await navigateCorpus({
        workspaceRoot: currentCorpusWorkspace,
        query: a.query,
        maxHits,
      });
      return { ok: true, data: result };
    } catch (cause) {
      return {
        ok: false,
        error: {
          code: "corpus_navigate_failed",
          message: cause instanceof Error ? cause.message : String(cause),
        },
      };
    }
  });

  // -- lfa:canvas-generate-markdown-stream ------------------------------------
  // Canvas-only generation path. It sends only the user's canvas instruction
  // and the current Markdown body, then streams back a Markdown document body.
  ipcMain.handle(
    "lfa:canvas-generate-markdown-stream",
    async (
      event,
      rawArgs: unknown,
    ) => {
      // 入力検証 — chat-message-stream と同パターン
      if (rawArgs === null || typeof rawArgs !== "object") return;
      const a = rawArgs as Record<string, unknown>;
      const requestId = a["requestId"];
      if (typeof requestId !== "string" || requestId.length === 0 || requestId.length > 256) {
        return;
      }
      if (event.sender.isDestroyed()) return;

      const send = (payload: Record<string, unknown>) => {
        if (event.sender.isDestroyed()) return;
        event.sender.send("lfa:canvas-markdown-stream-event", {
          requestId,
          ...payload,
        });
      };

      if (typeof a["userInstruction"] !== "string"
          || (a["userInstruction"] as string).length === 0
          || (a["userInstruction"] as string).length > 64_000) {
        send({ type: "error", code: "invalid_args", message: "userInstruction must be a 1-64000 char string." });
        return;
      }
      if (typeof a["model"] !== "string"
          || (a["model"] as string).length === 0
          || (a["model"] as string).length > 256) {
        send({ type: "error", code: "invalid_args", message: "model must be a 1-256 char string." });
        return;
      }
      // currentMarkdown / targetMarkdown は string なら採用、長さ上限あり
      const currentMarkdown = typeof a["currentMarkdown"] === "string"
        ? (a["currentMarkdown"] as string).slice(0, 10 * 1024 * 1024)
        : "";
      const targetMarkdown = typeof a["targetMarkdown"] === "string"
        ? (a["targetMarkdown"] as string).slice(0, 10 * 1024 * 1024)
        : undefined;
      const editMode: CanvasMarkdownEditMode | undefined =
        a["editMode"] === "append" || a["editMode"] === "selection" || a["editMode"] === "replace"
          ? (a["editMode"] as CanvasMarkdownEditMode)
          : undefined;
      const ollamaConfig = (typeof a["ollamaConfig"] === "object" && a["ollamaConfig"] !== null
        ? a["ollamaConfig"] as OllamaClientConfig
        : undefined);

      const args = {
        requestId,
        userInstruction: a["userInstruction"] as string,
        currentMarkdown,
        targetMarkdown,
        editMode,
        model: a["model"] as string,
        ollamaConfig,
      };

      if (args.userInstruction.trim().length === 0) {
        send({ type: "error", code: "empty_instruction", message: "Canvas instruction is empty." });
        return;
      }

      const controller = new AbortController();
      const timeoutMs = Math.max(resolveOllamaTimeoutMs(args.ollamaConfig), 120_000);
      const timer = setTimeout(() => controller.abort(), timeoutMs);

      try {
        const response = await fetch(`${resolveOllamaEndpoint(args.ollamaConfig)}/api/generate`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          signal: controller.signal,
          body: JSON.stringify({
            model: args.model,
            stream: true,
            prompt: buildCanvasMarkdownPrompt({
              userInstruction: args.userInstruction,
              currentMarkdown: args.currentMarkdown,
              targetMarkdown: args.targetMarkdown,
              editMode: args.editMode,
            }),
            options: {
              temperature: 0.2,
              top_p: 0.9,
            },
          }),
        });

        if (!response.ok) {
          send({
            type: "error",
            code: response.status === 404 ? "ollama_model_not_found" : "ollama_error",
            message: `Ollama returned status ${response.status}.`,
          });
          return;
        }

        if (response.body === null) {
          send({ type: "error", code: "ollama_invalid_response", message: "Ollama response body was empty." });
          return;
        }

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffered = "";
        let fullText = "";

        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          buffered += decoder.decode(value, { stream: true });

          const lines = buffered.split(/\r?\n/);
          buffered = lines.pop() ?? "";

          for (const line of lines) {
            if (line.trim().length === 0) continue;
            // chat-message-stream と同様、行単位の JSON.parse 保護
            let parsed: { response?: unknown; done?: boolean; error?: string };
            try {
              parsed = JSON.parse(line);
            } catch {
              continue;
            }

            if (typeof parsed.error === "string") {
              send({ type: "error", code: "ollama_error", message: parsed.error });
              return;
            }

            const delta = parsed.response;
            if (typeof delta === "string" && delta.length > 0) {
              fullText += delta;
              send({ type: "delta", delta });
            }

            if (parsed.done === true) {
              send({ type: "done", markdown: fullText.trim() });
              return;
            }
          }
        }

        if (buffered.trim().length > 0) {
          try {
            const parsed = JSON.parse(buffered) as { response?: unknown };
            const delta = parsed.response;
            if (typeof delta === "string" && delta.length > 0) {
              fullText += delta;
              send({ type: "delta", delta });
            }
          } catch {
            // 末尾の不完全な JSON は無視
          }
        }
        send({ type: "done", markdown: fullText.trim() });
      } catch (cause) {
        const isAbort =
          cause instanceof Error &&
          (cause.name === "AbortError" || cause.name === "TimeoutError");
        send({
          type: "error",
          code: isAbort ? "ollama_timeout" : "ollama_unavailable",
          message: isAbort ? "Ollama stream timed out." : "Could not connect to Ollama.",
        });
      } finally {
        clearTimeout(timer);
      }
    },
  );

  // -- lfa:canvas-start --------------------------------------------------------
  // Select a folder and create a new Markdown canvas file inside it.
  ipcMain.handle("lfa:canvas-start", async () => {
    if (mainWindow === null) {
      return { ok: false, error: { code: "no_window", message: "Main window is not available." } };
    }

    const selected = await dialog.showOpenDialog(mainWindow, {
      properties: ["openDirectory"],
      title: "Canvas用フォルダを選択",
    });
    if (selected.canceled || selected.filePaths.length === 0) {
      return { ok: false, error: { code: "cancelled", message: "Folder selection was cancelled." } };
    }

    const folder = selected.filePaths[0]!;
    // 選択されたフォルダがシンボリックリンク・ジャンクションでないことを確認
    await assertNotSymlink(folder, "Canvas folder");
    const filePath = path.join(folder, defaultCanvasFilename());
    const initialContent = "# New Canvas\n\n";
    await fs.promises.writeFile(filePath, initialContent, { encoding: "utf8", flag: "wx" });
    currentCanvasFolder = folder;
    currentCanvasFile = filePath;

    return {
      ok: true,
      data: {
        folder,
        filePath,
        name: path.basename(filePath),
        content: initialContent,
      },
    };
  });

  // -- lfa:canvas-open ---------------------------------------------------------
  // Open an existing Markdown file. The parent folder becomes the canvas folder.
  ipcMain.handle("lfa:canvas-open", async () => {
    if (mainWindow === null) {
      return { ok: false, error: { code: "no_window", message: "Main window is not available." } };
    }

    const selected = await dialog.showOpenDialog(mainWindow, {
      properties: ["openFile"],
      filters: [{ name: "Markdown", extensions: ["md", "markdown"] }],
      title: "Markdownファイルを開く",
    });
    if (selected.canceled || selected.filePaths.length === 0) {
      return { ok: false, error: { code: "cancelled", message: "File selection was cancelled." } };
    }

    const filePath = selected.filePaths[0]!;
    const folder = path.dirname(filePath);
    // フォルダ／ファイル両方のシンボリックリンクを拒否
    await assertNotSymlink(folder, "Canvas folder");
    await assertNotSymlink(filePath, "Canvas file");
    const resolved = resolveCanvasPath(folder, filePath);
    const content = await fs.promises.readFile(resolved, "utf8");
    currentCanvasFolder = folder;
    currentCanvasFile = resolved;

    return {
      ok: true,
      data: {
        folder,
        filePath: resolved,
        name: path.basename(resolved),
        content,
      },
    };
  });

  // -- lfa:canvas-save ---------------------------------------------------------
  ipcMain.handle("lfa:canvas-save", async (_event, args: { filePath: string; content: string }) => {
    // ランタイム入力検証
    if (
      args === null || typeof args !== "object" ||
      typeof args.filePath !== "string" || typeof args.content !== "string"
    ) {
      return { ok: false, error: { code: "invalid_args", message: "Invalid canvas-save arguments." } };
    }
    // content の極端なサイズを拒否（10MB 上限）
    if (args.content.length > 10 * 1024 * 1024) {
      return { ok: false, error: { code: "content_too_large", message: "Canvas content exceeds 10MB." } };
    }
    if (currentCanvasFolder === null || currentCanvasFile === null) {
      return { ok: false, error: { code: "no_canvas", message: "Canvas is not open." } };
    }

    let resolved: string;
    try {
      resolved = resolveCanvasPath(currentCanvasFolder, args.filePath);
    } catch (cause) {
      return {
        ok: false,
        error: {
          code: "invalid_canvas_path",
          message: cause instanceof Error ? cause.message : "Invalid canvas path.",
        },
      };
    }
    if (resolved !== currentCanvasFile) {
      return { ok: false, error: { code: "canvas_mismatch", message: "Canvas file mismatch." } };
    }
    // 書き込み直前にもう一度シンボリックリンク検査（TOCTOU 緩和）
    await assertNotSymlink(resolved, "Canvas file");

    await fs.promises.writeFile(resolved, args.content, "utf8");
    return {
      ok: true,
      data: {
        folder: currentCanvasFolder,
        filePath: resolved,
        name: path.basename(resolved),
        content: args.content,
      },
    };
  });

  // NOTE: lfa:list-folder / read-file / create-workspace-entry / read-multiple-files /
  //       read-documents / prepare-document-draft / create-document-draft /
  //       run-execution / log-event / local-action-draft / record-trace は
  //       chat-only リセットで preload から外したため、main 側からも削除済み。

  // -- MCP (Model Context Protocol) -------------------------------------------
  // Full client surface: server config CRUD, connection lifecycle, tools,
  // resources, prompts, logging, roots, sampling. Server-initiated events
  // are forwarded to the renderer via "lfa:mcp-event" (subscribed in main).
  const requireMcp = () => {
    if (mcpManager === null) throw new Error("MCP manager is not ready.");
    return mcpManager;
  };

  // ---- Server config CRUD --------------------------------------------------
  ipcMain.handle("lfa:mcp-list-servers", async () => requireMcp().listServers());

  ipcMain.handle(
    "lfa:mcp-add-server",
    async (_event, input: Omit<McpServerConfig, "id">) => {
      // ランタイム入力検証 + ユーザー確認ダイアログ。
      // MCP サーバ追加は実質「任意コマンド実行の登録」であり、レンダラ XSS を踏むと
      // 攻撃者が `cmd.exe /c <evil>` を仕込めてしまうため、必ずユーザーに見せて承認を取る。
      validateMcpServerInput(input);
      const summary = describeMcpServerForUser(input);
      const confirmed = await confirmMcpServerWithUser("追加するMCPサーバ", summary);
      if (!confirmed) {
        throw new Error("MCP server addition was cancelled by the user.");
      }
      return requireMcp().addServer(input);
    },
  );

  ipcMain.handle(
    "lfa:mcp-update-server",
    async (_event, id: unknown, patch: Partial<Omit<McpServerConfig, "id">>) => {
      const validatedId = assertMcpId(id);
      if (patch === null || typeof patch !== "object") {
        throw new Error("MCP update patch must be an object.");
      }
      // transport / command 変更時は再確認（read-only な name 変更等は通す）
      if (patch.transport !== undefined) {
        validateMcpServerInput({ name: patch.name ?? "(update)", transport: patch.transport });
        const summary = describeMcpServerForUser({
          name: patch.name ?? "(update)",
          transport: patch.transport,
        });
        const confirmed = await confirmMcpServerWithUser("MCPサーバの設定変更", summary);
        if (!confirmed) {
          throw new Error("MCP server update was cancelled by the user.");
        }
      }
      return requireMcp().updateServer(validatedId, patch);
    },
  );

  ipcMain.handle("lfa:mcp-remove-server", async (_event, id: unknown) => {
    return requireMcp().removeServer(assertMcpId(id));
  });

  // ---- Connection lifecycle ------------------------------------------------
  ipcMain.handle("lfa:mcp-connect-server", async (_event, id: unknown) => {
    return requireMcp().connectServer(assertMcpId(id));
  });

  ipcMain.handle("lfa:mcp-disconnect-server", async (_event, id: unknown) => {
    return requireMcp().disconnectServer(assertMcpId(id));
  });

  ipcMain.handle("lfa:mcp-ping", async (_event, id: unknown) => {
    return requireMcp().ping(assertMcpId(id));
  });

  ipcMain.handle("lfa:mcp-refresh", async (_event, id: unknown) => {
    return requireMcp().refreshAll(assertMcpId(id));
  });

  // ---- Argument completion (`completion/complete`) -------------------------
  ipcMain.handle(
    "lfa:mcp-complete",
    async (_event, args: unknown) => {
      const a = assertObject(args, "mcp-complete");
      const serverId = assertMcpId((a as { serverId?: unknown }).serverId);
      const ref = (a as { ref?: McpCompletionRef }).ref;
      const argument = (a as { argument?: { name: string; value: string } }).argument;
      if (ref === undefined || argument === undefined) throw new Error("mcp-complete: missing ref/argument");
      return requireMcp().complete(serverId, ref, argument);
    },
  );

  // ---- OAuth ---------------------------------------------------------------
  ipcMain.handle(
    "lfa:mcp-authorize",
    async (_event, args: unknown) => {
      const a = assertObject(args, "mcp-authorize") as {
        serverId?: unknown; scope?: unknown; clientId?: unknown; clientSecret?: unknown;
      };
      const serverId = assertMcpId(a.serverId);
      // 文字列以外の認証フィールドは弾く
      const opts = {
        scope: typeof a.scope === "string" ? a.scope.slice(0, 1024) : undefined,
        clientId: typeof a.clientId === "string" ? a.clientId.slice(0, 256) : undefined,
        clientSecret: typeof a.clientSecret === "string" ? a.clientSecret.slice(0, 1024) : undefined,
      };
      return requireMcp().authorizeServer(serverId, opts);
    },
  );

  ipcMain.handle("lfa:mcp-clear-authorization", async (_event, serverId: unknown) => {
    await requireMcp().clearAuthorization(assertMcpId(serverId));
  });

  // ---- Sampling policy -----------------------------------------------------
  ipcMain.handle(
    "lfa:mcp-set-sampling-policy",
    async (_event, args: unknown) => {
      const a = assertObject(args, "mcp-set-sampling-policy") as { policy?: unknown; graceMs?: unknown };
      if (a.policy !== "auto" && a.policy !== "ask" && a.policy !== "never") {
        throw new Error("Invalid sampling policy.");
      }
      const grace =
        typeof a.graceMs === "number" && Number.isFinite(a.graceMs) && a.graceMs > 0
          ? Math.min(Math.floor(a.graceMs), 5 * 60_000)
          : undefined;
      requireMcp().setSamplingPolicy(a.policy, grace);
    },
  );

  // ---- Tools ----------------------------------------------------------------
  ipcMain.handle(
    "lfa:mcp-call-tool",
    async (_event, args: unknown) => {
      const a = assertObject(args, "mcp-call-tool") as { serverId?: unknown; toolName?: unknown; arguments?: unknown };
      const serverId = assertMcpId(a.serverId);
      if (typeof a.toolName !== "string" || a.toolName.length === 0 || a.toolName.length > 256) {
        throw new Error("mcp-call-tool: invalid toolName");
      }
      return requireMcp().callTool(serverId, a.toolName, a.arguments);
    },
  );

  // ---- Resources ------------------------------------------------------------
  ipcMain.handle(
    "lfa:mcp-read-resource",
    async (_event, args: unknown) => {
      const a = assertObject(args, "mcp-read-resource") as { serverId?: unknown; uri?: unknown };
      const serverId = assertMcpId(a.serverId);
      const uri = assertReasonableUri(a.uri);
      return requireMcp().readResource(serverId, uri);
    },
  );

  ipcMain.handle(
    "lfa:mcp-subscribe-resource",
    async (_event, args: unknown) => {
      const a = assertObject(args, "mcp-subscribe-resource") as { serverId?: unknown; uri?: unknown };
      return requireMcp().subscribeResource(assertMcpId(a.serverId), assertReasonableUri(a.uri));
    },
  );

  ipcMain.handle(
    "lfa:mcp-unsubscribe-resource",
    async (_event, args: unknown) => {
      const a = assertObject(args, "mcp-unsubscribe-resource") as { serverId?: unknown; uri?: unknown };
      return requireMcp().unsubscribeResource(assertMcpId(a.serverId), assertReasonableUri(a.uri));
    },
  );

  // ---- Prompts --------------------------------------------------------------
  ipcMain.handle(
    "lfa:mcp-get-prompt",
    async (_event, args: unknown) => {
      const a = assertObject(args, "mcp-get-prompt") as {
        serverId?: unknown; name?: unknown; arguments?: unknown;
      };
      const serverId = assertMcpId(a.serverId);
      if (typeof a.name !== "string" || a.name.length === 0 || a.name.length > 256) {
        throw new Error("mcp-get-prompt: invalid name");
      }
      const promptArgs =
        a.arguments !== undefined && typeof a.arguments === "object" && a.arguments !== null
          ? (a.arguments as Record<string, string>)
          : undefined;
      return requireMcp().getPrompt(serverId, a.name, promptArgs);
    },
  );

  // ---- Logging --------------------------------------------------------------
  ipcMain.handle(
    "lfa:mcp-set-log-level",
    async (_event, args: unknown) => {
      const a = assertObject(args, "mcp-set-log-level") as { serverId?: unknown; level?: unknown };
      const validLevels = new Set([
        "debug", "info", "notice", "warning", "error", "critical", "alert", "emergency",
      ]);
      if (typeof a.level !== "string" || !validLevels.has(a.level)) {
        throw new Error("mcp-set-log-level: invalid level");
      }
      return requireMcp().setLogLevel(assertMcpId(a.serverId), a.level as McpLogLevel);
    },
  );

  // ---- Roots ---------------------------------------------------------------
  ipcMain.handle(
    "lfa:mcp-set-roots",
    async (_event, args: unknown) => {
      const a = assertObject(args, "mcp-set-roots") as { serverId?: unknown; roots?: unknown };
      const serverId = assertMcpId(a.serverId);
      if (!Array.isArray(a.roots)) throw new Error("mcp-set-roots: roots must be an array");
      const roots: McpRoot[] = [];
      for (const r of a.roots) {
        if (r === null || typeof r !== "object") continue;
        const root = r as { uri?: unknown; name?: unknown };
        if (typeof root.uri !== "string" || root.uri.length === 0 || root.uri.length > 2048) continue;
        roots.push({
          uri: root.uri,
          name: typeof root.name === "string" ? root.name.slice(0, 256) : undefined,
        });
        if (roots.length >= 32) break; // 上限
      }
      return requireMcp().setRoots(serverId, roots);
    },
  );

  // ---- Sampling (server → host LLM) ----------------------------------------
  // Renderer responds to "sampling_request" events through these handlers.
  ipcMain.handle(
    "lfa:mcp-resolve-sampling",
    async (_event, args: unknown) => {
      const a = assertObject(args, "mcp-resolve-sampling") as { requestId?: unknown; result?: unknown };
      if (typeof a.requestId !== "string" || a.requestId.length === 0 || a.requestId.length > 256) {
        throw new Error("mcp-resolve-sampling: invalid requestId");
      }
      const result = (a.result === null
        ? null
        : (a.result as McpSamplingResult | null));
      requireMcp().resolveSamplingRequest(a.requestId, result);
    },
  );

  ipcMain.handle(
    "lfa:mcp-reject-sampling",
    async (_event, args: unknown) => {
      const a = assertObject(args, "mcp-reject-sampling") as { requestId?: unknown; reason?: unknown };
      if (typeof a.requestId !== "string" || a.requestId.length === 0 || a.requestId.length > 256) {
        throw new Error("mcp-reject-sampling: invalid requestId");
      }
      const reason = typeof a.reason === "string" ? a.reason.slice(0, 1024) : "declined";
      requireMcp().rejectSamplingRequest(a.requestId, reason);
    },
  );
}
