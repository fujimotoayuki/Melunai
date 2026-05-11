import type { CanvasDocument, CanvasMarkdownEditMode, CanvasMarkdownStreamEvent } from "../electron-api.js";

export async function startCanvas(): Promise<{ document: CanvasDocument | null; error: string | null }> {
  const result = await window.localFileAgent.canvasStart();
  if (!result.ok) return { document: null, error: resolveCanvasError(result.error.code) };
  return { document: result.data, error: null };
}

export async function openCanvas(): Promise<{ document: CanvasDocument | null; error: string | null }> {
  const result = await window.localFileAgent.canvasOpen();
  if (!result.ok) return { document: null, error: resolveCanvasError(result.error.code) };
  return { document: result.data, error: null };
}

export async function saveCanvas(args: {
  filePath: string;
  content: string;
}): Promise<{ document: CanvasDocument | null; error: string | null }> {
  const result = await window.localFileAgent.canvasSave(args);
  if (!result.ok) return { document: null, error: resolveCanvasError(result.error.code) };
  return { document: result.data, error: null };
}

export function streamCanvasMarkdown(
  args: {
    requestId: string;
    userInstruction: string;
    currentMarkdown: string;
    targetMarkdown?: string;
    editMode?: CanvasMarkdownEditMode;
    model: string;
  },
  onEvent: (event: CanvasMarkdownStreamEvent) => void,
): () => void {
  return window.localFileAgent.canvasGenerateMarkdownStream(args, onEvent);
}

function resolveCanvasError(code: string): string {
  switch (code) {
    case "cancelled":
      return "キャンセルしました。";
    case "no_canvas":
      return "Canvasが開かれていません。";
    case "canvas_mismatch":
      return "開いているCanvasファイルと保存先が一致しません。";
    default:
      return "Canvas操作に失敗しました。";
  }
}
