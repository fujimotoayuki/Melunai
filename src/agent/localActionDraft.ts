/**
 * LocalActionDraft — TASK-040 / Workbench v2 §36.
 *
 * Builds an ActionPlan for explicit, unambiguous file operations WITHOUT
 * calling Ollama. The goal is to keep the small local LLM out of the loop
 * for inputs like:
 *
 *   "memo.txt作って"        -> create_file ActionPlan
 *   "メモ.md作って"         -> create_file ActionPlan
 *   "backupフォルダ作って"  -> create_folder ActionPlan
 *
 * Inputs that are ambiguous (no filename, no extension, plain "ファイル作って")
 * return `{ kind: "clarify", chips }` so the renderer can surface Action Chips
 * (TASK 4) instead of the LLM having to disambiguate.
 *
 * Anything else returns `{ kind: "unmatched" }` so the caller falls through
 * to the existing chat / planAction pipeline.
 *
 * Safety:
 *   - The returned ActionPlan is unvalidated. Callers MUST run it through
 *     `validateActionPlanSafety()` and the existing approval/token execution
 *     boundary before any filesystem write.
 *   - This module never touches the filesystem itself.
 */

import type { ActionPlan, FileAction } from "../types/index.js";

export type LocalActionChipKind =
  | "choose_text_file"
  | "choose_folder"
  | "choose_word"
  | "choose_powerpoint"
  | "choose_excel"
  | "ask_filename"
  | "cancel";

export interface LocalActionChip {
  id: string;
  label: string;
  kind: LocalActionChipKind;
}

export type LocalActionResult =
  | { kind: "matched"; actionPlan: ActionPlan }
  | { kind: "clarify"; message: string; chips: LocalActionChip[] }
  | { kind: "unmatched" };

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

export function tryBuildLocalActionPlan(input: string): LocalActionResult {
  const text = input.trim();
  if (text.length === 0) return { kind: "unmatched" };

  // Ignore inputs that hint at multi-step / non-file work — let the LLM handle.
  if (/[、,。.\n]/.test(text) && countWords(text) > 12) {
    return { kind: "unmatched" };
  }

  // Folder creation
  const folderResult = matchFolderCreation(text);
  if (folderResult !== null) return folderResult;

  // File creation
  const fileResult = matchFileCreation(text);
  if (fileResult !== null) return fileResult;

  return { kind: "unmatched" };
}

// ---------------------------------------------------------------------------
// Folder patterns
// ---------------------------------------------------------------------------

/**
 * Folder regex.
 *   "<name>フォルダ作って"      -> create_folder
 *   "<name>フォルダを作成して" -> create_folder
 *   "フォルダ作って"             -> clarify (no name → ask)
 */
const FOLDER_VERB = /(?:を)?(?:作成|作って|つくって|作りたい|つくりたい|を作る|を作って)/;

function matchFolderCreation(text: string): LocalActionResult | null {
  // English form: "create folder X" / "make a folder named X"
  const enMatch = text.match(/^(?:create|make)\s+(?:a\s+)?folder(?:\s+named)?\s+["']?([^\s"']+)["']?\.?$/i);
  if (enMatch) {
    const name = enMatch[1];
    return name === undefined ? null : matchedFolder(name);
  }

  // Japanese form: "<name>フォルダ作って" or "フォルダ <name> 作って"
  // Anchor on フォルダ / folder keyword anywhere in the input.
  if (!/フォルダ|folder/i.test(text)) return null;
  if (!FOLDER_VERB.test(text) && !/作っ|つくっ|作る|create|make/i.test(text)) return null;

  // Try "<name>フォルダ" prefix: e.g. "backupフォルダ作って"
  const jpPrefix = text.match(/^([\p{L}\p{N}_\-.\s]+?)\s*フォルダ/u);
  let name: string | undefined =
    jpPrefix?.[1] === undefined ? undefined : jpPrefix[1].trim();

  // Strip leading "新しい" or "新規"
  if (name !== undefined) {
    name = name.replace(/^(?:新しい|新規)\s*/, "").trim();
    if (name.length === 0) name = undefined;
  }

  if (name === undefined || isGenericFolderWord(name)) {
    return {
      kind: "clarify",
      message: "どんな名前のフォルダを作りますか？",
      chips: [
        { id: "ask-folder-name", label: "名前を入力", kind: "ask_filename" },
        { id: "cancel", label: "やめる", kind: "cancel" },
      ],
    };
  }

  return matchedFolder(name);
}

function matchedFolder(rawName: string): LocalActionResult {
  const name = sanitizeName(rawName);
  if (name.length === 0) {
    return {
      kind: "clarify",
      message: "フォルダ名が読み取れませんでした。もう一度入力してください。",
      chips: [{ id: "cancel", label: "やめる", kind: "cancel" }],
    };
  }
  const plan: ActionPlan = {
    summary: `「${name}」フォルダを作成します。`,
    actions: [
      {
        id: `local-${Date.now()}`,
        type: "create_folder",
        description: `フォルダ「${name}」を作成`,
        path: name,
      } satisfies FileAction,
    ],
  };
  return { kind: "matched", actionPlan: plan };
}

function isGenericFolderWord(name: string): boolean {
  const generic = ["フォルダ", "folder", "新しい", "新規", "なんか", "なんでも"];
  return generic.includes(name);
}

// ---------------------------------------------------------------------------
// File patterns
// ---------------------------------------------------------------------------

const FILE_VERB = /(?:を)?(?:作成|作って|つくって|作りたい|つくりたい|を作る|を作って|create|make)/i;

const KNOWN_TEXT_EXTS = new Set([
  ".txt", ".md", ".markdown", ".json", ".csv", ".log",
  ".yml", ".yaml", ".html", ".js", ".ts", ".tsx", ".jsx", ".css",
]);

/**
 * File regex.
 *   "memo.txt作って"     -> create_file path=memo.txt
 *   "メモ.md作って"      -> create_file path=メモ.md
 *   "ファイル作って"     -> clarify (no name + no ext → ask)
 *   "メモテキスト作って" -> clarify (NEVER guess .txt for a casual word)
 */
function matchFileCreation(text: string): LocalActionResult | null {
  const hasFileWord = /ファイル|file|テキスト/i.test(text);
  const hasVerb = FILE_VERB.test(text) || /作っ|つくっ|作る/.test(text);
  if (!hasFileWord && !hasVerb) {
    // No file word and no verb → not a file creation
    return null;
  }

  // English: "create a file <name>", "create file named X.ext"
  const enMatch = text.match(/^(?:create|make)\s+(?:a\s+)?(?:file|text\s+file)?\s*(?:named\s+)?["']?([\w./\-]+\.[A-Za-z0-9]+)["']?\.?$/i);
  if (enMatch) {
    const filename = enMatch[1];
    return filename === undefined ? null : matchedFile(filename);
  }

  // Japanese inputs have no spaces, so search anywhere in the text for a
  // filename-shaped substring (basename + dot + 1..8 ext chars).
  const inline = text.match(/([\p{L}\p{N}_\-/]+\.[A-Za-z0-9]{1,8})/u);
  if (inline !== null) {
    return matchedFile(inline[1]!);
  }

  // No filename present.
  // If user said "ファイル作って" or "テキスト作って", we MUST ask — never
  // silently guess `.txt` (Workbench v2 §36 acceptance rule).
  if (hasFileWord && hasVerb) {
    return {
      kind: "clarify",
      message: "どのファイル形式を作りますか？",
      chips: [
        { id: "txt", label: "テキスト (.txt)", kind: "choose_text_file" },
        { id: "md", label: "Markdown (.md)", kind: "choose_text_file" },
        { id: "folder", label: "フォルダ", kind: "choose_folder" },
        { id: "word", label: "Word", kind: "choose_word" },
        { id: "ppt", label: "PowerPoint", kind: "choose_powerpoint" },
        { id: "xlsx", label: "Excel", kind: "choose_excel" },
        { id: "cancel", label: "やめる", kind: "cancel" },
      ],
    };
  }

  return null;
}

function matchedFile(rawPath: string): LocalActionResult {
  const filename = sanitizeName(rawPath);
  if (filename.length === 0) {
    return {
      kind: "clarify",
      message: "ファイル名が読み取れませんでした。もう一度入力してください。",
      chips: [{ id: "cancel", label: "やめる", kind: "cancel" }],
    };
  }
  const ext = extensionOf(filename);
  if (ext === null) {
    return {
      kind: "clarify",
      message: `「${filename}」の拡張子が判別できません。`,
      chips: [
        { id: "txt", label: "テキスト (.txt)", kind: "choose_text_file" },
        { id: "md", label: "Markdown (.md)", kind: "choose_text_file" },
        { id: "cancel", label: "やめる", kind: "cancel" },
      ],
    };
  }

  const plan: ActionPlan = {
    summary: `「${filename}」を新規作成します。`,
    actions: [
      {
        id: `local-${Date.now()}`,
        type: "create_file",
        description: `ファイル「${filename}」を作成`,
        path: filename,
        content: defaultContentFor(filename, ext),
      } satisfies FileAction,
    ],
  };
  return { kind: "matched", actionPlan: plan };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sanitizeName(raw: string): string {
  return raw
    .replace(/^["'`]+|["'`]+$/g, "")
    .replace(/[​-‍﻿]/g, "")
    .trim();
}

function extensionOf(filename: string): string | null {
  const idx = filename.lastIndexOf(".");
  if (idx <= 0 || idx === filename.length - 1) return null;
  return filename.slice(idx).toLowerCase();
}

function defaultContentFor(filename: string, ext: string): string {
  const base = filename.replace(/\.[^.]+$/, "");
  if (ext === ".md" || ext === ".markdown") return `# ${base}\n\n`;
  if (ext === ".json") return "{}\n";
  if (ext === ".csv") return "";
  if (KNOWN_TEXT_EXTS.has(ext)) return "";
  return ""; // Unknown ext: empty file. SafetyValidator will gate it.
}

function countWords(text: string): number {
  return text.split(/[\s、。.,]+/).filter((t) => t.length > 0).length;
}
