import React from "react";

interface ModelSelectorProps {
  availableModels: string[];
  selectedModel: string;
  loading: boolean;
  error: string | null;
  onModelChange: (model: string) => void;
  onRefresh: () => void;
}

/**
 * モデル選択コンポーネント
 *
 * Displays a dropdown of available Ollama models.
 * Refresh button triggers a new listModels call (wired in TASK-011).
 * The selected model is kept in AppState and passed down from App.
 */
export function ModelSelector({
  availableModels,
  selectedModel,
  loading,
  error,
  onModelChange,
  onRefresh,
}: ModelSelectorProps): React.ReactElement {
  return (
    <div style={styles.container}>
      <label style={styles.label} htmlFor="model-select">
        モデル
      </label>

      {loading ? (
        <span style={styles.loading}>読み込み中...</span>
      ) : (
        <select
          id="model-select"
          style={styles.select}
          value={selectedModel}
          onChange={(e) => onModelChange(e.target.value)}
          disabled={availableModels.length === 0}
        >
          {availableModels.length === 0 ? (
            <option value="">モデルが見つかりません</option>
          ) : (
            availableModels.map((model) => (
              <option key={model} value={model}>
                {model}
              </option>
            ))
          )}
        </select>
      )}

      <button style={styles.refreshButton} onClick={onRefresh} disabled={loading}>
        更新
      </button>

      {error !== null && <span style={styles.error}>{error}</span>}
    </div>
  );
}

const styles = {
  container: {
    display: "flex",
    alignItems: "center",
    gap: "8px",
    padding: "8px 12px",
    background: "#1e1e2e",
    borderBottom: "1px solid #313244",
  } as React.CSSProperties,
  label: {
    fontSize: "13px",
    color: "#cdd6f4",
    fontWeight: 600,
    whiteSpace: "nowrap",
  } as React.CSSProperties,
  select: {
    background: "#313244",
    color: "#cdd6f4",
    border: "1px solid #45475a",
    borderRadius: "4px",
    padding: "4px 8px",
    fontSize: "13px",
    minWidth: "180px",
    cursor: "pointer",
  } as React.CSSProperties,
  refreshButton: {
    background: "#313244",
    color: "#cdd6f4",
    border: "1px solid #45475a",
    borderRadius: "4px",
    padding: "4px 10px",
    fontSize: "13px",
    cursor: "pointer",
  } as React.CSSProperties,
  loading: {
    fontSize: "13px",
    color: "#6c7086",
  } as React.CSSProperties,
  error: {
    fontSize: "12px",
    color: "#f38ba8",
    marginLeft: "4px",
  } as React.CSSProperties,
};
