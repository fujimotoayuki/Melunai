import React from "react";
import type { FileNode } from "../../types/index.js";

interface WorkspacePanelProps {
  workspacePath: string | null;
  workspaceName: string | null;
  fileTree: FileNode[];
  loading: boolean;
  error: string | null;
  referencedPaths: string[];
  reading: boolean;
  creationRequest: CreationRequest | null;
  onSelectFolder: () => void;
  onRefresh: () => void;
  onNewChat: () => void;
  onCreateEntry: (kind: CreationKind, name: string) => Promise<{ ok: boolean; error: string | null }>;
  onToggleReference: (node: FileNode) => void;
  onReadReferences: () => void;
  onClearReferences: () => void;
}

export type CreationKind = "file" | "folder";

export interface CreationRequest {
  kind: CreationKind;
  suggestedName: string;
  nonce: number;
}

export function WorkspacePanel({
  workspacePath,
  workspaceName,
  fileTree,
  loading,
  error,
  referencedPaths,
  reading,
  creationRequest,
  onSelectFolder,
  onRefresh,
  onNewChat,
  onCreateEntry,
  onToggleReference,
  onReadReferences,
  onClearReferences,
}: WorkspacePanelProps): React.ReactElement {
  const referencedSet = React.useMemo(() => new Set(referencedPaths), [referencedPaths]);
  const canRead = referencedPaths.length > 0 && !reading;
  const [creator, setCreator] = React.useState<{ kind: CreationKind; name: string; error: string | null } | null>(null);
  const inputRef = React.useRef<HTMLInputElement>(null);

  React.useEffect(() => {
    if (creationRequest === null) return;
    setCreator({
      kind: creationRequest.kind,
      name: creationRequest.suggestedName,
      error: null,
    });
  }, [creationRequest]);

  React.useEffect(() => {
    if (creator !== null) {
      window.setTimeout(() => inputRef.current?.focus(), 0);
    }
  }, [creator?.kind]);

  const openCreator = (kind: CreationKind) => {
    setCreator({ kind, name: kind === "file" ? "memo.txt" : "", error: null });
  };

  const submitCreator = async () => {
    if (creator === null) return;
    const result = await onCreateEntry(creator.kind, creator.name);
    if (result.ok) {
      setCreator(null);
      return;
    }
    setCreator((prev) => prev === null ? prev : { ...prev, error: result.error ?? "作成に失敗しました。" });
  };

  return (
    <aside style={styles.container}>
      <div style={styles.header}>
        <div style={styles.titleBlock}>
          <span style={styles.title}>ファイル</span>
          <span style={styles.subtitle} title={workspacePath ?? undefined}>
            {workspaceName ?? "フォルダ未選択"}
          </span>
        </div>
        <div style={styles.actions}>
          <button style={styles.iconButton} onClick={onNewChat} title="新しいチャット">＋</button>
          <button style={styles.iconButton} onClick={onRefresh} title="更新" disabled={loading || workspacePath === null}>
            ↻
          </button>
          <button style={styles.iconButton} onClick={onSelectFolder} title="フォルダを選択">
            ...
          </button>
        </div>
      </div>

      <div style={styles.createBar}>
        <button
          style={styles.createButton}
          onClick={() => openCreator("file")}
          disabled={workspacePath === null}
          title="新規ファイル"
        >
          ＋ファイル
        </button>
        <button
          style={styles.createButton}
          onClick={() => openCreator("folder")}
          disabled={workspacePath === null}
          title="新規フォルダ"
        >
          ＋フォルダ
        </button>
      </div>

      {creator !== null && (
        <div style={styles.creatorBox}>
          <label style={styles.creatorLabel}>
            {creator.kind === "file" ? "新規ファイル" : "新規フォルダ"}
          </label>
          <div style={styles.creatorRow}>
            <input
              ref={inputRef}
              style={styles.creatorInput}
              value={creator.name}
              placeholder={creator.kind === "file" ? "例: memo.txt" : "例: 猫"}
              onChange={(event) => setCreator({ ...creator, name: event.currentTarget.value, error: null })}
              onKeyDown={(event) => {
                if (event.key === "Enter") void submitCreator();
                if (event.key === "Escape") setCreator(null);
              }}
            />
            <button style={styles.creatorSubmit} onClick={() => void submitCreator()}>
              作成
            </button>
          </div>
          <div style={creator.error === null ? styles.creatorHint : styles.creatorError}>
            {creator.error ?? "名前を入れてEnter。上書きはしません。"}
          </div>
        </div>
      )}

      <div style={styles.referenceBar}>
        <span style={styles.referenceText}>
          {referencedPaths.length === 0 ? "参照ファイルなし" : `${referencedPaths.length}件を参照候補に選択`}
        </span>
        <div style={styles.referenceActions}>
          <button
            style={{ ...styles.smallButton, opacity: canRead ? 1 : 0.45 }}
            onClick={onReadReferences}
            disabled={!canRead}
          >
            {reading ? "読込中" : "参照に追加"}
          </button>
          <button
            style={styles.ghostButton}
            onClick={onClearReferences}
            disabled={referencedPaths.length === 0 && !reading}
          >
            解除
          </button>
        </div>
      </div>

      <div style={styles.treeArea}>
        {workspacePath === null && (
          <div style={styles.empty}>
            左上のボタンからフォルダを選ぶと、ここに中身が表示されます。
          </div>
        )}
        {workspacePath !== null && loading && <div style={styles.empty}>読み込み中...</div>}
        {workspacePath !== null && !loading && error !== null && <div style={styles.error}>{error}</div>}
        {workspacePath !== null && !loading && error === null && fileTree.length === 0 && (
          <div style={styles.empty}>ファイルがありません</div>
        )}
        {workspacePath !== null && !loading && error === null && fileTree.length > 0 && (
          <FileTree
            nodes={fileTree}
            depth={0}
            referencedSet={referencedSet}
            onToggleReference={onToggleReference}
          />
        )}
      </div>
    </aside>
  );
}

interface FileTreeProps {
  nodes: FileNode[];
  depth: number;
  referencedSet: Set<string>;
  onToggleReference: (node: FileNode) => void;
}

function FileTree({
  nodes,
  depth,
  referencedSet,
  onToggleReference,
}: FileTreeProps): React.ReactElement {
  return (
    <ul style={styles.list}>
      {nodes.map((node) => (
        <FileTreeNode
          key={node.path}
          node={node}
          depth={depth}
          referencedSet={referencedSet}
          onToggleReference={onToggleReference}
        />
      ))}
    </ul>
  );
}

interface FileTreeNodeProps {
  node: FileNode;
  depth: number;
  referencedSet: Set<string>;
  onToggleReference: (node: FileNode) => void;
}

function FileTreeNode({
  node,
  depth,
  referencedSet,
  onToggleReference,
}: FileTreeNodeProps): React.ReactElement {
  const [expanded, setExpanded] = React.useState(depth < 1);
  const isDirectory = node.type === "directory";
  const selected = referencedSet.has(node.path);
  const readable = isReadableReference(node);

  const handleMainClick = () => {
    if (isDirectory) {
      setExpanded((prev) => !prev);
      return;
    }
    if (readable) onToggleReference(node);
  };

  return (
    <li style={styles.item}>
      <button
        style={{
          ...styles.nodeButton,
          paddingLeft: 10 + depth * 14,
          background: selected ? "rgba(139,143,204,0.16)" : "transparent",
          color: readable || isDirectory ? "#5A4E48" : "#B8ADA4",
          cursor: readable || isDirectory ? "pointer" : "default",
        }}
        onClick={handleMainClick}
        title={node.path}
      >
        <span style={styles.disclosure}>{isDirectory ? (expanded ? "▾" : "▸") : fileIcon(node.extension)}</span>
        <span style={styles.nodeName}>{node.name}</span>
        {!isDirectory && readable && (
          <span style={{ ...styles.check, opacity: selected ? 1 : 0.35 }}>{selected ? "●" : "○"}</span>
        )}
      </button>

      {isDirectory && expanded && node.children !== undefined && node.children.length > 0 && (
        <FileTree
          nodes={node.children}
          depth={depth + 1}
          referencedSet={referencedSet}
          onToggleReference={onToggleReference}
        />
      )}
    </li>
  );
}

function isReadableReference(node: FileNode): boolean {
  if (node.type !== "file") return false;
  return new Set([".md", ".txt", ".json", ".csv", ".pdf", ".docx", ".xlsx", ".pptx"]).has(node.extension ?? "");
}

function fileIcon(ext: string | undefined): string {
  switch (ext) {
    case ".pdf":
      return "PDF";
    case ".docx":
      return "W";
    case ".xlsx":
      return "X";
    case ".pptx":
      return "P";
    case ".json":
      return "{}";
    case ".csv":
      return "CSV";
    default:
      return "TXT";
  }
}

const styles = {
  container: {
    position: "absolute",
    top: 52,
    bottom: 0,
    left: 0,
    width: 292,
    display: "flex",
    flexDirection: "column",
    background: "#F3EEE8",
    borderRight: "1px solid rgba(100,90,82,0.12)",
    zIndex: 6,
  } as React.CSSProperties,
  header: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    padding: "12px 12px 10px",
    borderBottom: "1px solid rgba(100,90,82,0.1)",
  } as React.CSSProperties,
  titleBlock: {
    display: "flex",
    flexDirection: "column",
    minWidth: 0,
  } as React.CSSProperties,
  title: {
    fontSize: 13,
    fontWeight: 700,
    color: "#5A4E48",
  } as React.CSSProperties,
  subtitle: {
    marginTop: 2,
    fontSize: 11,
    color: "#9A8E86",
    maxWidth: 132,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  } as React.CSSProperties,
  actions: {
    display: "flex",
    gap: 5,
  } as React.CSSProperties,
  iconButton: {
    width: 28,
    height: 28,
    borderRadius: 8,
    border: "1px solid rgba(100,90,82,0.12)",
    background: "rgba(255,255,255,0.55)",
    color: "#6A5E56",
    cursor: "pointer",
    fontSize: 15,
    lineHeight: 1,
  } as React.CSSProperties,
  referenceBar: {
    padding: "10px 12px",
    borderBottom: "1px solid rgba(100,90,82,0.1)",
  } as React.CSSProperties,
  createBar: {
    display: "grid",
    gridTemplateColumns: "1fr 1fr",
    gap: 8,
    padding: "10px 12px",
    borderBottom: "1px solid rgba(100,90,82,0.1)",
  } as React.CSSProperties,
  createButton: {
    minHeight: 32,
    borderRadius: 8,
    border: "1px solid rgba(100,90,82,0.16)",
    background: "#FFFDFB",
    color: "#5A4E48",
    cursor: "pointer",
    fontSize: 12,
    fontWeight: 700,
  } as React.CSSProperties,
  creatorBox: {
    padding: "10px 12px",
    borderBottom: "1px solid rgba(100,90,82,0.1)",
    background: "#F8F3ED",
  } as React.CSSProperties,
  creatorLabel: {
    display: "block",
    marginBottom: 7,
    fontSize: 12,
    color: "#5A4E48",
    fontWeight: 700,
  } as React.CSSProperties,
  creatorRow: {
    display: "flex",
    gap: 6,
  } as React.CSSProperties,
  creatorInput: {
    flex: 1,
    minWidth: 0,
    height: 34,
    borderRadius: 8,
    border: "1px solid rgba(100,90,82,0.16)",
    background: "#FFFFFF",
    color: "#4F4640",
    padding: "0 10px",
    fontSize: 13,
    outline: "none",
  } as React.CSSProperties,
  creatorSubmit: {
    width: 54,
    borderRadius: 8,
    border: "1px solid rgba(100,90,82,0.16)",
    background: "#E8DFD5",
    color: "#4F4640",
    cursor: "pointer",
    fontSize: 12,
    fontWeight: 700,
  } as React.CSSProperties,
  creatorHint: {
    marginTop: 6,
    fontSize: 11,
    color: "#8A7E76",
  } as React.CSSProperties,
  creatorError: {
    marginTop: 6,
    fontSize: 11,
    color: "#B96858",
  } as React.CSSProperties,
  referenceText: {
    display: "block",
    fontSize: 12,
    color: "#7A6E66",
    marginBottom: 8,
  } as React.CSSProperties,
  referenceActions: {
    display: "flex",
    gap: 8,
  } as React.CSSProperties,
  smallButton: {
    flex: 1,
    padding: "7px 10px",
    borderRadius: 8,
    border: "1px solid rgba(100,90,82,0.18)",
    background: "#EEE7DF",
    color: "#5A4E48",
    cursor: "pointer",
    fontSize: 12,
    fontWeight: 700,
  } as React.CSSProperties,
  ghostButton: {
    padding: "7px 10px",
    borderRadius: 8,
    border: "1px solid rgba(100,90,82,0.12)",
    background: "transparent",
    color: "#8A7E76",
    cursor: "pointer",
    fontSize: 12,
  } as React.CSSProperties,
  treeArea: {
    flex: 1,
    overflowY: "auto",
    padding: "6px 0 18px",
  } as React.CSSProperties,
  empty: {
    padding: 14,
    color: "#9A8E86",
    fontSize: 12,
    lineHeight: 1.55,
  } as React.CSSProperties,
  error: {
    padding: 14,
    color: "#B96858",
    fontSize: 12,
    lineHeight: 1.55,
  } as React.CSSProperties,
  list: {
    listStyle: "none",
    margin: 0,
    padding: 0,
  } as React.CSSProperties,
  item: {
    margin: 0,
    padding: 0,
  } as React.CSSProperties,
  nodeButton: {
    width: "100%",
    display: "flex",
    alignItems: "center",
    gap: 7,
    minHeight: 28,
    border: "none",
    background: "transparent",
    textAlign: "left",
    fontSize: 12,
  } as React.CSSProperties,
  disclosure: {
    width: 26,
    flexShrink: 0,
    color: "#8B8179",
    fontSize: 10,
  } as React.CSSProperties,
  nodeName: {
    flex: 1,
    minWidth: 0,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  } as React.CSSProperties,
  check: {
    width: 18,
    color: "#8B8FCC",
    flexShrink: 0,
    textAlign: "center",
  } as React.CSSProperties,
};
