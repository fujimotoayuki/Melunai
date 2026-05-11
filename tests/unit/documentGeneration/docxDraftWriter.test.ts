import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { extractDocxText } from "../../../src/document/docxExtractor.js";
import { createDocxDraft } from "../../../src/documentGeneration/docxDraftWriter.js";
import type { DocumentGenerationApproval, DocumentGenerationPlan, WordDraftOutline } from "../../../src/types/index.js";

async function createTempWorkspace(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "melunai-docx-generation-"));
}

test("createDocxDraft creates a new DOCX from an approved Word outline", async () => {
  const workspaceRoot = await createTempWorkspace();
  const plan = createWordPlan("plan-1", "drafts/proposal.docx");
  const approval = createApproval(plan);

  const result = await createDocxDraft(workspaceRoot, plan, approval);

  assert.equal(result.ok, true);
  if (!result.ok) return;

  assert.equal(result.data.status, "created");
  assert.equal(result.data.targetPath, "drafts/proposal.docx");

  const extracted = await extractDocxText(workspaceRoot, "drafts/proposal.docx", {
    maxParagraphsPerDocx: 20,
    maxCharsPerFile: 10_000,
  });
  const text = extracted.segments.map((segment) => segment.text).join("\n");

  assert.equal(extracted.status, "extracted");
  assert.match(text, /提案書ドラフト/);
  assert.match(text, /Generated documents are drafts/);
  assert.match(text, /背景/);
  assert.match(text, /次のアクション/);
});

test("createDocxDraft refuses to overwrite an existing DOCX", async () => {
  const workspaceRoot = await createTempWorkspace();
  await fs.mkdir(path.join(workspaceRoot, "drafts"), { recursive: true });
  await fs.writeFile(path.join(workspaceRoot, "drafts/proposal.docx"), "existing", "utf8");

  const plan = createWordPlan("plan-2", "drafts/proposal.docx");
  const result = await createDocxDraft(workspaceRoot, plan, createApproval(plan));

  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.error.code, "target_exists");
});

test("createDocxDraft requires approval to match plan and target path", async () => {
  const workspaceRoot = await createTempWorkspace();
  const plan = createWordPlan("plan-3", "drafts/proposal.docx");

  const wrongPlan = await createDocxDraft(workspaceRoot, plan, {
    planId: "other-plan",
    approvedAt: new Date().toISOString(),
    approvedTargetPath: plan.draft.targetPath,
  });
  assert.equal(wrongPlan.ok, false);
  if (!wrongPlan.ok) assert.equal(wrongPlan.error.code, "approval_plan_mismatch");

  const wrongTarget = await createDocxDraft(workspaceRoot, plan, {
    planId: plan.id,
    approvedAt: new Date().toISOString(),
    approvedTargetPath: "drafts/other.docx",
  });
  assert.equal(wrongTarget.ok, false);
  if (!wrongTarget.ok) assert.equal(wrongTarget.error.code, "approval_target_mismatch");
});

test("createDocxDraft rejects paths outside the workspace", async () => {
  const workspaceRoot = await createTempWorkspace();
  const plan = createWordPlan("plan-4", "../outside.docx");

  const result = await createDocxDraft(workspaceRoot, plan, createApproval(plan));

  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.error.code, "outside_workspace");
});

function createWordPlan(planId: string, targetPath: string): DocumentGenerationPlan {
  const draft: WordDraftOutline = {
    id: `${planId}-draft`,
    kind: "word",
    extension: ".docx",
    proposedFilename: path.basename(targetPath),
    targetPath,
    title: "提案書ドラフト",
    purpose: "社内確認用のたたき台を作成する。",
    draftDisclaimer: {
      label: "Draft",
      message: "Generated documents are drafts and must be reviewed by the user.",
      required: true,
    },
    sources: [{ kind: "user_instruction", label: "User request", excerpt: "提案書を作って" }],
    warnings: ["Review all facts before sharing."],
    sections: [
      {
        id: "section-background",
        heading: "背景",
        paragraphs: ["現在の課題と目的を整理する。"],
      },
      {
        id: "section-actions",
        heading: "次のアクション",
        paragraphs: ["関係者レビューを行い、内容を確定する。"],
        bullets: ["担当者を決める", "期限を設定する"],
      },
    ],
  };

  return {
    id: planId,
    summary: "Create a proposal DOCX draft.",
    draft,
    status: "draft_proposed",
    issues: [],
    requiresApproval: true,
  };
}

function createApproval(plan: DocumentGenerationPlan): DocumentGenerationApproval {
  return {
    planId: plan.id,
    approvedAt: new Date().toISOString(),
    approvedTargetPath: plan.draft.targetPath,
  };
}
