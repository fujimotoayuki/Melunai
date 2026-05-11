import React from "react";
import ReactDOM from "react-dom/client";
import "./melunai.css";
import { App } from "./App.js";
import { ErrorBoundary } from "./components/ErrorBoundary.js";

/**
 * アプリケーションエントリーポイント
 *
 * React renderer entry point. Vite bundles this file for Electron's renderer
 * process, while privileged filesystem and model operations stay behind the
 * Electron preload/main-process boundary.
 */

// 非同期エラーの安全網。React の ErrorBoundary は同期 render エラーしか捕捉できないため、
// `void persistConversation(...).then(...)` のような握りつぶし系の rejection が
// 静かに消えるのを防ぐ。少なくとも console に痕跡を残すことで本番デバッグを助ける。
window.addEventListener("unhandledrejection", (event) => {
  // eslint-disable-next-line no-console
  console.error("[Melunai] Unhandled promise rejection:", event.reason);
});
window.addEventListener("error", (event) => {
  // eslint-disable-next-line no-console
  console.error("[Melunai] Uncaught error:", event.error ?? event.message);
});

const container = document.getElementById("root");

if (container === null) {
  throw new Error("ルートDOM要素が見つかりません。index.htmlに id='root' の要素が必要です。");
}

const root = ReactDOM.createRoot(container);

root.render(
  <React.StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </React.StrictMode>,
);
