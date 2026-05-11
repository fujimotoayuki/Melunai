import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

test("chat streaming uses the active conversation id instead of a process-wide session id", () => {
  const sourcePath = path.join(process.cwd(), "src", "app", "App.tsx");
  const source = fs.readFileSync(sourcePath, "utf8");

  assert.doesNotMatch(source, /const\s+SESSION_ID\s*=/);
  assert.doesNotMatch(source, /sessionId:\s*SESSION_ID/);
  assert.match(source, /sessionId:\s*streamConversationId/);
  assert.match(source, /setActiveConversationId\(streamConversationId\)/);
  assert.match(source, /draftConversationIdRef\.current\s*=\s*draftId/);
  assert.match(source, /activeConversationIdRef\.current\s*=\s*null/);
  assert.match(source, /setUseCorpus\(false\)/);
});

test("new chat remounts the chat thread and resets the scrollable conversation view", () => {
  const sourcePath = path.join(process.cwd(), "src", "app", "App.tsx");
  const source = fs.readFileSync(sourcePath, "utf8");

  assert.match(source, /const\s+\[chatThreadKey,\s*setChatThreadKey\]/);
  assert.match(source, /const\s+draftId\s*=\s*newConversationId\(\)/);
  assert.match(source, /setChatThreadKey\(draftId\)/);
  assert.match(source, /key=\{chatThreadKey\}/);
  assert.match(source, /chatAreaRef\.current\?\.scrollTo\(\{\s*top:\s*0,\s*behavior:\s*"auto"\s*\}\)/);
});

test("chat settings sanitize numeric Ollama options before saving and streaming", () => {
  const appSource = fs.readFileSync(path.join(process.cwd(), "src", "app", "App.tsx"), "utf8");
  const mainSource = fs.readFileSync(path.join(process.cwd(), "src", "main", "main.ts"), "utf8");

  assert.match(appSource, /function\s+sanitizeTemperature\(value:\s+unknown\):\s+number/);
  assert.match(appSource, /Number\.isFinite\(numeric\)/);
  assert.match(appSource, /temperature:\s*sanitizeTemperature\(parsed\.temperature\)/);
  assert.match(mainSource, /function\s+buildOllamaGenerateOptions/);
  assert.match(mainSource, /Number\.isFinite\(temperature\)/);
  assert.match(mainSource, /function\s+applyWeakModelOutputGuard\(systemPrompt:\s*string \| undefined,\s*answer:\s*string\):\s*string/);
  assert.match(mainSource, /function\s+enforceGowasuEnding\(answer:\s*string\):\s*string/);
  assert.match(mainSource, /message:\s*applyWeakModelOutputGuard\(systemPrompt,\s*fullText\)/);
  assert.match(mainSource, /const\s+generateOptions\s*=\s*buildOllamaGenerateOptions\(args\.ollamaConfig\)/);
  assert.match(mainSource, /options:\s*generateOptions/);
});

test("model settings are edited as a draft and only applied after explicit save", () => {
  const appSource = fs.readFileSync(path.join(process.cwd(), "src", "app", "App.tsx"), "utf8");

  assert.match(appSource, /const\s+\[settingsDraft,\s*setSettingsDraft\]/);
  assert.match(appSource, /const\s+\[settingsSaveStatus,\s*setSettingsSaveStatus\]/);
  assert.match(appSource, /const\s+saveChatSettingsDraft\s*=\s*\(\)\s*=>/);
  assert.match(appSource, /setChatSettings\(nextSettings\)/);
  assert.match(appSource, /保存後、次の送信から反映/);
  assert.match(appSource, /disabled=\{settingsSaveStatus === "saved"\}/);
});

test("main process reports the exact settings it sends to Ollama", () => {
  const appSource = fs.readFileSync(path.join(process.cwd(), "src", "app", "App.tsx"), "utf8");
  const mainSource = fs.readFileSync(path.join(process.cwd(), "src", "main", "main.ts"), "utf8");
  const apiSource = fs.readFileSync(path.join(process.cwd(), "src", "app", "electron-api.d.ts"), "utf8");

  assert.match(mainSource, /const\s+systemPrompt\s*=\s*resolveOllamaSystemPrompt\(args\.ollamaConfig\)/);
  assert.match(mainSource, /const\s+prompt\s*=\s*buildWeakModelPrompt\(systemPrompt,\s*corpusPrompt\.prompt\)/);
  assert.match(mainSource, /回答直前の最終確認/);
  assert.match(mainSource, /const\s+generateOptions\s*=\s*buildOllamaGenerateOptions\(args\.ollamaConfig\)/);
  assert.match(mainSource, /type:\s*"settings"/);
  assert.match(mainSource, /system:\s*systemPrompt/);
  assert.match(mainSource, /prompt,\s*\n\s*system:\s*systemPrompt/);
  assert.match(mainSource, /options:\s*generateOptions/);
  assert.match(apiSource, /type:\s*"settings"/);
  assert.match(appSource, /const\s+\[lastAppliedSettings,\s*setLastAppliedSettings\]/);
  assert.match(appSource, /最後にOllamaへ送った設定/);
});
