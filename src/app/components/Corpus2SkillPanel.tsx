import React from "react";

import { buildCorpus, loadCorpus, navigateCorpus } from "../bridge/corpusBridge.js";
import type { CorpusIndex, CorpusNavigateHit, CorpusNavigateResult, CorpusSkillNode } from "../electron-api.js";

interface Corpus2SkillPanelProps {
  onClose: () => void;
  onCorpusReady?: (index: CorpusIndex) => void;
}

export function Corpus2SkillPanel({ onClose, onCorpusReady }: Corpus2SkillPanelProps): React.ReactElement {
  const [index, setIndex] = React.useState<CorpusIndex | null>(null);
  const [query, setQuery] = React.useState("");
  const [navigation, setNavigation] = React.useState<CorpusNavigateResult | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [notice, setNotice] = React.useState<string | null>(null);

  const handleBuild = async () => {
    setBusy(true);
    setError(null);
    setNotice(null);
    const result = await buildCorpus();
    setBusy(false);
    if (result.error !== null || result.index === null) {
      setError(result.error);
      return;
    }
    setIndex(result.index);
    onCorpusReady?.(result.index);
    setNavigation(null);
    setNotice("資料フォルダを読み込みました。チャットで参照できる状態です。");
  };

  const handleLoad = async () => {
    setBusy(true);
    setError(null);
    setNotice(null);
    const result = await loadCorpus();
    setBusy(false);
    if (result.error !== null || result.index === null) {
      setError(result.error);
      return;
    }
    setIndex(result.index);
    onCorpusReady?.(result.index);
    setNotice("読み込み済みの資料地図を再利用しました。チャットで参照できる状態です。");
  };

  const handleNavigate = async () => {
    const text = query.trim();
    if (text.length === 0) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    const result = await navigateCorpus(text);
    setBusy(false);
    if (result.error !== null || result.result === null) {
      setError(result.error);
      return;
    }
    setNavigation(result.result);
  };

  return (
    <div style={styles.backdrop}>
      <section style={styles.panel} aria-label="Corpus2Skill">
        <header style={styles.header}>
          <div>
            <div style={styles.kicker}>Corpus2Skill</div>
            <h2 style={styles.title}>文書を“読む地図”に変換</h2>
          </div>
          <button className="ml-btn-glass" style={styles.closeButton} onClick={onClose} title="閉じる">
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
              <path d="M3 3l8 8M11 3l-8 8" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
            </svg>
          </button>
        </header>

        <div style={styles.body}>
          <section style={styles.heroBox}>
            <div>
              <h3 style={styles.heroTitle}>資料フォルダをチャットで参照できるようにする。</h3>
              <p style={styles.heroText}>
                初回や資料を更新した時は「新しく読み込む」。すでに `.melunai/corpus` があるフォルダなら
                「読み込み済みを再利用」で素早く参照できます。
              </p>
            </div>
            <div style={styles.heroActions}>
              <button className="ml-btn-accent" style={styles.primaryButton} onClick={() => void handleBuild()} disabled={busy}>
                資料フォルダを新しく読み込む
              </button>
              <button className="ml-btn-glass" style={styles.secondaryButton} onClick={() => void handleLoad()} disabled={busy}>
                読み込み済み資料を再利用
              </button>
            </div>
          </section>

          {error !== null && <div style={styles.error}>{error}</div>}
          {notice !== null && <div style={styles.notice}>{notice}</div>}

          {index === null ? (
            <div style={styles.emptyState}>
              まず資料フォルダを読み込むと、MelunaiがPDFやOffice文書を探しやすい形に整理します。
              完了後はチャット画面に「参照中」と表示されます。
            </div>
          ) : (
            <div style={styles.grid}>
              <aside style={styles.summaryPane}>
                <div style={styles.statGrid}>
                  <Stat label="indexed" value={String(index.indexedFileCount)} />
                  <Stat label="scanned" value={String(index.totalFilesScanned)} />
                  <Stat label="skipped" value={String(index.skippedFileCount)} />
                  <Stat label="chars" value={formatNumber(index.totalCharsIndexed)} />
                </div>

                <section style={styles.card}>
                  <div style={styles.sectionTitle}>Generated</div>
                  <div style={styles.pathLine}>{index.rootSkillPath}</div>
                  <div style={styles.pathLine}>.melunai/corpus/index.json</div>
                  <div style={styles.pathLine}>.melunai/corpus/tree/*/SKILL.md</div>
                  <div style={styles.pathLine}>.melunai/corpus/docs/*.txt</div>
                </section>

                <section style={styles.card}>
                  <div style={styles.sectionTitle}>Root Keywords</div>
                  <div style={styles.keywordWrap}>
                    {index.root.keywords.length === 0 ? (
                      <span style={styles.muted}>none</span>
                    ) : (
                      index.root.keywords.map((keyword) => <span key={keyword} style={styles.keyword}>{keyword}</span>)
                    )}
                  </div>
                </section>

                {index.warnings.length > 0 && (
                  <section style={styles.card}>
                    <div style={styles.sectionTitle}>Warnings</div>
                    {index.warnings.slice(0, 8).map((warning) => (
                      <div key={warning} style={styles.warningLine}>{warning}</div>
                    ))}
                  </section>
                )}
              </aside>

              <main style={styles.mapPane}>
                <section style={styles.navigateBox}>
                  <input
                    style={styles.input}
                    value={query}
                    onChange={(event) => setQuery(event.currentTarget.value)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") {
                        event.preventDefault();
                        void handleNavigate();
                      }
                    }}
                    placeholder="例: 請求書について / API設計 / 会議メモ"
                  />
                  <button className="ml-btn-accent" style={styles.navButton} onClick={() => void handleNavigate()} disabled={busy || query.trim().length === 0}>
                    探す
                  </button>
                </section>

                {navigation !== null && (
                  <section style={styles.card}>
                    <div style={styles.sectionTitle}>Navigation Hits</div>
                    {navigation.hits.length === 0 ? (
                      <div style={styles.muted}>関連する枝は見つかりませんでした。</div>
                    ) : (
                      <div style={styles.hitList}>
                        {navigation.hits.map((hit) => <HitCard key={`${hit.kind}-${hit.path}`} hit={hit} />)}
                      </div>
                    )}
                    <pre style={styles.navigationPre}>{navigation.navigationMarkdown}</pre>
                  </section>
                )}

                <section style={styles.card}>
                  <div style={styles.sectionTitle}>Skill Tree</div>
                  <SkillTree node={index.root} />
                </section>

                <section style={styles.card}>
                  <div style={styles.sectionTitle}>Documents</div>
                  <div style={styles.documentList}>
                    {index.documents.slice(0, 80).map((document) => (
                      <article key={document.id} style={styles.documentItem}>
                        <div style={styles.documentTop}>
                          <strong>{document.title}</strong>
                          <span style={styles.docBadge}>{document.extension || "text"} · {document.sourceKind} · {document.segmentCount}</span>
                        </div>
                        <div style={styles.pathLine}>{document.path}</div>
                        <p style={styles.preview}>{document.preview}</p>
                      </article>
                    ))}
                  </div>
                </section>
              </main>
            </div>
          )}
        </div>
      </section>
    </div>
  );
}

function Stat(props: { label: string; value: string }): React.ReactElement {
  return (
    <div style={styles.stat}>
      <div style={styles.statValue}>{props.value}</div>
      <div style={styles.statLabel}>{props.label}</div>
    </div>
  );
}

function HitCard({ hit }: { hit: CorpusNavigateHit }): React.ReactElement {
  return (
    <article style={styles.hitCard}>
      <div style={styles.documentTop}>
        <strong>{hit.title}</strong>
        <span style={styles.docBadge}>{hit.kind} · {hit.score}</span>
      </div>
      <div style={styles.pathLine}>{hit.path}</div>
      <p style={styles.preview}>{hit.summary}</p>
      <div style={styles.keywordWrap}>
        {hit.keywords.slice(0, 8).map((keyword) => <span key={keyword} style={styles.keyword}>{keyword}</span>)}
      </div>
    </article>
  );
}

function SkillTree({ node }: { node: CorpusSkillNode }): React.ReactElement {
  return (
    <div style={styles.treeNode}>
      <div style={styles.treeHeader}>
        <span style={styles.treeName}>{node.name}</span>
        <span style={styles.docBadge}>{node.documentIds.length} docs</span>
      </div>
      <div style={styles.pathLine}>{node.skillPath}</div>
      <div style={styles.preview}>{node.summary}</div>
      {node.children.length > 0 && (
        <div style={styles.treeChildren}>
          {node.children.map((child) => <SkillTree key={child.id} node={child} />)}
        </div>
      )}
    </div>
  );
}

function formatNumber(value: number): string {
  return new Intl.NumberFormat("en-US").format(value);
}

const styles = {
  backdrop: {
    position: "fixed",
    inset: 0,
    zIndex: 58,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    padding: 24,
    background: "rgba(0,0,0,0.52)",
    backdropFilter: "blur(18px)",
  } as React.CSSProperties,
  panel: {
    width: "min(1160px, 100%)",
    height: "min(760px, calc(100vh - 48px))",
    display: "flex",
    flexDirection: "column",
    borderRadius: 22,
    border: "1px solid rgba(255,255,255,0.12)",
    background: "linear-gradient(180deg, rgba(38,38,42,0.98), rgba(29,29,31,0.98))",
    boxShadow: "0 40px 120px rgba(0,0,0,0.58)",
    overflow: "hidden",
  } as React.CSSProperties,
  header: {
    height: 70,
    flexShrink: 0,
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    padding: "0 24px",
    borderBottom: "1px solid rgba(255,255,255,0.08)",
  } as React.CSSProperties,
  kicker: {
    color: "#9BCFCC",
    fontSize: 11,
    fontWeight: 900,
    letterSpacing: "0.08em",
    textTransform: "uppercase",
  } as React.CSSProperties,
  title: {
    margin: 0,
    color: "#F5F5F7",
    fontSize: 24,
    lineHeight: 1.1,
  } as React.CSSProperties,
  closeButton: {
    width: 34,
    height: 34,
  } as React.CSSProperties,
  body: {
    flex: 1,
    minHeight: 0,
    overflowY: "auto",
    padding: 22,
  } as React.CSSProperties,
  heroBox: {
    display: "flex",
    justifyContent: "space-between",
    gap: 18,
    padding: 18,
    borderRadius: 18,
    border: "1px solid rgba(255,255,255,0.1)",
    background: "radial-gradient(circle at 0% 0%, rgba(155,207,204,0.12), transparent 42%), rgba(255,255,255,0.045)",
  } as React.CSSProperties,
  heroTitle: {
    margin: 0,
    color: "#F5F5F7",
    fontSize: 22,
  } as React.CSSProperties,
  heroText: {
    maxWidth: 660,
    margin: "9px 0 0",
    color: "#A1A1A6",
    fontSize: 13,
    lineHeight: 1.7,
  } as React.CSSProperties,
  heroActions: {
    display: "flex",
    alignItems: "center",
    gap: 10,
    flexWrap: "wrap",
    justifyContent: "flex-end",
  } as React.CSSProperties,
  primaryButton: {
    height: 40,
    padding: "0 18px",
  } as React.CSSProperties,
  secondaryButton: {
    height: 40,
    padding: "0 18px",
    fontWeight: 800,
  } as React.CSSProperties,
  error: {
    marginTop: 12,
    padding: "10px 12px",
    borderRadius: 12,
    color: "#ffb199",
    background: "rgba(255,120,90,0.09)",
    border: "1px solid rgba(255,120,90,0.16)",
    fontSize: 13,
  } as React.CSSProperties,
  notice: {
    marginTop: 12,
    padding: "10px 12px",
    borderRadius: 12,
    color: "#D5F2EA",
    background: "rgba(155,207,204,0.09)",
    border: "1px solid rgba(155,207,204,0.18)",
    fontSize: 13,
  } as React.CSSProperties,
  emptyState: {
    height: 260,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    color: "#6E6E73",
    textAlign: "center",
  } as React.CSSProperties,
  grid: {
    display: "grid",
    gridTemplateColumns: "300px 1fr",
    gap: 16,
    marginTop: 16,
    alignItems: "start",
  } as React.CSSProperties,
  summaryPane: {
    display: "grid",
    gap: 12,
  } as React.CSSProperties,
  mapPane: {
    display: "grid",
    gap: 12,
    minWidth: 0,
  } as React.CSSProperties,
  statGrid: {
    display: "grid",
    gridTemplateColumns: "1fr 1fr",
    gap: 10,
  } as React.CSSProperties,
  stat: {
    padding: 14,
    borderRadius: 14,
    border: "1px solid rgba(255,255,255,0.08)",
    background: "rgba(255,255,255,0.045)",
  } as React.CSSProperties,
  statValue: {
    color: "#F5F5F7",
    fontSize: 22,
    fontWeight: 900,
  } as React.CSSProperties,
  statLabel: {
    color: "#6E6E73",
    fontSize: 11,
    fontWeight: 800,
    textTransform: "uppercase",
  } as React.CSSProperties,
  card: {
    padding: 14,
    borderRadius: 16,
    border: "1px solid rgba(255,255,255,0.08)",
    background: "rgba(255,255,255,0.045)",
  } as React.CSSProperties,
  sectionTitle: {
    marginBottom: 10,
    color: "#F5F5F7",
    fontSize: 13,
    fontWeight: 900,
  } as React.CSSProperties,
  pathLine: {
    color: "#6E98BC",
    fontSize: 12,
    lineHeight: 1.6,
    wordBreak: "break-all",
  } as React.CSSProperties,
  keywordWrap: {
    display: "flex",
    flexWrap: "wrap",
    gap: 6,
  } as React.CSSProperties,
  keyword: {
    display: "inline-flex",
    alignItems: "center",
    minHeight: 22,
    padding: "0 9px",
    borderRadius: 999,
    color: "#1D1D1F",
    background: "linear-gradient(135deg, #D5F2EA, #6E98BC)",
    fontSize: 11,
    fontWeight: 900,
  } as React.CSSProperties,
  muted: {
    color: "#6E6E73",
    fontSize: 13,
  } as React.CSSProperties,
  warningLine: {
    color: "#ffb199",
    fontSize: 12,
    lineHeight: 1.5,
    marginTop: 6,
  } as React.CSSProperties,
  navigateBox: {
    display: "grid",
    gridTemplateColumns: "1fr auto",
    gap: 10,
  } as React.CSSProperties,
  input: {
    width: "100%",
    height: 42,
    borderRadius: 999,
    border: "1px solid rgba(255,255,255,0.1)",
    background: "rgba(255,255,255,0.06)",
    color: "#F5F5F7",
    outline: "none",
    padding: "0 15px",
    fontFamily: "inherit",
  } as React.CSSProperties,
  navButton: {
    height: 42,
    minWidth: 84,
    padding: "0 18px",
  } as React.CSSProperties,
  hitList: {
    display: "grid",
    gap: 10,
  } as React.CSSProperties,
  navigationPre: {
    margin: "12px 0 0",
    maxHeight: 220,
    overflow: "auto",
    padding: 12,
    borderRadius: 12,
    border: "1px solid rgba(255,255,255,0.08)",
    background: "rgba(0,0,0,0.22)",
    color: "#D5F2EA",
    fontSize: 12,
    lineHeight: 1.5,
    whiteSpace: "pre-wrap",
    wordBreak: "break-word",
  } as React.CSSProperties,
  hitCard: {
    padding: 12,
    borderRadius: 14,
    border: "1px solid rgba(155,207,204,0.15)",
    background: "rgba(155,207,204,0.055)",
  } as React.CSSProperties,
  documentList: {
    display: "grid",
    gap: 10,
  } as React.CSSProperties,
  documentItem: {
    padding: 12,
    borderRadius: 14,
    border: "1px solid rgba(255,255,255,0.08)",
    background: "rgba(0,0,0,0.16)",
  } as React.CSSProperties,
  documentTop: {
    display: "flex",
    justifyContent: "space-between",
    gap: 12,
    color: "#F5F5F7",
    fontSize: 13,
  } as React.CSSProperties,
  docBadge: {
    display: "inline-flex",
    alignItems: "center",
    height: 22,
    padding: "0 8px",
    borderRadius: 999,
    background: "rgba(255,255,255,0.08)",
    color: "#A1A1A6",
    fontSize: 11,
    fontWeight: 800,
    whiteSpace: "nowrap",
  } as React.CSSProperties,
  preview: {
    margin: "8px 0 0",
    color: "#A1A1A6",
    fontSize: 12,
    lineHeight: 1.55,
  } as React.CSSProperties,
  treeNode: {
    padding: 12,
    borderRadius: 14,
    border: "1px solid rgba(255,255,255,0.08)",
    background: "rgba(0,0,0,0.14)",
    marginTop: 8,
  } as React.CSSProperties,
  treeHeader: {
    display: "flex",
    justifyContent: "space-between",
    gap: 10,
  } as React.CSSProperties,
  treeName: {
    color: "#F5F5F7",
    fontSize: 13,
    fontWeight: 900,
  } as React.CSSProperties,
  treeChildren: {
    marginTop: 8,
    paddingLeft: 14,
    borderLeft: "1px solid rgba(255,255,255,0.08)",
  } as React.CSSProperties,
} as const;
