import type { CorpusIndex, CorpusNavigateResult } from "../electron-api.js";

export async function buildCorpus(): Promise<{
  index: CorpusIndex | null;
  error: string | null;
}> {
  const result = await window.localFileAgent.corpusBuild();
  if (!result.ok) {
    return { index: null, error: resolveCorpusError(result.error.code, result.error.message) };
  }
  return { index: result.data, error: null };
}

export async function loadCorpus(): Promise<{
  index: CorpusIndex | null;
  error: string | null;
}> {
  const result = await window.localFileAgent.corpusLoad();
  if (!result.ok) {
    return { index: null, error: resolveCorpusError(result.error.code, result.error.message) };
  }
  return { index: result.data, error: null };
}

export async function getCorpusStatus(): Promise<{
  index: CorpusIndex | null;
  error: string | null;
}> {
  const result = await window.localFileAgent.corpusStatus();
  if (!result.ok) {
    return { index: null, error: resolveCorpusError(result.error.code, result.error.message) };
  }
  return { index: result.data, error: null };
}

export async function navigateCorpus(query: string): Promise<{
  result: CorpusNavigateResult | null;
  error: string | null;
}> {
  const response = await window.localFileAgent.corpusNavigate({ query, maxHits: 10 });
  if (!response.ok) {
    return { result: null, error: resolveCorpusError(response.error.code, response.error.message) };
  }
  return { result: response.data, error: null };
}

function resolveCorpusError(code: string, fallback: string): string {
  switch (code) {
    case "cancelled":
      return "フォルダ選択をキャンセルしました。";
    case "no_corpus_workspace":
      return "資料フォルダが選択されていません。先に資料フォルダを読み込んでください。";
    case "corpus_missing":
      return "資料フォルダの読み込み情報が見つかりません。もう一度資料フォルダを読み込んでください。";
    case "corpus_empty":
      return "参照中の資料フォルダに読み込める文書がありません。";
    case "corpus_build_failed":
      return `Corpus2Skillの構築に失敗しました: ${fallback}`;
    case "corpus_navigate_failed":
      return `ナビゲーションに失敗しました: ${fallback}`;
    default:
      return fallback;
  }
}
