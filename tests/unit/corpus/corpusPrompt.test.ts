import assert from "node:assert/strict";
import test from "node:test";

import {
  buildCorpusContextPrompt,
  buildCorpusFocusTerms,
  focusCorpusText,
} from "../../../src/corpus/corpusPrompt.js";

test("buildCorpusFocusTerms expands security questions for weak local LLM retrieval", () => {
  const terms = buildCorpusFocusTerms("この資料の中のセキュリティの内容をまとめて");

  assert.ok(terms.includes("セキュリティ"));
  assert.ok(terms.includes("認証"));
  assert.ok(terms.includes("暗号"));
  assert.ok(terms.includes("アクセス制御"));
  assert.ok(terms.includes("脆弱性"));
  assert.ok(terms.includes("ログ"));
});

test("focusCorpusText prefers security-related excerpts over unrelated document text", () => {
  const content = [
    "この資料は製品概要と販売計画について説明します。",
    "マーケティング施策として展示会とSNS運用を予定しています。",
    "セキュリティでは、管理者権限、アクセス制御、監査ログを有効にします。",
    "認証は多要素認証を必須にし、暗号化された通信だけを許可します。",
    "昼休みの運用ルールと備品管理についても記載します。",
  ].join("\n");

  const focused = focusCorpusText(
    content,
    buildCorpusFocusTerms("セキュリティの内容をまとめて"),
    220,
  );

  assert.match(focused, /アクセス制御|監査ログ|認証|暗号化/);
  assert.doesNotMatch(focused, /展示会とSNS運用/);
  assert.ok(focused.length <= 220);
});

test("focusCorpusText falls back to a short leading excerpt when no focus term matches", () => {
  const focused = focusCorpusText(
    "最初の説明です。\n次の説明です。\n最後の説明です。",
    ["存在しない語"],
    80,
  );

  assert.match(focused, /最初の説明/);
  assert.ok(focused.length <= 80);
});

test("buildCorpusContextPrompt is short, Japanese-only, and includes excerpts before the user request", () => {
  const prompt = buildCorpusContextPrompt({
    userInstruction: "この資料の中のセキュリティの内容をまとめて",
    excerpts: [
      "### security.md\nSource: security.md\n- 認証は多要素認証を利用します。",
    ],
  });

  assert.match(prompt, /必ず日本語で答える/);
  assert.match(prompt, /## 資料抜粋/);
  assert.match(prompt, /## 依頼/);
  assert.match(prompt, /認証は多要素認証/);
  assert.match(prompt, /この資料の中のセキュリティ/);
  assert.doesNotMatch(prompt, /Chinese|English|debug|navigation/i);
  assert.ok(prompt.length < 800);
});
