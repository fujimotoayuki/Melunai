import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

/**
 * Vite configuration for Local File Agent renderer (React frontend)
 *
 * In development: served at http://localhost:1420 (loaded by Electron main process)
 * In production: built to dist/ and loaded by Electron via file:// URL
 *
 * base: "./" — required so all asset paths are relative, which is necessary
 * for production Electron builds that load via file:// URLs.
 */
export default defineConfig({
  plugins: [react()],

  // Use relative paths so the built output works with file:// in Electron
  base: "./",

  // Development server
  // host: "127.0.0.1" を明示することで外部ネットワークからの接続を遮断する。
  // dev サーバはレンダラのソースを露出するため、LAN 内からの覗き見を防ぐ。
  server: {
    host: "127.0.0.1",
    port: 1420,
    strictPort: true,
    cors: false,            // Electron 専用なので CORS 不要
    fs: { strict: true },   // .. を含むパスでの src 外参照を禁止
  },

  // Build output
  // sourcemap: false を明示して、配布用 asar にレンダラの完全ソースが
  // 同梱されないようにする（リバース防御＋配布物軽量化）。
  build: {
    outDir: "dist",
    emptyOutDir: true,
    sourcemap: false,
  },

  // Resolve TypeScript paths
  resolve: {
    extensions: [".tsx", ".ts", ".js"],
  },
});
