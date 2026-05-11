import React from "react";

interface ErrorBoundaryProps {
  children: React.ReactNode;
}

interface ErrorBoundaryState {
  hasError: boolean;
  error: Error | null;
}

export class ErrorBoundary extends React.Component<ErrorBoundaryProps, ErrorBoundaryState> {
  constructor(props: ErrorBoundaryProps) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { hasError: true, error };
  }

  override componentDidCatch(error: Error, info: React.ErrorInfo): void {
    console.error("[Melunai] Render error:", error, info);
  }

  override render(): React.ReactNode {
    if (this.state.hasError) {
      return (
        <div style={styles.wrap}>
          <div style={styles.card}>
            <div style={styles.icon}>⚠</div>
            <div style={styles.title}>表示エラーが発生しました</div>
            <div style={styles.message}>
              {this.state.error?.message ?? "不明なエラー"}
            </div>
            <button
              style={styles.button}
              onClick={() => this.setState({ hasError: false, error: null })}
            >
              再試行
            </button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}

const styles: Record<string, React.CSSProperties> = {
  wrap: {
    position: "fixed",
    inset: 0,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    background: "#1D1D1F",
    zIndex: 9999,
  },
  card: {
    maxWidth: 480,
    padding: "36px 32px",
    borderRadius: 20,
    border: "1px solid rgba(255,255,255,0.10)",
    background: "rgba(38,38,42,0.96)",
    boxShadow: "0 40px 120px rgba(0,0,0,0.6)",
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    gap: 14,
    textAlign: "center",
  },
  icon: {
    fontSize: 36,
    color: "#ffb199",
  },
  title: {
    color: "#F5F5F7",
    fontSize: 18,
    fontWeight: 800,
  },
  message: {
    color: "#A1A1A6",
    fontSize: 13,
    lineHeight: 1.6,
    wordBreak: "break-all",
    maxHeight: 200,
    overflowY: "auto",
  },
  button: {
    marginTop: 8,
    height: 40,
    padding: "0 24px",
    borderRadius: 999,
    border: "none",
    background: "linear-gradient(135deg, #D5F2EA 0%, #9BCFCC 45%, #6E98BC 100%)",
    color: "#1D1D1F",
    fontWeight: 800,
    fontSize: 14,
    cursor: "pointer",
  },
};
