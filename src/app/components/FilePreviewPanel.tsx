import React from "react";
import type { FilePreviewState } from "../state/appState.js";

interface FilePreviewPanelProps {
  preview: FilePreviewState;
}

/**
 * ファイルプレビューパネル
 *
 * Displays the content of the selected file.
 * The content is loaded by the parent (App) when the user clicks a file in WorkspacePanel.
 * Content is truncated at readFile's limit and marked with a notice if so.
 *
 * Supported types: .txt, .md, .json, .csv (per PR-006)
 * Unsupported files show a clear notice (per PR-007)
 */
export function FilePreviewPanel({ preview }: FilePreviewPanelProps): React.ReactElement {
  if (preview.path === null) {
    return (
      <div style={styles.container}>
        <div style={styles.header}>
          <span style={styles.headerTitle}>ファイルプレビュー</span>
        </div>
        <div style={styles.emptyState}>
          <span style={styles.emptyIcon}>📄</span>
          <span style={styles.emptyText}>ファイルを選択すると内容が表示されます</span>
        </div>
      </div>
    );
  }

  return (
    <div style={styles.container}>
      {/* Header */}
      <div style={styles.header}>
        <span style={styles.headerTitle}>ファイルプレビュー</span>
        <span style={styles.filePath} title={preview.path}>
          {preview.path}
        </span>
      </div>

      {/* Content area */}
      <div style={styles.content}>
        {preview.loading && (
          <div style={styles.statusText}>読み込み中...</div>
        )}

        {!preview.loading && preview.error !== null && (
          <div style={styles.errorText}>{preview.error}</div>
        )}

        {!preview.loading && preview.error === null && preview.content !== null && (
          <>
            {preview.truncated && (
              <div style={styles.truncationNotice}>
                ⚠ ファイルが大きいため、先頭部分のみ表示しています
              </div>
            )}
            <pre style={styles.preContent}>{preview.content}</pre>
          </>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------

const styles = {
  container: {
    display: "flex",
    flexDirection: "column",
    height: "100%",
    background: "#181825",
    overflow: "hidden",
    borderTop: "1px solid #313244",
  } as React.CSSProperties,
  header: {
    display: "flex",
    alignItems: "center",
    gap: "8px",
    padding: "6px 10px",
    borderBottom: "1px solid #313244",
    flexShrink: 0,
  } as React.CSSProperties,
  headerTitle: {
    fontSize: "12px",
    fontWeight: 700,
    color: "#6c7086",
    textTransform: "uppercase",
    letterSpacing: "0.5px",
    flexShrink: 0,
  } as React.CSSProperties,
  filePath: {
    fontSize: "11px",
    color: "#89b4fa",
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  } as React.CSSProperties,
  content: {
    flex: 1,
    overflowY: "auto",
    position: "relative",
  } as React.CSSProperties,
  emptyState: {
    flex: 1,
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    justifyContent: "center",
    gap: "8px",
    padding: "16px",
    color: "#6c7086",
  } as React.CSSProperties,
  emptyIcon: {
    fontSize: "24px",
  } as React.CSSProperties,
  emptyText: {
    fontSize: "12px",
    textAlign: "center",
  } as React.CSSProperties,
  statusText: {
    padding: "12px",
    fontSize: "13px",
    color: "#6c7086",
  } as React.CSSProperties,
  errorText: {
    padding: "12px",
    fontSize: "13px",
    color: "#f38ba8",
  } as React.CSSProperties,
  truncationNotice: {
    padding: "6px 12px",
    background: "#2a2020",
    borderBottom: "1px solid #45475a",
    fontSize: "11px",
    color: "#fab387",
    flexShrink: 0,
  } as React.CSSProperties,
  preContent: {
    margin: 0,
    padding: "10px 12px",
    fontSize: "12px",
    fontFamily: "monospace",
    color: "#cdd6f4",
    whiteSpace: "pre-wrap",
    wordBreak: "break-all",
    lineHeight: 1.6,
    overflowX: "auto",
  } as React.CSSProperties,
};
