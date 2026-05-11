export function buildCorpusContextPrompt(args: {
  userInstruction: string;
  excerpts: string[];
}): string {
  return [
    "必ず日本語で答える。他の言語に切り替えない。",
    "以下の「資料抜粋」を参考にして「依頼」に答える。",
    "資料抜粋に記載のない情報は『資料には記載がありません』と正直に伝える。",
    "資料抜粋が少ない場合は『確認できた範囲では』と前置きして答える。",
    "",
    "## 資料抜粋",
    args.excerpts.length > 0 ? args.excerpts.join("\n\n") : "（関連する資料が見つかりませんでした）",
    "",
    "## 依頼",
    args.userInstruction,
  ].join("\n");
}

export function buildCorpusFocusTerms(query: string): string[] {
  const normalized = query.toLowerCase();
  const terms = new Set<string>();
  for (const token of normalized
    .replace(/[^\p{L}\p{N}_\-./]+/gu, " ")
    .split(/\s+/)
    .map((item) => item.trim())
    .filter((item) => item.length >= 2)) {
    terms.add(token);
  }
  if (normalized.includes("セキュリティ") || normalized.includes("security")) {
    [
      "セキュリティ",
      "セキュリティー",
      "security",
      "安全",
      "保護",
      "認証",
      "暗号",
      "権限",
      "アクセス",
      "アクセス制御",
      "脆弱",
      "脆弱性",
      "リスク",
      "監査",
      "ログ",
      "情報漏えい",
    ].forEach((term) => terms.add(term.toLowerCase()));
  }
  return Array.from(terms);
}

export function focusCorpusText(content: string, focusTerms: string[], maxChars: number): string {
  const normalized = content.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const chunks = normalized
    .split(/(?<=[。.!?！？])\s*|\n{1,}/u)
    .map((chunk) => chunk.replace(/\s+/g, " ").trim())
    .filter((chunk) => chunk.length >= 8);

  const scored = chunks
    .map((chunk, index) => ({
      chunk,
      index,
      score: scoreFocusChunk(chunk, focusTerms),
    }))
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score || a.index - b.index);

  const selected = scored.length > 0
    ? scored.slice(0, 6).sort((a, b) => a.index - b.index).map((item) => item.chunk)
    : chunks.slice(0, 5);

  let out = "";
  for (const chunk of selected) {
    const next = out.length === 0 ? `- ${chunk}` : `${out}\n- ${chunk}`;
    if (next.length > maxChars) break;
    out = next;
  }
  return out.length > 0 ? out : normalized.replace(/\s+/g, " ").trim().slice(0, maxChars);
}

function scoreFocusChunk(chunk: string, focusTerms: string[]): number {
  const lower = chunk.toLowerCase();
  let score = 0;
  for (const term of focusTerms) {
    if (term.length >= 2 && lower.includes(term)) {
      score += term.length >= 4 ? 3 : 1;
    }
  }
  return score;
}
