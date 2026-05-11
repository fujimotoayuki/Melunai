import React from "react";

import type {
  DocumentGenerationPlan,
  DocumentGenerationResult,
  GeneratedDocumentKind,
} from "../../types/index.js";

interface DocumentGenerationPanelProps {
  outputKind: GeneratedDocumentKind;
  loading: boolean;
  executing: boolean;
  plan: DocumentGenerationPlan | null;
  result: DocumentGenerationResult | null;
  error: string | null;
  userInput: string;
  onKindChange: (kind: GeneratedDocumentKind) => void;
  onPrepare: () => void;
  onApprove: () => void;
  onReject: () => void;
}

const KIND_LABELS: Record<GeneratedDocumentKind, string> = {
  word: "Word",
  powerpoint: "PowerPoint",
  excel: "Excel",
};

export function DocumentGenerationPanel({
  outputKind,
  loading,
  executing,
  plan,
  result,
  error,
  userInput,
  onKindChange,
  onPrepare,
  onApprove,
  onReject,
}: DocumentGenerationPanelProps): React.ReactElement {
  const canPrepare = userInput.trim().length > 0 && !loading && !executing;
  const canApprove = plan !== null && !executing && !loading;

  return (
    <section style={s.panel}>
      <div style={s.header}>
        <div>
          <div style={s.eyebrow}>Office draft</div>
          <h2 style={s.title}>文書ドラフト作成</h2>
        </div>
        <div style={s.segmented}>
          {(["word", "powerpoint", "excel"] as const).map((kind) => (
            <button
              key={kind}
              type="button"
              style={{
                ...s.segmentButton,
                ...(outputKind === kind ? s.segmentButtonActive : {}),
              }}
              onClick={() => onKindChange(kind)}
              disabled={loading || executing}
            >
              {KIND_LABELS[kind]}
            </button>
          ))}
        </div>
      </div>

      <div style={s.controls}>
        <button type="button" style={s.primaryButton} onClick={onPrepare} disabled={!canPrepare}>
          プレビュー作成
        </button>
        <span style={s.hint}>入力欄の指示から、上書きしない新規ファイル案を作ります。</span>
      </div>

      {error !== null && <div style={s.error}>{error}</div>}

      {plan !== null && (
        <div style={s.preview}>
          <div style={s.previewTop}>
            <div>
              <div style={s.filename}>{plan.draft.proposedFilename}</div>
              <div style={s.path}>{plan.draft.targetPath}</div>
            </div>
            <span style={s.badge}>Draft</span>
          </div>
          <p style={s.disclaimer}>{plan.draft.draftDisclaimer.message}</p>
          {renderDraftDetails(plan)}
          <div style={s.actions}>
            <button type="button" style={s.secondaryButton} onClick={onReject} disabled={executing}>
              キャンセル
            </button>
            <button type="button" style={s.primaryButton} onClick={onApprove} disabled={!canApprove}>
              {executing ? "作成中..." : "承認して作成"}
            </button>
          </div>
        </div>
      )}

      {result !== null && (
        <div style={s.result}>
          作成完了: <strong>{result.targetPath}</strong>
        </div>
      )}
    </section>
  );
}

function renderDraftDetails(plan: DocumentGenerationPlan): React.ReactNode {
  const draft = plan.draft;

  if (draft.kind === "word") {
    return (
      <div style={s.detailList}>
        {draft.sections.map((section) => (
          <div key={section.id} style={s.detailItem}>
            <strong>{section.heading}</strong>
            <span>{section.paragraphs[0] ?? ""}</span>
          </div>
        ))}
      </div>
    );
  }

  if (draft.kind === "powerpoint") {
    return (
      <div style={s.detailList}>
        {draft.slides.map((slide, index) => (
          <div key={slide.id} style={s.detailItem}>
            <strong>{index + 1}. {slide.title}</strong>
            <span>{slide.bullets.slice(0, 2).join(" / ")}</span>
          </div>
        ))}
      </div>
    );
  }

  return (
    <div style={s.detailList}>
      {draft.sheets.map((sheet) => (
        <div key={sheet.id} style={s.detailItem}>
          <strong>{sheet.name}</strong>
          <span>{sheet.columns.map((column) => column.header).join(" / ")}</span>
        </div>
      ))}
    </div>
  );
}

const s = {
  panel: {
    border: "1px solid rgba(100,90,82,0.12)",
    background: "rgba(255,255,255,0.6)",
    backdropFilter: "blur(12px)",
    WebkitBackdropFilter: "blur(12px)",
    borderRadius: "16px",
    padding: "16px 20px",
    color: "#5A4E48",
  } as React.CSSProperties,
  header: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: "12px",
  } as React.CSSProperties,
  eyebrow: {
    fontSize: "11px",
    color: "#9A8E86",
    textTransform: "uppercase",
  } as React.CSSProperties,
  title: {
    margin: "2px 0 0",
    fontSize: "15px",
    lineHeight: 1.3,
  } as React.CSSProperties,
  segmented: {
    display: "flex",
    border: "1px solid rgba(100,90,82,0.14)",
    borderRadius: "8px",
    overflow: "hidden",
    flexShrink: 0,
  } as React.CSSProperties,
  segmentButton: {
    border: "none",
    background: "transparent",
    color: "#7A6E66",
    padding: "7px 9px",
    fontSize: "12px",
    cursor: "pointer",
  } as React.CSSProperties,
  segmentButtonActive: {
    background: "rgba(139,143,204,0.18)",
    color: "#5A4E48",
    fontWeight: 600,
  } as React.CSSProperties,
  controls: {
    display: "flex",
    alignItems: "center",
    gap: "10px",
    marginTop: "12px",
    flexWrap: "wrap",
  } as React.CSSProperties,
  hint: {
    color: "#9A8E86",
    fontSize: "12px",
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
    border: "1px solid rgba(100,90,82,0.18)",
    borderRadius: "8px",
    background: "transparent",
    color: "#6A5E56",
    padding: "8px 12px",
    fontSize: "13px",
    cursor: "pointer",
  } as React.CSSProperties,
  error: {
    marginTop: "10px",
    color: "#9B3D3D",
    fontSize: "13px",
  } as React.CSSProperties,
  preview: {
    marginTop: "12px",
    paddingTop: "12px",
    borderTop: "1px solid rgba(100,90,82,0.1)",
  } as React.CSSProperties,
  previewTop: {
    display: "flex",
    justifyContent: "space-between",
    gap: "10px",
  } as React.CSSProperties,
  filename: {
    fontWeight: 700,
    fontSize: "14px",
    wordBreak: "break-word",
  } as React.CSSProperties,
  path: {
    color: "#9A8E86",
    fontSize: "12px",
    marginTop: "2px",
    wordBreak: "break-all",
  } as React.CSSProperties,
  badge: {
    alignSelf: "flex-start",
    color: "#7A6E66",
    background: "rgba(100,90,82,0.08)",
    borderRadius: "8px",
    padding: "3px 8px",
    fontSize: "11px",
  } as React.CSSProperties,
  disclaimer: {
    color: "#7A6E66",
    fontSize: "12px",
    lineHeight: 1.5,
  } as React.CSSProperties,
  detailList: {
    display: "flex",
    flexDirection: "column",
    gap: "8px",
  } as React.CSSProperties,
  detailItem: {
    display: "flex",
    flexDirection: "column",
    gap: "3px",
    padding: "8px",
    background: "rgba(250,246,241,0.76)",
    borderRadius: "8px",
    fontSize: "12px",
    lineHeight: 1.45,
  } as React.CSSProperties,
  actions: {
    display: "flex",
    justifyContent: "flex-end",
    gap: "8px",
    marginTop: "12px",
  } as React.CSSProperties,
  result: {
    marginTop: "10px",
    color: "#3D7054",
    fontSize: "13px",
    wordBreak: "break-all",
  } as React.CSSProperties,
};
