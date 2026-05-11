import React from "react";
import type { ActionPreviewState } from "../state/appState.js";
import type { FileAction, ValidationIssue } from "../../types/index.js";

interface ActionPreviewPanelProps {
  preview: ActionPreviewState;
  phase: "idle" | "planning" | "approval" | "executing" | "done";
  executionSummary: string | null;
  onApprove: () => void;
  onReject: () => void;
}

export function ActionPreviewPanel({
  preview,
  phase,
  executionSummary,
  onApprove,
  onReject,
}: ActionPreviewPanelProps): React.ReactElement | null {
  const { actionPlan, validationResult } = preview;
  const hasBlockingIssues = validationResult !== null && !validationResult.executable;
  const isApprovalPhase = phase === "approval";
  const isDone = phase === "done";

  // Don't render anything when idle with no plan
  if (actionPlan === null && executionSummary === null) return null;

  return (
    <div style={s.card}>
      {/* Header row */}
      <div style={s.header}>
        <span style={s.headerLabel}>アクションプレビュー</span>
        <div style={s.badges}>
          {hasBlockingIssues && <span style={s.blockedBadge}>✕ ブロック中</span>}
          {!hasBlockingIssues && validationResult !== null && !isDone && (
            <span style={s.okBadge}>実行可能</span>
          )}
          {isDone && executionSummary !== null && (
            <span style={s.doneBadge}>完了</span>
          )}
        </div>
      </div>

      {/* Summary */}
      {actionPlan !== null && (
        <p style={s.summary}>{actionPlan.summary}</p>
      )}

      {/* Validation issues — hide the always-present symlink informational note */}
      {validationResult !== null && (
        (() => {
          const visibleIssues = validationResult.issues.filter(
            (i) => i.code !== "symlink_unsupported",
          );
          if (visibleIssues.length === 0) return null;
          return (
            <div style={s.issueList}>
              {visibleIssues.map((issue, i) => (
                <IssueRow key={i} issue={issue} />
              ))}
            </div>
          );
        })()
      )}

      {/* Action rows */}
      {actionPlan !== null && (
        <div style={s.actionList}>
          {actionPlan.actions.map((action, i) => {
            const isBlocked =
              validationResult !== null &&
              !validationResult.validatedActions.some((v) => v.id === action.id);
            return (
              <ActionRow key={action.id} action={action} index={i + 1} isBlocked={isBlocked} />
            );
          })}
        </div>
      )}

      {/* Execution result */}
      {executionSummary !== null && (
        <div style={s.execSummary}>{executionSummary}</div>
      )}

      {/* Approve / reject */}
      {isApprovalPhase && (
        <div style={s.approvalBar}>
          <button
            style={{
              ...s.approveBtn,
              opacity: hasBlockingIssues ? 0.4 : 1,
              cursor: hasBlockingIssues ? "not-allowed" : "pointer",
            }}
            onClick={onApprove}
            disabled={hasBlockingIssues}
            title={hasBlockingIssues ? "安全上の問題があるため実行できません" : undefined}
          >
            承認して実行
          </button>
          <button style={s.rejectBtn} onClick={onReject}>
            キャンセル
          </button>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// ActionRow
// ---------------------------------------------------------------------------

function ActionRow({
  action,
  index,
  isBlocked,
}: {
  action: FileAction;
  index: number;
  isBlocked: boolean;
}): React.ReactElement {
  const isGenerate =
    action.type === "generate_word" ||
    action.type === "generate_powerpoint" ||
    action.type === "generate_excel";

  return (
    <div
      style={{
        ...s.actionRow,
        opacity: isBlocked ? 0.55 : 1,
        borderColor: isBlocked ? "rgba(180,80,80,0.25)" : "rgba(100,90,82,0.1)",
        flexDirection: isGenerate ? "column" : "row",
        alignItems: isGenerate ? "stretch" : "center",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: "10px", width: "100%" }}>
        <span style={s.actionIndex}>{index}</span>
        <div style={s.actionBody}>
          <span style={s.actionType}>
            {isBlocked && <span style={s.blockedTag}>ブロック</span>}
            {isGenerate && <span style={s.draftTag}>Draft</span>}
            {getActionLabel(action)}
          </span>
          <span style={s.actionDetail}>{getActionDetail(action)}</span>
        </div>
      </div>
      {isGenerate && <DocumentOutlinePreview action={action} />}
    </div>
  );
}

// ---------------------------------------------------------------------------
// DocumentOutlinePreview — shows section/slide/sheet structure for generate_*
// ---------------------------------------------------------------------------

function DocumentOutlinePreview({ action }: { action: FileAction }): React.ReactElement | null {
  if (action.type === "generate_word") {
    return (
      <div style={s.outline}>
        {action.purpose !== undefined && <p style={s.outlinePurpose}>{action.purpose}</p>}
        {action.sections.slice(0, 8).map((sec) => (
          <div key={sec.id} style={s.outlineItem}>
            <strong style={s.outlineHeading}>{sec.heading}</strong>
            {sec.paragraphs[0] !== undefined && (
              <span style={s.outlineSnippet}>{truncate(sec.paragraphs[0], 90)}</span>
            )}
            {sec.bullets !== undefined && sec.bullets.length > 0 && (
              <span style={s.outlineMeta}>• {sec.bullets.slice(0, 3).join(" / ")}</span>
            )}
          </div>
        ))}
        {action.sections.length > 8 && (
          <span style={s.outlineMeta}>他 {action.sections.length - 8} セクション</span>
        )}
      </div>
    );
  }

  if (action.type === "generate_powerpoint") {
    return (
      <div style={s.outline}>
        {action.purpose !== undefined && <p style={s.outlinePurpose}>{action.purpose}</p>}
        {action.slides.slice(0, 10).map((slide, i) => (
          <div key={slide.id} style={s.outlineItem}>
            <strong style={s.outlineHeading}>{i + 1}. {slide.title}</strong>
            {slide.bullets.length > 0 && (
              <span style={s.outlineSnippet}>{slide.bullets.slice(0, 3).join(" / ")}</span>
            )}
          </div>
        ))}
        {action.slides.length > 10 && (
          <span style={s.outlineMeta}>他 {action.slides.length - 10} スライド</span>
        )}
      </div>
    );
  }

  if (action.type === "generate_excel") {
    return (
      <div style={s.outline}>
        {action.purpose !== undefined && <p style={s.outlinePurpose}>{action.purpose}</p>}
        {action.sheets.map((sheet) => (
          <div key={sheet.id} style={s.outlineItem}>
            <strong style={s.outlineHeading}>{sheet.name}</strong>
            <span style={s.outlineSnippet}>
              {sheet.columns.map((c) => c.header).join(" / ")}
            </span>
            {sheet.sampleRows !== undefined && sheet.sampleRows.length > 0 && (
              <span style={s.outlineMeta}>サンプル {sheet.sampleRows.length} 行</span>
            )}
          </div>
        ))}
      </div>
    );
  }

  return null;
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}

// ---------------------------------------------------------------------------
// IssueRow
// ---------------------------------------------------------------------------

function IssueRow({ issue }: { issue: ValidationIssue }): React.ReactElement {
  const isBlock = issue.level === "blocked";
  return (
    <div
      style={{
        ...s.issueRow,
        background: isBlock ? "rgba(200,80,80,0.06)" : "rgba(180,140,60,0.06)",
        borderColor: isBlock ? "rgba(200,80,80,0.2)" : "rgba(180,140,60,0.2)",
        color: isBlock ? "#C06060" : "#8A7040",
      }}
    >
      <span style={{ fontWeight: 600, marginRight: 6 }}>{isBlock ? "✕" : "⚠"}</span>
      {issue.message}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getActionLabel(action: FileAction): string {
  switch (action.type) {
    case "create_folder":       return "フォルダを作成";
    case "create_file":         return "ファイルを作成";
    case "move_file":           return "ファイルを移動";
    case "rename_file":         return "ファイルをリネーム";
    case "generate_word":       return "Word ドラフトを作成";
    case "generate_powerpoint": return "PowerPoint ドラフトを作成";
    case "generate_excel":      return "Excel ドラフトを作成";
  }
}

function getActionDetail(action: FileAction): string {
  switch (action.type) {
    case "create_folder":
    case "create_file":         return action.path;
    case "move_file":
    case "rename_file":         return `${action.from} → ${action.to}`;
    case "generate_word":
    case "generate_powerpoint":
    case "generate_excel":      return action.path;
  }
}

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------

const s = {
  card: {
    width: "100%",
    background: "rgba(255,255,255,0.6)",
    backdropFilter: "blur(12px)",
    WebkitBackdropFilter: "blur(12px)",
    border: "1px solid rgba(100,90,82,0.12)",
    borderRadius: "16px",
    padding: "16px 20px",
    display: "flex",
    flexDirection: "column",
    gap: "12px",
  } as React.CSSProperties,

  header: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
  } as React.CSSProperties,

  headerLabel: {
    fontSize: "11px",
    fontWeight: 600,
    color: "#A09890",
    letterSpacing: "0.4px",
    textTransform: "uppercase" as const,
  } as React.CSSProperties,

  badges: {
    display: "flex",
    gap: "6px",
  } as React.CSSProperties,

  blockedBadge: {
    fontSize: "11px",
    color: "#C06060",
    background: "rgba(200,80,80,0.08)",
    border: "1px solid rgba(200,80,80,0.2)",
    borderRadius: "20px",
    padding: "2px 10px",
    fontWeight: 600,
  } as React.CSSProperties,

  okBadge: {
    fontSize: "11px",
    color: "#6A8A5A",
    background: "rgba(100,150,80,0.08)",
    border: "1px solid rgba(100,150,80,0.2)",
    borderRadius: "20px",
    padding: "2px 10px",
    fontWeight: 600,
  } as React.CSSProperties,

  doneBadge: {
    fontSize: "11px",
    color: "#7880C4",
    background: "rgba(120,128,200,0.08)",
    border: "1px solid rgba(120,128,200,0.2)",
    borderRadius: "20px",
    padding: "2px 10px",
    fontWeight: 600,
  } as React.CSSProperties,

  summary: {
    margin: 0,
    fontSize: "13px",
    color: "#6A5E56",
    lineHeight: 1.6,
  } as React.CSSProperties,

  issueList: {
    display: "flex",
    flexDirection: "column",
    gap: "6px",
  } as React.CSSProperties,

  issueRow: {
    fontSize: "12px",
    padding: "6px 10px",
    borderRadius: "8px",
    border: "1px solid",
    lineHeight: 1.5,
    display: "flex",
    alignItems: "flex-start",
  } as React.CSSProperties,

  actionList: {
    display: "flex",
    flexDirection: "column",
    gap: "6px",
  } as React.CSSProperties,

  actionRow: {
    display: "flex",
    alignItems: "center",
    gap: "10px",
    padding: "8px 12px",
    background: "rgba(100,90,82,0.04)",
    border: "1px solid",
    borderRadius: "10px",
  } as React.CSSProperties,

  actionIndex: {
    width: "20px",
    height: "20px",
    borderRadius: "50%",
    background: "rgba(100,90,82,0.1)",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    fontSize: "11px",
    fontWeight: 700,
    color: "#9A8E86",
    flexShrink: 0,
    textAlign: "center" as const,
    lineHeight: "20px",
  } as React.CSSProperties,

  actionBody: {
    flex: 1,
    display: "flex",
    flexDirection: "column",
    gap: "2px",
    minWidth: 0,
  } as React.CSSProperties,

  actionType: {
    fontSize: "13px",
    color: "#5A4E48",
    fontWeight: 500,
    display: "flex",
    alignItems: "center",
    gap: "6px",
  } as React.CSSProperties,

  blockedTag: {
    fontSize: "10px",
    color: "#C06060",
    background: "rgba(200,80,80,0.08)",
    border: "1px solid rgba(200,80,80,0.2)",
    borderRadius: "4px",
    padding: "1px 5px",
    fontWeight: 600,
  } as React.CSSProperties,

  draftTag: {
    fontSize: "10px",
    color: "#7880C4",
    background: "rgba(139,143,204,0.1)",
    border: "1px solid rgba(139,143,204,0.25)",
    borderRadius: "4px",
    padding: "1px 5px",
    fontWeight: 600,
    letterSpacing: "0.3px",
    textTransform: "uppercase" as const,
  } as React.CSSProperties,

  outline: {
    marginTop: "10px",
    marginLeft: "30px",
    display: "flex",
    flexDirection: "column",
    gap: "6px",
    paddingTop: "8px",
    borderTop: "1px solid rgba(100,90,82,0.08)",
  } as React.CSSProperties,

  outlinePurpose: {
    margin: 0,
    fontSize: "12px",
    color: "#8A7E76",
    fontStyle: "italic",
    lineHeight: 1.5,
  } as React.CSSProperties,

  outlineItem: {
    display: "flex",
    flexDirection: "column",
    gap: "2px",
    padding: "6px 10px",
    background: "rgba(250,246,241,0.5)",
    borderRadius: "8px",
  } as React.CSSProperties,

  outlineHeading: {
    fontSize: "12px",
    color: "#5A4E48",
    fontWeight: 600,
  } as React.CSSProperties,

  outlineSnippet: {
    fontSize: "11px",
    color: "#7A6E66",
    lineHeight: 1.55,
  } as React.CSSProperties,

  outlineMeta: {
    fontSize: "10px",
    color: "#A09890",
    letterSpacing: "0.2px",
  } as React.CSSProperties,

  actionDetail: {
    fontSize: "11px",
    color: "#B0A49C",
    fontFamily: "monospace",
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  } as React.CSSProperties,

  execSummary: {
    fontSize: "13px",
    color: "#6A5E56",
    lineHeight: 1.65,
    whiteSpace: "pre-wrap",
    padding: "8px 12px",
    background: "rgba(100,90,82,0.04)",
    borderRadius: "10px",
    border: "1px solid rgba(100,90,82,0.08)",
  } as React.CSSProperties,

  approvalBar: {
    display: "flex",
    gap: "8px",
    paddingTop: "4px",
  } as React.CSSProperties,

  approveBtn: {
    flex: 1,
    padding: "9px 16px",
    background: "rgba(100,90,82,0.1)",
    border: "1px solid rgba(100,90,82,0.18)",
    borderRadius: "10px",
    fontSize: "13px",
    fontWeight: 600,
    color: "#5A4E48",
    letterSpacing: "0.2px",
  } as React.CSSProperties,

  rejectBtn: {
    flex: 1,
    padding: "9px 16px",
    background: "transparent",
    border: "1px solid rgba(100,90,82,0.15)",
    borderRadius: "10px",
    fontSize: "13px",
    fontWeight: 500,
    color: "#B0A49C",
    cursor: "pointer",
    letterSpacing: "0.2px",
  } as React.CSSProperties,
};
