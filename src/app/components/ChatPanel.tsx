import React from "react";
import type { ChatMessage, AppPhase } from "../state/appState.js";

interface ChatPanelProps {
  messages: ChatMessage[];
  phase: AppPhase;
  planningError: string | null;
  bottomRef: React.RefObject<HTMLDivElement>;
  shouldAutoScroll: boolean;
  onRegenerate: (assistantMessageId: string) => void;
  onEditUserMessage: (userMessageId: string) => void;
}

export function ChatPanel({
  messages,
  phase,
  planningError,
  bottomRef,
  shouldAutoScroll,
  onRegenerate,
  onEditUserMessage,
}: ChatPanelProps): React.ReactElement {
  React.useEffect(() => {
    if (shouldAutoScroll) {
      bottomRef.current?.scrollIntoView({ behavior: "smooth" });
    }
  }, [messages, bottomRef, shouldAutoScroll]);

  const lastUserMessageId = [...messages].reverse().find((message) => message.role === "user")?.id ?? null;

  return (
    <>
      {messages.map((msg) => (
        <MessageBubble
          key={msg.id}
          message={msg}
          canEdit={msg.role === "user" && msg.id === lastUserMessageId && phase !== "planning"}
          canRegenerate={msg.role === "assistant" && phase !== "planning"}
          onEditUserMessage={onEditUserMessage}
          onRegenerate={onRegenerate}
        />
      ))}

      {phase === "planning" && <ThinkingStatus />}

      {planningError !== null && (
        <div className="ml-error-msg" style={s.errorText}>
          {planningError}
        </div>
      )}

      <div ref={bottomRef} />
    </>
  );
}

// ---------------------------------------------------------------------------
// MessageBubble
// ---------------------------------------------------------------------------

function MessageBubble({
  message,
  canEdit,
  canRegenerate,
  onEditUserMessage,
  onRegenerate,
}: {
  message: ChatMessage;
  canEdit: boolean;
  canRegenerate: boolean;
  onEditUserMessage: (userMessageId: string) => void;
  onRegenerate: (assistantMessageId: string) => void;
}): React.ReactElement {
  const [copiedMessage, setCopiedMessage] = React.useState(false);
  const [hovering, setHovering] = React.useState(false);
  const isUser   = message.role === "user";
  const isSystem = message.role === "system";

  if (isSystem) {
    return (
      <div className="ml-msg ml-msg-system" style={s.systemMsg}>
        {message.content}
      </div>
    );
  }

  if (isUser) {
    return (
      <div
        className="ml-msg"
        style={s.userRow}
        onMouseEnter={() => setHovering(true)}
        onMouseLeave={() => setHovering(false)}
      >
        <div className="ml-bubble-user" style={s.userBubble}>
          {message.content}
          {canEdit && (
            <button
              style={{ ...s.userEditButton, opacity: hovering ? 1 : 0 }}
              onClick={() => onEditUserMessage(message.id)}
              title="編集して再送"
            >
              編集
            </button>
          )}
        </div>
      </div>
    );
  }

  // AI — プレーン表示
  return (
    <div
      className="ml-msg"
      style={s.aiRow}
      onMouseEnter={() => setHovering(true)}
      onMouseLeave={() => setHovering(false)}
    >
      <div className="ml-bubble-ai" style={s.aiBubble}>
        <button
          className="ml-msg-copy"
          style={{ ...s.messageCopyButton, opacity: hovering || copiedMessage ? 1 : 0 }}
          onClick={() => {
            void copyText(message.content).then(() => {
              setCopiedMessage(true);
              window.setTimeout(() => setCopiedMessage(false), 1200);
            });
          }}
          title="コピー"
        >
          {copiedMessage ? "コピー済" : "コピー"}
        </button>
        <MarkdownMessage markdown={message.content} />
        {message.stats !== undefined && (
          <div style={s.statsText}>
            {formatStats(message.stats)}
          </div>
        )}
        {canRegenerate && (
          <button
            style={{ ...s.regenerateButton, opacity: hovering ? 1 : 0 }}
            onClick={() => onRegenerate(message.id)}
            title="もう一度生成"
          >
            もう一度
          </button>
        )}
      </div>
    </div>
  );
}

function formatStats(stats: NonNullable<ChatMessage["stats"]>): string {
  const speed = stats.tokenPerSecond === null ? "-- tok/s" : `${stats.tokenPerSecond.toFixed(1)} tok/s`;
  const elapsed = stats.elapsedSeconds === null ? "--s" : `${stats.elapsedSeconds.toFixed(1)}s`;
  return `${speed} · ${elapsed}`;
}

// ---------------------------------------------------------------------------
// MarkdownMessage
// ---------------------------------------------------------------------------

type MarkdownBlock =
  | { kind: "paragraph"; text: string }
  | { kind: "heading"; level: 1 | 2 | 3; text: string }
  | { kind: "list"; items: string[] }
  | { kind: "ordered-list"; items: string[] }
  | { kind: "blockquote"; text: string }
  | { kind: "code"; language: string; code: string };

function MarkdownMessage({ markdown }: { markdown: string }): React.ReactElement {
  return (
    <div style={s.markdownRoot}>
      {parseMarkdownBlocks(markdown).map((block, index) => (
        <MarkdownBlockView key={`${block.kind}-${index}`} block={block} />
      ))}
    </div>
  );
}

function MarkdownBlockView({ block }: { block: MarkdownBlock }): React.ReactElement {
  switch (block.kind) {
    case "heading": {
      const style = block.level === 1 ? s.mdH1 : block.level === 2 ? s.mdH2 : s.mdH3;
      return <div style={style}>{renderInlineMarkdown(block.text)}</div>;
    }
    case "list":
      return (
        <ul style={s.mdList}>
          {block.items.map((item, index) => (
            <li key={index} style={s.mdListItem}>{renderInlineMarkdown(item)}</li>
          ))}
        </ul>
      );
    case "ordered-list":
      return (
        <ol style={s.mdOrderedList}>
          {block.items.map((item, index) => (
            <li key={index} style={s.mdListItem}>{renderInlineMarkdown(item)}</li>
          ))}
        </ol>
      );
    case "blockquote":
      return (
        <blockquote style={s.mdBlockquote}>
          {renderInlineMarkdown(block.text)}
        </blockquote>
      );
    case "code":
      return <CodeBlock language={block.language} code={block.code} />;
    case "paragraph":
      return <p style={s.mdParagraph}>{renderInlineMarkdown(block.text)}</p>;
  }
}

function CodeBlock({ language, code }: { language: string; code: string }): React.ReactElement {
  const [copied, setCopied] = React.useState(false);
  return (
    <div style={s.codeBlock}>
      <div style={s.codeHeader}>
        <span style={s.codeLang}>{language || "code"}</span>
        <button
          style={s.codeCopyButton}
          onClick={() => {
            void copyText(code).then(() => {
              setCopied(true);
              window.setTimeout(() => setCopied(false), 1200);
            });
          }}
        >
          {copied ? "コピー済" : "コピー"}
        </button>
      </div>
      <pre style={s.codePre}>
        <code>{highlightCode(code)}</code>
      </pre>
    </div>
  );
}

function parseMarkdownBlocks(markdown: string): MarkdownBlock[] {
  const lines = markdown.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
  const blocks: MarkdownBlock[] = [];
  let paragraph: string[] = [];
  let listItems: string[] = [];
  let orderedItems: string[] = [];

  const flushParagraph = () => {
    if (paragraph.length > 0) {
      blocks.push({ kind: "paragraph", text: paragraph.join(" ") });
      paragraph = [];
    }
  };
  const flushList = () => {
    if (listItems.length > 0) {
      blocks.push({ kind: "list", items: listItems });
      listItems = [];
    }
  };
  const flushOrdered = () => {
    if (orderedItems.length > 0) {
      blocks.push({ kind: "ordered-list", items: orderedItems });
      orderedItems = [];
    }
  };

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";

    // Fenced code block
    const codeFence = line.match(/^```(\S*)\s*$/);
    if (codeFence !== null) {
      flushParagraph();
      flushList();
      flushOrdered();
      const language = codeFence[1] ?? "";
      const codeLines: string[] = [];
      index += 1;
      while (index < lines.length && !(lines[index] ?? "").startsWith("```")) {
        codeLines.push(lines[index] ?? "");
        index += 1;
      }
      blocks.push({ kind: "code", language, code: codeLines.join("\n") });
      continue;
    }

    // Blank line → flush everything
    if (line.trim().length === 0) {
      flushParagraph();
      flushList();
      flushOrdered();
      continue;
    }

    // Headings
    const heading = line.match(/^(#{1,3})\s+(.+)$/);
    if (heading !== null) {
      flushParagraph();
      flushList();
      flushOrdered();
      blocks.push({
        kind: "heading",
        level: heading[1]!.length as 1 | 2 | 3,
        text: heading[2]!,
      });
      continue;
    }

    // Blockquote
    const blockquote = line.match(/^\s*>\s?(.*)$/);
    if (blockquote !== null) {
      flushParagraph();
      flushList();
      flushOrdered();
      blocks.push({ kind: "blockquote", text: blockquote[1]! });
      continue;
    }

    // Ordered list (1. or 1))
    const orderedList = line.match(/^\s*\d+[.)]\s+(.+)$/);
    if (orderedList !== null) {
      flushParagraph();
      flushList();
      orderedItems.push(orderedList[1]!);
      continue;
    }

    // Unordered list
    const list = line.match(/^\s*[-*+]\s+(.+)$/);
    if (list !== null) {
      flushParagraph();
      flushOrdered();
      listItems.push(list[1]!);
      continue;
    }

    flushList();
    flushOrdered();
    paragraph.push(line.trim());
  }

  flushParagraph();
  flushList();
  flushOrdered();
  return blocks.length > 0 ? blocks : [{ kind: "paragraph", text: "" }];
}

function renderInlineMarkdown(text: string): React.ReactNode[] {
  const nodes: React.ReactNode[] = [];
  // Order matters: backtick > bold(**) > italic(*)
  const pattern = /(`[^`]+`|\*\*[^*]+\*\*|\*[^*\n]+\*)/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) !== null) {
    if (match.index > lastIndex) {
      nodes.push(text.slice(lastIndex, match.index));
    }
    const token = match[0];
    if (token.startsWith("`")) {
      nodes.push(<code key={`code-${match.index}`} style={s.inlineCode}>{token.slice(1, -1)}</code>);
    } else if (token.startsWith("**")) {
      nodes.push(<strong key={`strong-${match.index}`} style={s.strong}>{token.slice(2, -2)}</strong>);
    } else {
      nodes.push(<em key={`em-${match.index}`} style={s.italic}>{token.slice(1, -1)}</em>);
    }
    lastIndex = match.index + token.length;
  }
  if (lastIndex < text.length) {
    nodes.push(text.slice(lastIndex));
  }
  return nodes;
}

function highlightCode(code: string): React.ReactNode[] {
  // 巨大なコードブロック（LLMが暴走して出した場合等）はハイライトをスキップして
  // メインスレッドの占有を防ぐ。50KBを超える分は raw 表示。
  if (code.length > 50_000) {
    return [code];
  }
  const parts = code.split(/(\b(?:const|let|var|function|return|if|else|for|while|class|import|export|from|async|await|try|catch|new|type|interface)\b|"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`|\/\/.*)/g);
  return parts.map((part, index) => {
    if (/^(const|let|var|function|return|if|else|for|while|class|import|export|from|async|await|try|catch|new|type|interface)$/.test(part)) {
      return <span key={index} style={s.codeKeyword}>{part}</span>;
    }
    if (/^["'`]/.test(part)) {
      return <span key={index} style={s.codeString}>{part}</span>;
    }
    if (part.startsWith("//")) {
      return <span key={index} style={s.codeComment}>{part}</span>;
    }
    return part;
  });
}

/**
 * クリップボードに書き込む前にターミナル pastejacking 対策のサニタイズを行う。
 * - \r は \n に正規化（CR で行頭に戻して書き換え攻撃を防ぐ）
 * - 制御文字（ベル・エスケープシーケンス等）を除去
 * - \t と \n のみホワイトリストで残す
 */
function sanitizeForClipboard(text: string): string {
  // CR/CRLF を LF に正規化
  let out = text.replace(/\r\n?/g, "\n");
  // 制御文字を除去（タブ\x09 と改行\x0A のみ許可）
  // eslint-disable-next-line no-control-regex
  out = out.replace(/[\x00-\x08\x0B-\x1F\x7F]/g, "");
  return out;
}

async function copyText(text: string): Promise<void> {
  await navigator.clipboard.writeText(sanitizeForClipboard(text));
}

// ---------------------------------------------------------------------------
// ThinkingStatus
// ---------------------------------------------------------------------------

function ThinkingStatus(): React.ReactElement {
  return (
    <div className="ml-thinking" style={s.thinkingWrap}>
      <span className="ml-thinking-orbit" aria-hidden="true">
        <span className="ml-thinking-ring" />
        <span className="ml-thinking-core" />
      </span>
      <span className="ml-thinking-label">考えています</span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------

const s = {
  userRow: {
    display: "flex",
    justifyContent: "flex-end",
  } as React.CSSProperties,

  userBubble: {
    position: "relative",
    // 影は CSS class (.ml-bubble-user) で管理 — hover で多層化させる
    maxWidth: "76%",
    padding: "13px 18px",
    borderRadius: 22,
    borderBottomRightRadius: 6,
    background: "linear-gradient(135deg, #D5F2EA 0%, #9BCFCC 45%, #6E98BC 100%)",
    border: "1px solid rgba(255,255,255,0.1)",
    fontSize: 15,
    lineHeight: 1.62,
    color: "#1D1D1F",
    letterSpacing: 0,
  } as React.CSSProperties,

  aiRow: {
    display: "flex",
    justifyContent: "flex-start",
  } as React.CSSProperties,

  aiBubble: {
    position: "relative",
    maxWidth: "88%",
    padding: "2px 0",
    fontSize: 15,
    lineHeight: 1.74,
    color: "#E8E8ED",
    letterSpacing: 0,
  } as React.CSSProperties,
  messageCopyButton: {
    position: "absolute",
    top: -24,
    right: 0,
    height: 22,
    padding: "0 8px",
    borderRadius: 999,
    border: "1px solid rgba(255,255,255,0.12)",
    background: "rgba(255,255,255,0.08)",
    color: "#A1A1A6",
    cursor: "pointer",
    fontSize: 11,
    transition: "opacity 140ms ease",
  } as React.CSSProperties,
  userEditButton: {
    position: "absolute",
    left: -48,
    top: 2,
    height: 22,
    padding: "0 8px",
    borderRadius: 999,
    border: "1px solid rgba(255,255,255,0.12)",
    background: "rgba(255,255,255,0.08)",
    color: "#A1A1A6",
    cursor: "pointer",
    fontSize: 11,
    transition: "opacity 140ms ease",
  } as React.CSSProperties,
  statsText: {
    marginTop: 7,
    color: "#4A4A50",
    fontSize: 11,
    letterSpacing: "0.02em",
  } as React.CSSProperties,
  regenerateButton: {
    marginTop: 8,
    height: 24,
    padding: "0 9px",
    borderRadius: 999,
    border: "1px solid rgba(255,255,255,0.12)",
    background: "rgba(255,255,255,0.06)",
    color: "#A1A1A6",
    cursor: "pointer",
    fontSize: 11,
  } as React.CSSProperties,
  markdownRoot: {
    display: "flex",
    flexDirection: "column",
    gap: 8,
  } as React.CSSProperties,
  mdParagraph: {
    margin: 0,
    whiteSpace: "pre-wrap",
  } as React.CSSProperties,
  mdH1: {
    margin: "10px 0 2px",
    fontSize: 24,
    lineHeight: 1.25,
    fontWeight: 800,
    color: "#F5F5F7",
  } as React.CSSProperties,
  mdH2: {
    margin: "8px 0 2px",
    fontSize: 20,
    lineHeight: 1.3,
    fontWeight: 800,
    color: "#F5F5F7",
  } as React.CSSProperties,
  mdH3: {
    margin: "6px 0 1px",
    fontSize: 17,
    lineHeight: 1.35,
    fontWeight: 750,
    color: "#F5F5F7",
  } as React.CSSProperties,
  mdList: {
    margin: "2px 0 2px 18px",
    padding: 0,
  } as React.CSSProperties,
  mdOrderedList: {
    margin: "2px 0 2px 18px",
    padding: 0,
  } as React.CSSProperties,
  mdListItem: {
    margin: "2px 0",
  } as React.CSSProperties,
  mdBlockquote: {
    margin: "2px 0 2px 2px",
    paddingLeft: 12,
    borderLeft: "3px solid rgba(155,207,204,0.38)",
    color: "#A1A1A6",
    fontStyle: "italic",
  } as React.CSSProperties,
  inlineCode: {
    padding: "1px 5px",
    borderRadius: 6,
    background: "rgba(255,255,255,0.08)",
    color: "#D5F2EA",
    fontFamily: 'ui-monospace, SFMono-Regular, Consolas, "Liberation Mono", monospace',
    fontSize: "0.92em",
  } as React.CSSProperties,
  strong: {
    color: "#F5F5F7",
    fontWeight: 800,
  } as React.CSSProperties,
  italic: {
    fontStyle: "italic",
    color: "#D5E8F0",
  } as React.CSSProperties,
  codeBlock: {
    overflow: "hidden",
    borderRadius: 10,
    border: "1px solid rgba(255,255,255,0.1)",
    background: "rgba(0,0,0,0.35)",
    margin: "4px 0",
  } as React.CSSProperties,
  codeHeader: {
    height: 34,
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    padding: "0 10px 0 12px",
    borderBottom: "1px solid rgba(255,255,255,0.08)",
    color: "#A1A1A6",
    fontSize: 12,
  } as React.CSSProperties,
  codeLang: {
    fontFamily: 'ui-monospace, SFMono-Regular, Consolas, "Liberation Mono", monospace',
  } as React.CSSProperties,
  codeCopyButton: {
    height: 23,
    padding: "0 8px",
    borderRadius: 999,
    border: "1px solid rgba(255,255,255,0.12)",
    background: "rgba(255,255,255,0.08)",
    color: "#E8E8ED",
    cursor: "pointer",
    fontSize: 11,
  } as React.CSSProperties,
  codePre: {
    margin: 0,
    padding: "13px 14px",
    overflowX: "auto",
    fontFamily: 'ui-monospace, SFMono-Regular, Consolas, "Liberation Mono", monospace',
    fontSize: 13,
    lineHeight: 1.65,
    color: "#E8E8ED",
  } as React.CSSProperties,
  codeKeyword: {
    color: "#9BCFCC",
    fontWeight: 700,
  } as React.CSSProperties,
  codeString: {
    color: "#D5F2EA",
  } as React.CSSProperties,
  codeComment: {
    color: "#6E6E73",
    fontStyle: "italic",
  } as React.CSSProperties,

  systemMsg: {
    fontSize: 12,
    color: "#4A4A50",
    textAlign: "center",
    letterSpacing: "0.01em",
    padding: "2px 0",
  } as React.CSSProperties,

  errorText: {
    fontSize: 13,
    lineHeight: 1.55,
  } as React.CSSProperties,

  thinkingWrap: {
    padding: "4px 0",
  } as React.CSSProperties,
};
