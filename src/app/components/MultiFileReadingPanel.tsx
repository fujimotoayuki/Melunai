import React from "react";

import type { FileNode, MultiFileReadResult } from "../../types/index.js";

interface MultiFileReadingPanelProps {
  fileTree: FileNode[];
  selectedPaths: string[];
  loading: boolean;
  result: MultiFileReadResult | null;
  error: string | null;
  onToggleFile: (path: string) => void;
  onSelectAll: () => void;
  onClear: () => void;
  onRead: () => void;
}

const SUPPORTED_EXTENSIONS = new Set([".md", ".txt", ".json", ".csv"]);

export function MultiFileReadingPanel({
  fileTree,
  selectedPaths,
  loading,
  result,
  error,
  onToggleFile,
  onSelectAll,
  onClear,
  onRead,
}: MultiFileReadingPanelProps): React.ReactElement | null {
  const supportedFiles = flattenSupportedFiles(fileTree);

  if (supportedFiles.length === 0 && result === null && error === null) {
    return null;
  }

  const includedCount = result?.files.filter((file) => file.content !== undefined).length ?? 0;
  const skippedCount = result?.files.filter((file) => file.content === undefined).length ?? 0;

  return (
    <section style={styles.panel}>
      <div style={styles.header}>
        <div>
          <h2 style={styles.title}>ファイルをまとめて読む</h2>
          <p style={styles.subtitle}>
            対応形式: Markdown / Text / JSON / CSV
          </p>
        </div>
        <div style={styles.actions}>
          <button style={styles.secondaryButton} onClick={onSelectAll} disabled={supportedFiles.length === 0}>
            全選択
          </button>
          <button style={styles.secondaryButton} onClick={onClear} disabled={selectedPaths.length === 0}>
            解除
          </button>
        </div>
      </div>

      {supportedFiles.length > 0 && (
        <div style={styles.fileList}>
          {supportedFiles.map((file) => {
            const checked = selectedPaths.includes(file.path);
            return (
              <label
                key={file.path}
                style={{
                  ...styles.fileRow,
                  borderColor: checked ? "rgba(139,143,204,0.45)" : "rgba(100,90,82,0.12)",
                  background: checked ? "rgba(139,143,204,0.08)" : "rgba(255,255,255,0.55)",
                }}
              >
                <input
                  type="checkbox"
                  checked={checked}
                  onChange={() => onToggleFile(file.path)}
                  style={styles.checkbox}
                />
                <span style={styles.fileName}>{file.name}</span>
                <span style={styles.filePath}>{file.path}</span>
              </label>
            );
          })}
        </div>
      )}

      <div style={styles.footer}>
        <span style={styles.status}>
          {selectedPaths.length}件選択中
        </span>
        <button
          style={{
            ...styles.primaryButton,
            opacity: selectedPaths.length === 0 || loading ? 0.45 : 1,
          }}
          onClick={onRead}
          disabled={selectedPaths.length === 0 || loading}
        >
          {loading ? "読み取り中..." : "まとめて読む"}
        </button>
      </div>

      {error !== null && (
        <div style={styles.error}>{error}</div>
      )}

      {result !== null && (
        <div style={styles.result}>
          <div style={styles.resultHeader}>
            <span>読み取り結果</span>
            <span style={styles.resultMeta}>
              読み取り {includedCount} / スキップ {skippedCount}
            </span>
          </div>
          {result.combinedSummary !== undefined && (
            <p style={styles.summary}>{result.combinedSummary.summary}</p>
          )}

          {result.files.length > 0 && (
            <div style={styles.sourceList}>
              {result.files.map((file) => (
                <div key={file.path} style={styles.sourceRow}>
                  <span style={styles.sourceName}>{file.name}</span>
                  <span style={statusStyle(file.status)}>
                    {statusLabel(file.status)}
                  </span>
                  {file.skipReason !== undefined && (
                    <span style={styles.reason}>{file.skipReason}</span>
                  )}
                </div>
              ))}
            </div>
          )}

          {result.perFileSummaries.length > 0 && (
            <div style={styles.summaryList}>
              {result.perFileSummaries.map((summary) => (
                <div key={summary.path} style={styles.summaryItem}>
                  <strong style={styles.summaryTitle}>{summary.title ?? summary.path}</strong>
                  <p style={styles.summaryText}>{summary.summary}</p>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </section>
  );
}

function flattenSupportedFiles(nodes: FileNode[]): FileNode[] {
  const files: FileNode[] = [];

  function walk(currentNodes: FileNode[]): void {
    for (const node of currentNodes) {
      if (node.type === "file" && SUPPORTED_EXTENSIONS.has(node.extension ?? "")) {
        files.push(node);
      }
      if (node.type === "directory" && node.children !== undefined) {
        walk(node.children);
      }
    }
  }

  walk(nodes);
  return files;
}

function statusLabel(status: string): string {
  switch (status) {
    case "included":
      return "読込";
    case "truncated":
      return "一部";
    case "unsupported":
      return "未対応";
    case "failed":
      return "失敗";
    default:
      return "スキップ";
  }
}

function statusStyle(status: string): React.CSSProperties {
  const color =
    status === "included" ? "#59705D" :
      status === "truncated" ? "#9B6D36" :
        status === "unsupported" ? "#8A7167" :
          status === "failed" ? "#A45454" :
            "#8A7167";

  return {
    ...styles.badge,
    color,
    borderColor: `${color}55`,
    background: `${color}12`,
  };
}

const styles = {
  panel: {
    width: "100%",
    border: "1px solid rgba(100,90,82,0.12)",
    background: "rgba(255,255,255,0.6)",
    backdropFilter: "blur(12px)",
    WebkitBackdropFilter: "blur(12px)",
    borderRadius: "16px",
    padding: "16px 20px",
    boxSizing: "border-box",
    color: "#5A4E48",
  } as React.CSSProperties,
  header: {
    display: "flex",
    justifyContent: "space-between",
    gap: "12px",
    alignItems: "flex-start",
  } as React.CSSProperties,
  title: {
    margin: 0,
    fontSize: "14px",
    fontWeight: 700,
    letterSpacing: 0,
  } as React.CSSProperties,
  subtitle: {
    margin: "4px 0 0",
    fontSize: "12px",
    color: "#8A7E76",
  } as React.CSSProperties,
  actions: {
    display: "flex",
    gap: "6px",
  } as React.CSSProperties,
  fileList: {
    display: "grid",
    gridTemplateColumns: "1fr",
    gap: "6px",
    maxHeight: "180px",
    overflowY: "auto",
    marginTop: "12px",
  } as React.CSSProperties,
  fileRow: {
    display: "grid",
    gridTemplateColumns: "18px minmax(90px, 0.8fr) minmax(120px, 1.2fr)",
    alignItems: "center",
    gap: "8px",
    padding: "8px 10px",
    border: "1px solid rgba(100,90,82,0.12)",
    borderRadius: "6px",
    cursor: "pointer",
  } as React.CSSProperties,
  checkbox: {
    width: "14px",
    height: "14px",
    accentColor: "#8B8FCC",
  } as React.CSSProperties,
  fileName: {
    fontSize: "13px",
    fontWeight: 600,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  } as React.CSSProperties,
  filePath: {
    fontSize: "12px",
    color: "#92867E",
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  } as React.CSSProperties,
  footer: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    marginTop: "12px",
  } as React.CSSProperties,
  status: {
    fontSize: "12px",
    color: "#8A7E76",
  } as React.CSSProperties,
  primaryButton: {
    border: "1px solid rgba(100,90,82,0.18)",
    borderRadius: "10px",
    background: "rgba(100,90,82,0.1)",
    color: "#5A4E48",
    padding: "8px 14px",
    fontSize: "13px",
    fontWeight: 600,
    cursor: "pointer",
  } as React.CSSProperties,
  secondaryButton: {
    border: "1px solid rgba(100,90,82,0.14)",
    borderRadius: "8px",
    background: "rgba(255,255,255,0.62)",
    color: "#6A5E56",
    padding: "6px 9px",
    fontSize: "12px",
    cursor: "pointer",
  } as React.CSSProperties,
  error: {
    marginTop: "10px",
    color: "#A45454",
    fontSize: "13px",
  } as React.CSSProperties,
  result: {
    marginTop: "12px",
    borderTop: "1px solid rgba(100,90,82,0.1)",
    paddingTop: "12px",
  } as React.CSSProperties,
  resultHeader: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    fontSize: "13px",
    fontWeight: 700,
  } as React.CSSProperties,
  resultMeta: {
    fontSize: "12px",
    color: "#8A7E76",
    fontWeight: 400,
  } as React.CSSProperties,
  summary: {
    margin: "8px 0",
    fontSize: "13px",
    color: "#6A5E56",
    lineHeight: 1.6,
  } as React.CSSProperties,
  sourceList: {
    display: "grid",
    gap: "5px",
    marginTop: "8px",
  } as React.CSSProperties,
  sourceRow: {
    display: "grid",
    gridTemplateColumns: "minmax(120px, 1fr) auto auto",
    gap: "8px",
    alignItems: "center",
    fontSize: "12px",
  } as React.CSSProperties,
  sourceName: {
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  } as React.CSSProperties,
  badge: {
    border: "1px solid",
    borderRadius: "999px",
    padding: "2px 7px",
    fontSize: "11px",
  } as React.CSSProperties,
  reason: {
    color: "#9A8E86",
    fontSize: "11px",
  } as React.CSSProperties,
  summaryList: {
    display: "grid",
    gap: "8px",
    marginTop: "12px",
  } as React.CSSProperties,
  summaryItem: {
    padding: "8px 0 0",
    borderTop: "1px solid rgba(100,90,82,0.08)",
  } as React.CSSProperties,
  summaryTitle: {
    display: "block",
    fontSize: "12px",
    color: "#5A4E48",
    marginBottom: "3px",
  } as React.CSSProperties,
  summaryText: {
    margin: 0,
    fontSize: "12px",
    lineHeight: 1.55,
    color: "#7A6E66",
  } as React.CSSProperties,
};
