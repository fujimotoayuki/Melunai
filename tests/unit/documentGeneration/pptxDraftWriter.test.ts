import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { extractPptxText } from "../../../src/document/pptxExtractor.js";
import { createPptxDraft } from "../../../src/documentGeneration/pptxDraftWriter.js";
import type { DocumentGenerationApproval, DocumentGenerationPlan, PowerPointDraftOutline } from "../../../src/types/index.js";

async function createTempWorkspace(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "melunai-pptx-generation-"));
}

test("createPptxDraft creates a new PPTX from an approved PowerPoint outline", async () => {
  const workspaceRoot = await createTempWorkspace();
  const plan = createPowerPointPlan("plan-1", "drafts/proposal.pptx");
  const approval = createApproval(plan);

  const result = await createPptxDraft(workspaceRoot, plan, approval);

  assert.equal(result.ok, true);
  if (!result.ok) return;

  assert.equal(result.data.status, "created");
  assert.equal(result.data.targetPath, "drafts/proposal.pptx");

  const extracted = await extractPptxText(workspaceRoot, "drafts/proposal.pptx", {
    maxSlidesPerPptx: 10,
    maxCharsPerFile: 10_000,
  });
  const text = extracted.segments.map((segment) => segment.text).join("\n");

  assert.equal(extracted.status, "extracted");
  assert.equal(extracted.metadata?.slideCount, 2);
  assert.match(text, /提案デッキ/);
  assert.match(text, /Generated documents are drafts/);
  assert.match(text, /背景/);
  assert.match(text, /次のアクション/);
});

test("createPptxDraft refuses to overwrite an existing PPTX", async () => {
  const workspaceRoot = await createTempWorkspace();
  await fs.mkdir(path.join(workspaceRoot, "drafts"), { recursive: true });
  await fs.writeFile(path.join(workspaceRoot, "drafts/proposal.pptx"), "existing", "utf8");

  const plan = createPowerPointPlan("plan-2", "drafts/proposal.pptx");
  const result = await createPptxDraft(workspaceRoot, plan, createApproval(plan));

  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.error.code, "target_exists");
});

test("createPptxDraft requires approval to match plan and target path", async () => {
  const workspaceRoot = await createTempWorkspace();
  const plan = createPowerPointPlan("plan-3", "drafts/proposal.pptx");

  const wrongPlan = await createPptxDraft(workspaceRoot, plan, {
    planId: "other-plan",
    approvedAt: new Date().toISOString(),
    approvedTargetPath: plan.draft.targetPath,
  });
  assert.equal(wrongPlan.ok, false);
  if (!wrongPlan.ok) assert.equal(wrongPlan.error.code, "approval_plan_mismatch");

  const wrongTarget = await createPptxDraft(workspaceRoot, plan, {
    planId: plan.id,
    approvedAt: new Date().toISOString(),
    approvedTargetPath: "drafts/other.pptx",
  });
  assert.equal(wrongTarget.ok, false);
  if (!wrongTarget.ok) assert.equal(wrongTarget.error.code, "approval_target_mismatch");
});

test("createPptxDraft rejects paths outside the workspace", async () => {
  const workspaceRoot = await createTempWorkspace();
  const plan = createPowerPointPlan("plan-4", "../outside.pptx");

  const result = await createPptxDraft(workspaceRoot, plan, createApproval(plan));

  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.error.code, "outside_workspace");
});

function createPowerPointPlan(planId: string, targetPath: string): DocumentGenerationPlan {
  const draft: PowerPointDraftOutline = {
    id: `${planId}-draft`,
    kind: "powerpoint",
    extension: ".pptx",
    proposedFilename: path.basename(targetPath),
    targetPath,
    title: "提案デッキ",
    purpose: "社内確認用のプレゼン下書きを作成する。",
    draftDisclaimer: {
      label: "Draft",
      message: "Generated documents are drafts and must be reviewed by the user.",
      required: true,
    },
    sources: [{ kind: "user_instruction", label: "User request", excerpt: "パワポにして" }],
    warnings: ["Review all facts before sharing."],
    slides: [
      {
        id: "slide-background",
        title: "背景",
        subtitle: "課題整理",
        bullets: ["現在の課題を整理する", "目的を明確にする"],
      },
      {
        id: "slide-actions",
        title: "次のアクション",
        bullets: ["担当者を決める", "期限を設定する"],
        speakerNotes: "関係者レビューで確定する。",
      },
    ],
  };

  return {
    id: planId,
    summary: "Create a proposal PPTX draft.",
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
