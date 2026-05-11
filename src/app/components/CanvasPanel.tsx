import React from "react";

import type { CanvasDocument, CanvasMarkdownEditMode } from "../electron-api.js";

export interface CanvasMarkdownGenerateRequest {
  mode: CanvasMarkdownEditMode;
  instruction: string;
  targetMarkdown: string;
  targetStartLine: number | null;
  targetEndLine: number | null;
  insertAfterLine: number | null;
}

interface CanvasPanelProps {
  document: CanvasDocument | null;
  content: string;
  dirty: boolean;
  saving: boolean;
  error: string | null;
  onStart: () => void;
  onOpen: () => void;
  onContentChange: (content: string) => void;
  onSave: () => void;
  onMinimize: () => void;
  generating: boolean;
  onGenerateMarkdown: (request: CanvasMarkdownGenerateRequest) => void;
}

export function CanvasPanel({
  document,
  content,
  dirty,
  saving,
  error,
  onStart,
  onOpen,
  onContentChange,
  onSave,
  onMinimize,
  generating,
  onGenerateMarkdown,
}: CanvasPanelProps): React.ReactElement {
  const editorRef = React.useRef<HTMLDivElement>(null);
  const [focused, setFocused] = React.useState(false);
  const [aiInstruction, setAiInstruction] = React.useState("");
  const [aiMode, setAiMode] = React.useState<CanvasMarkdownEditMode>("append");
  const [storedSelectionRange, setStoredSelectionRange] = React.useState<{ start: number; end: number } | null>(null);
  const [storedCursorLine, setStoredCursorLine] = React.useState<number | null>(null);

  React.useEffect(() => {
    if (focused) return;
    if (editorRef.current !== null && serializeEditor(editorRef.current) !== normalizeMarkdown(content)) {
      renderMarkdown(editorRef.current, content);
      applyStoredSelectionHighlight(editorRef.current, storedSelectionRange);
    }
  }, [content, focused, storedSelectionRange]);

  React.useEffect(() => {
    if (editorRef.current !== null) {
      applyStoredSelectionHighlight(editorRef.current, storedSelectionRange);
    }
  }, [storedSelectionRange, content]);

  React.useEffect(() => {
    if (!generating) {
      setStoredSelectionRange(null);
    }
  }, [generating]);

  const saveLabel = saving ? "保存中..." : dirty ? "保存" : "保存済";

  return (
    <section className="ml-canvas-panel" style={styles.panel}>

      {/* ツールバー */}
      <div style={styles.toolbar}>
        <div style={styles.titleBlock}>
          <div style={styles.title}>Canvas</div>
          <div style={styles.subtitle} title={document?.filePath}>
            {document === null ? "Markdownキャンバス" : document.name}
          </div>
        </div>
        <div style={styles.actions}>
          <button
            className="ml-btn-glass"
            style={styles.smallPillBtn}
            onClick={onStart}
          >
            起動
          </button>
          <button
            className="ml-btn-glass"
            style={styles.smallPillBtn}
            onClick={onOpen}
          >
            開く
          </button>
          <button
            className="ml-btn-glass"
            style={styles.smallPillBtn}
            onClick={onMinimize}
          >
            {/* minimize icon */}
            <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true" style={{ marginRight: 4 }}>
              <path d="M1 6h10" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
              <path d="M7 10l4-4-4-4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
            </svg>
            最小化
          </button>
          <button
            className="ml-btn-accent"
            style={{
              ...styles.saveBtn,
              opacity: document === null || saving ? 0.38 : 1,
            }}
            onClick={onSave}
            disabled={document === null || saving}
          >
            {saveLabel}
          </button>
        </div>
      </div>

      {/* AI 編集バー */}
      {document !== null && (
        <form
          style={styles.aiBar}
          onSubmit={(event) => {
            event.preventDefault();
            const instruction = aiInstruction.trim();
            if (instruction.length === 0 || generating) return;
            onGenerateMarkdown(buildCanvasGenerateRequest(editorRef.current, aiMode, instruction, storedSelectionRange, storedCursorLine));
            setAiInstruction("");
          }}
        >
          <select
            className="ml-select ml-ai-select"
            style={styles.aiSelect}
            value={aiMode}
            onChange={(event) => setAiMode(event.currentTarget.value as CanvasMarkdownEditMode)}
            disabled={generating}
            title="AI編集モード"
          >
            <option value="append">追記</option>
            <option value="selection">選択範囲</option>
          </select>
          <input
            className="ml-ai-input"
            style={styles.aiInput}
            value={aiInstruction}
            onChange={(event) => setAiInstruction(event.currentTarget.value)}
            placeholder="MDに書く内容を指示..."
            disabled={generating}
          />
          <button
            className="ml-btn-accent"
            style={{
              ...styles.aiBtn,
              opacity: aiInstruction.trim().length === 0 || generating ? 0.38 : 1,
            }}
            type="submit"
            disabled={aiInstruction.trim().length === 0 || generating}
          >
            {generating ? (
              <>
                <span style={styles.generatingOrbit} aria-hidden="true">
                  <span style={styles.generatingRing} />
                  <span style={styles.generatingCore} />
                </span>
                生成中
              </>
            ) : "AIで反映"}
          </button>
          {aiMode === "selection" && (
            <span style={styles.selectionStatus}>
              {storedSelectionRange === null
                ? "未選択"
                : `${storedSelectionRange.end - storedSelectionRange.start + 1}行`}
            </span>
          )}
        </form>
      )}

      {/* エラー */}
      {error !== null && (
        <div className="ml-error-msg" style={styles.error}>{error}</div>
      )}

      {/* 本体 */}
      {document === null ? (
        <div style={styles.empty}>
          <div className="ml-canvas-empty-title" style={styles.emptyTitle}>
            Markdownを<br />左に置く。
          </div>
          <p className="ml-canvas-empty-text" style={styles.emptyText}>
            Canvasを起動すると、選択したフォルダに新しい<br />
            MDファイルを作成します。既存のMDも開けます。
          </p>
          <button
            className="ml-btn-accent ml-canvas-empty-btn"
            style={styles.emptyBtn}
            onClick={onStart}
          >
            Canvasを起動
          </button>
        </div>
      ) : (
        <article
          ref={editorRef}
          style={styles.editor}
          contentEditable
          suppressContentEditableWarning
          spellCheck
          onFocus={() => {
            setFocused(true);
            if (editorRef.current !== null && editorRef.current.childElementCount === 0) {
              renderMarkdown(editorRef.current, content);
            }
          }}
          onBlur={() => {
            setFocused(false);
            if (editorRef.current !== null) {
              onContentChange(serializeEditor(editorRef.current));
            }
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              insertParagraphAfterSelection(editorRef.current);
              if (editorRef.current !== null) {
                onContentChange(serializeEditor(editorRef.current));
              }
              return;
            }
            if (event.key === "Backspace") {
              handleEmptyBlockBackspace(event, editorRef.current);
            }
          }}
          onInput={(event) => {
            applyMarkdownShortcutAtSelection();
            updateStoredSelectionRange(event.currentTarget, setStoredSelectionRange);
            updateStoredCursorLine(event.currentTarget, setStoredCursorLine);
            onContentChange(serializeEditor(event.currentTarget));
          }}
          onPaste={(event) => {
            // 既定の HTML ペーストは <img onerror>, <script> 等の発火経路になり得るため、
            // プレーンテキストのみを取り出して挿入する。これで悪性ソースからの貼り付け攻撃を遮断。
            event.preventDefault();
            const text = event.clipboardData.getData("text/plain");
            if (text.length === 0) return;
            // 制御文字（pastejacking 用）は除去
            // eslint-disable-next-line no-control-regex
            const sanitized = text.replace(/\r\n?/g, "\n").replace(/[\x00-\x08\x0B-\x1F\x7F]/g, "");
            const selection = window.getSelection();
            if (selection !== null && selection.rangeCount > 0) {
              const range = selection.getRangeAt(0);
              range.deleteContents();
              range.insertNode(window.document.createTextNode(sanitized));
              range.collapse(false);
            }
            if (editorRef.current !== null) {
              onContentChange(serializeEditor(editorRef.current));
            }
          }}
          onMouseUp={(event) => {
            updateStoredSelectionRange(event.currentTarget, setStoredSelectionRange);
            updateStoredCursorLine(event.currentTarget, setStoredCursorLine);
          }}
          onKeyUp={(event) => {
            updateStoredSelectionRange(event.currentTarget, setStoredSelectionRange);
            updateStoredCursorLine(event.currentTarget, setStoredCursorLine);
          }}
        />
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------
// Markdown editor logic（既存ロジック — 変更なし）
// ---------------------------------------------------------------------------

type MarkdownBlockKind = "h1" | "h2" | "h3" | "ul" | "quote" | "p";

interface MarkdownBlock {
  kind: MarkdownBlockKind;
  text: string;
}

function normalizeMarkdown(markdown: string): string {
  return markdown.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

function parseMarkdown(markdown: string): MarkdownBlock[] {
  const lines = normalizeMarkdown(markdown).split("\n");
  const blocks = lines.map((line): MarkdownBlock => {
    if (line.startsWith("### ")) return { kind: "h3", text: line.slice(4) };
    if (line.startsWith("## ")) return { kind: "h2", text: line.slice(3) };
    if (line.startsWith("# ")) return { kind: "h1", text: line.slice(2) };
    if (line.startsWith("- ")) return { kind: "ul", text: line.slice(2) };
    if (line.startsWith("> ")) return { kind: "quote", text: line.slice(2) };
    return { kind: "p", text: line };
  });
  return blocks.length === 0 ? [{ kind: "p", text: "" }] : blocks;
}

function renderMarkdown(container: HTMLDivElement, markdown: string): void {
  container.replaceChildren(...parseMarkdown(markdown).map(createEditableBlock));
}

function createEditableBlock(block: MarkdownBlock): HTMLDivElement {
  const element = document.createElement("div");
  element.contentEditable = "true";
  element.spellcheck = true;
  element.dataset.kind = block.kind;
  element.textContent = block.text;
  applyBlockStyle(element, block.kind);
  if (block.text.length === 0) {
    element.appendChild(document.createElement("br"));
  }
  return element;
}

function applyBlockStyle(element: HTMLElement, kind: MarkdownBlockKind): void {
  element.dataset.kind = kind;
  element.style.outline = "none";
  element.style.minHeight = "1.4em";
  element.style.margin = kind === "h1" ? "0.72em 0 0.3em" : kind === "h2" ? "0.68em 0 0.26em" : "0.22em 0";
  element.style.color = kind === "quote" ? "#A1A1A6" : "#F5F5F7";
  element.style.fontWeight = kind === "h1" || kind === "h2" || kind === "h3" ? "800" : "400";
  element.style.fontSize = kind === "h1" ? "40px" : kind === "h2" ? "30px" : kind === "h3" ? "22px" : "17px";
  element.style.lineHeight = kind === "h1" || kind === "h2" ? "1.15" : "1.78";
  element.style.letterSpacing = kind === "h1" ? "-0.03em" : kind === "h2" ? "-0.02em" : "-0.005em";
  element.style.paddingLeft = kind === "ul" ? "1.2em" : kind === "quote" ? "1.2em" : "0";
  element.style.borderLeft = kind === "quote" ? "2px solid rgba(155,207,204,0.5)" : "none";
  element.style.display = kind === "ul" ? "list-item" : "block";
  element.style.listStylePosition = kind === "ul" ? "outside" : "initial";
  element.style.position = "relative";
  element.style.transition = "color 150ms ease";
}

function serializeEditor(container: HTMLElement): string {
  const blocks = Array.from(container.children).map((child) => {
    const element = child as HTMLElement;
    const text = element.innerText.replace(/ /g, " ").replace(/\n/g, "");
    switch (element.dataset.kind) {
      case "h1":   return text.length === 0 ? "#"   : `# ${text}`;
      case "h2":   return text.length === 0 ? "##"  : `## ${text}`;
      case "h3":   return text.length === 0 ? "###" : `### ${text}`;
      case "ul":   return text.length === 0 ? "-"   : `- ${text}`;
      case "quote":return text.length === 0 ? ">"   : `> ${text}`;
      default:     return text;
    }
  });
  return blocks.join("\n");
}

function applyMarkdownShortcutAtSelection(): void {
  const selection = window.getSelection();
  const block = findEditableBlock(selection?.anchorNode ?? null);
  if (block === null) return;
  const text = block.innerText.replace(/ /g, " ").replace(/\n/g, "");
  const shortcut = parseShortcut(text);
  if (shortcut === null) return;
  block.textContent = shortcut.text;
  applyBlockStyle(block, shortcut.kind);
  placeCaretAtEnd(block);
}

function parseShortcut(text: string): MarkdownBlock | null {
  if (text.startsWith("### ")) return { kind: "h3", text: text.slice(4) };
  if (text.startsWith("## ")) return { kind: "h2", text: text.slice(3) };
  if (text.startsWith("# ")) return { kind: "h1", text: text.slice(2) };
  if (text.startsWith("- ")) return { kind: "ul", text: text.slice(2) };
  if (text.startsWith("> ")) return { kind: "quote", text: text.slice(2) };
  return null;
}

function insertParagraphAfterSelection(container: HTMLDivElement | null): void {
  if (container === null) return;
  const selection = window.getSelection();
  const current = findEditableBlock(selection?.anchorNode ?? null);
  const nextBlock = createEditableBlock({ kind: "p", text: "" });
  if (current === null) {
    container.appendChild(nextBlock);
  } else {
    current.after(nextBlock);
  }
  placeCaretAtEnd(nextBlock);
}

function handleEmptyBlockBackspace(event: React.KeyboardEvent, container: HTMLDivElement | null): void {
  if (container === null) return;
  const selection = window.getSelection();
  const current = findEditableBlock(selection?.anchorNode ?? null);
  if (current === null || current.innerText.length > 0 || container.childElementCount <= 1) return;
  event.preventDefault();
  const previous = current.previousElementSibling as HTMLElement | null;
  current.remove();
  if (previous !== null) placeCaretAtEnd(previous);
}

function findEditableBlock(node: Node | null): HTMLElement | null {
  let current: Node | null = node;
  while (current !== null) {
    if (current instanceof HTMLElement && current.dataset.kind !== undefined) return current;
    current = current.parentNode;
  }
  return null;
}

function placeCaretAtEnd(element: HTMLElement): void {
  element.focus();
  const range = document.createRange();
  range.selectNodeContents(element);
  range.collapse(false);
  const selection = window.getSelection();
  selection?.removeAllRanges();
  selection?.addRange(range);
}

function buildCanvasGenerateRequest(
  container: HTMLDivElement | null,
  mode: CanvasMarkdownEditMode,
  instruction: string,
  storedRange: { start: number; end: number } | null,
  storedCursorLine: number | null,
): CanvasMarkdownGenerateRequest {
  if (container === null || mode === "append") {
    return {
      mode: "append",
      instruction,
      targetMarkdown: "",
      targetStartLine: null,
      targetEndLine: null,
      insertAfterLine: storedRange?.end ?? storedCursorLine,
    };
  }
  if (mode === "selection") {
    const range = storedRange ?? readSelectedBlockRange(container);
    if (range !== null) {
      return {
        mode,
        instruction,
        targetMarkdown: serializeBlockRange(container, range.start, range.end),
        targetStartLine: range.start,
        targetEndLine: range.end,
        insertAfterLine: null,
      };
    }
    return {
      mode,
      instruction,
      targetMarkdown: "",
      targetStartLine: null,
      targetEndLine: null,
      insertAfterLine: null,
    };
  }
  return { mode, instruction, targetMarkdown: "", targetStartLine: null, targetEndLine: null, insertAfterLine: null };
}

function readSelectedBlockRange(container: HTMLElement): { start: number; end: number } | null {
  const selection = window.getSelection();
  if (selection === null || selection.rangeCount === 0 || selection.isCollapsed) return null;
  const range = selection.getRangeAt(0);
  const blocks = Array.from(container.children) as HTMLElement[];
  const selectedIndices = blocks
    .map((block, index) => ({ block, index }))
    .filter(({ block }) => range.intersectsNode(block))
    .map(({ index }) => index);
  if (selectedIndices.length === 0) return null;
  return { start: Math.min(...selectedIndices), end: Math.max(...selectedIndices) };
}

function updateStoredSelectionRange(
  container: HTMLElement,
  setRange: React.Dispatch<React.SetStateAction<{ start: number; end: number } | null>>,
): void {
  const range = readSelectedBlockRange(container);
  if (range !== null) setRange(range);
}

function updateStoredCursorLine(
  container: HTMLElement,
  setLine: React.Dispatch<React.SetStateAction<number | null>>,
): void {
  const line = readCursorBlockIndex(container);
  if (line !== null) setLine(line);
}

function readCursorBlockIndex(container: HTMLElement): number | null {
  const selection = window.getSelection();
  if (selection === null || selection.rangeCount === 0) return null;
  const block = findEditableBlock(selection.anchorNode);
  if (block === null) return null;
  const index = (Array.from(container.children) as HTMLElement[]).indexOf(block);
  return index >= 0 ? index : null;
}

function applyStoredSelectionHighlight(container: HTMLElement, range: { start: number; end: number } | null): void {
  const blocks = Array.from(container.children) as HTMLElement[];
  blocks.forEach((block, index) => {
    const selected = range !== null && index >= range.start && index <= range.end;
    block.style.background = selected ? "rgba(155,207,204,0.14)" : "transparent";
    block.style.boxShadow = selected ? "0 0 0 1px rgba(155,207,204,0.22)" : "none";
    block.style.borderRadius = selected ? "6px" : "0";
    block.style.transition = "background 180ms ease, box-shadow 180ms ease";
  });
}

function serializeBlockRange(container: HTMLElement, start: number, end: number): string {
  const clone = document.createElement("div");
  const blocks = Array.from(container.children).slice(start, end + 1);
  clone.replaceChildren(...blocks.map((block) => block.cloneNode(true)));
  return serializeEditor(clone);
}

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------

const styles = {
  panel: {
    flex: 1,
    minWidth: 0,
    height: "100vh",
    display: "flex",
    flexDirection: "column",
    borderRight: "1px solid rgba(255,255,255,0.07)",
    background: "#1D1D1F",
    color: "#F5F5F7",
  } as React.CSSProperties,

  toolbar: {
    height: 56,
    flexShrink: 0,
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 12,
    padding: "0 20px",
    borderBottom: "1px solid rgba(255,255,255,0.07)",
    background: "rgba(29,29,31,0.82)",
    backdropFilter: "saturate(180%) blur(20px)",
    WebkitBackdropFilter: "saturate(180%) blur(20px)",
  } as React.CSSProperties,

  titleBlock: {
    minWidth: 0,
    flexShrink: 1,
  } as React.CSSProperties,

  title: {
    fontSize: 16,
    fontWeight: 800,
    letterSpacing: "-0.02em",
    color: "#F5F5F7",
  } as React.CSSProperties,

  subtitle: {
    marginTop: 1,
    fontSize: 10,
    color: "#4A4A50",
    letterSpacing: "0.04em",
    textTransform: "uppercase" as const,
    fontWeight: 500,
    overflow: "hidden",
    whiteSpace: "nowrap",
    textOverflow: "ellipsis",
    maxWidth: 220,
  } as React.CSSProperties,

  actions: {
    display: "flex",
    gap: 6,
    flexShrink: 0,
    alignItems: "center",
  } as React.CSSProperties,

  smallPillBtn: {
    height: 30,
    padding: "0 12px",
    fontSize: 12,
    fontWeight: 600,
    display: "inline-flex",
    alignItems: "center",
    gap: 4,
  } as React.CSSProperties,

  saveBtn: {
    height: 30,
    padding: "0 14px",
    fontSize: 12,
  } as React.CSSProperties,

  aiBar: {
    flexShrink: 0,
    display: "flex",
    alignItems: "center",
    gap: 8,
    padding: "10px 20px",
    borderBottom: "1px solid rgba(255,255,255,0.06)",
    background: "rgba(255,255,255,0.025)",
  } as React.CSSProperties,

  aiSelect: {
    height: 34,
    padding: "0 12px",
    fontSize: 12,
    flexShrink: 0,
  } as React.CSSProperties,

  aiInput: {
    height: 34,
    padding: "0 16px",
    fontSize: 13,
  } as React.CSSProperties,

  aiBtn: {
    height: 34,
    padding: "0 14px",
    fontSize: 12,
    flexShrink: 0,
    display: "inline-flex",
    alignItems: "center",
    gap: 7,
  } as React.CSSProperties,

  generatingOrbit: {
    position: "relative",
    width: 12,
    height: 12,
    display: "inline-block",
    flexShrink: 0,
  } as React.CSSProperties,

  generatingRing: {
    position: "absolute",
    inset: 0,
    borderRadius: "50%",
    border: "1px solid transparent",
    borderTopColor: "rgba(29,29,31,0.7)",
    borderRightColor: "rgba(29,29,31,0.22)",
    animation: "ml-thinking-rotate 1.6s linear infinite",
  } as React.CSSProperties,

  generatingCore: {
    position: "absolute",
    top: "50%",
    left: "50%",
    width: 4,
    height: 4,
    margin: "-2px 0 0 -2px",
    borderRadius: "50%",
    background: "#1D1D1F",
    animation: "ml-thinking-pulse 1.4s ease-in-out infinite",
  } as React.CSSProperties,

  selectionStatus: {
    color: "#6E6E73",
    fontSize: 11,
    whiteSpace: "nowrap" as const,
    fontVariantNumeric: "tabular-nums",
    letterSpacing: "0.02em",
    flexShrink: 0,
  } as React.CSSProperties,

  error: {
    margin: "12px 20px 0",
    padding: "10px 14px",
    borderRadius: 10,
    color: "#ffb199",
    background: "rgba(255,120,90,0.09)",
    border: "1px solid rgba(255,120,90,0.15)",
    fontSize: 13,
    lineHeight: 1.5,
  } as React.CSSProperties,

  empty: {
    width: "min(480px, calc(100% - 48px))",
    margin: "auto",
    textAlign: "center",
    padding: "0 0 40px",
  } as React.CSSProperties,

  emptyTitle: {
    fontSize: 44,
    lineHeight: 1.1,
    marginBottom: 20,
  } as React.CSSProperties,

  emptyText: {
    margin: "0 auto 28px",
    color: "#6E6E73",
    fontSize: 15,
    lineHeight: 1.72,
    letterSpacing: "-0.005em",
  } as React.CSSProperties,

  emptyBtn: {
    height: 44,
    padding: "0 24px",
    fontSize: 14,
    fontWeight: 800,
  } as React.CSSProperties,

  editor: {
    flex: 1,
    width: "min(700px, calc(100% - 64px))",
    margin: "0 auto",
    padding: "48px 0 88px",
    overflowY: "auto",
    outline: "none",
    color: "#F5F5F7",
    fontSize: 17,
    lineHeight: 1.78,
    whiteSpace: "pre-wrap",
    wordBreak: "break-word",
    caretColor: "#9BCFCC",
  } as React.CSSProperties,
};
