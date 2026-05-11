import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { extractXlsxText } from "../../../src/document/xlsxExtractor.js";
import { createXlsxDraft } from "../../../src/documentGeneration/xlsxDraftWriter.js";
import type { DocumentGenerationApproval, DocumentGenerationPlan, ExcelWorkbookSchema } from "../../../src/types/index.js";

async function createTempWorkspace(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "melunai-xlsx-generation-"));
}

test("createXlsxDraft creates a new XLSX from an approved workbook schema", async () => {
  const workspaceRoot = await createTempWorkspace();
  const plan = createExcelPlan("plan-1", "drafts/tasks.xlsx");
  const approval = createApproval(plan);

  const result = await createXlsxDraft(workspaceRoot, plan, approval);

  assert.equal(result.ok, true);
  if (!result.ok) return;

  assert.equal(result.data.status, "created");
  assert.equal(result.data.targetPath, "drafts/tasks.xlsx");

  const extracted = await extractXlsxText(workspaceRoot, "drafts/tasks.xlsx", {
    maxSheetsPerXlsx: 10,
    maxCellsPerSheet: 100,
    maxCharsPerFile: 10_000,
  });
  const text = extracted.segments.map((segment) => segment.text).join("\n");

  assert.equal(extracted.status, "extracted");
  assert.equal(extracted.metadata?.sheetCount, 2);
  assert.match(text, /Task Tracker/);
  assert.match(text, /Generated documents are drafts/);
  assert.match(text, /Owner/);
  assert.match(text, /Alice/);
  assert.match(text, /Budget/);
});

test("createXlsxDraft refuses to overwrite an existing XLSX", async () => {
  const workspaceRoot = await createTempWorkspace();
  await fs.mkdir(path.join(workspaceRoot, "drafts"), { recursive: true });
  await fs.writeFile(path.join(workspaceRoot, "drafts/tasks.xlsx"), "existing", "utf8");

  const plan = createExcelPlan("plan-2", "drafts/tasks.xlsx");
  const result = await createXlsxDraft(workspaceRoot, plan, createApproval(plan));

  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.error.code, "target_exists");
});

test("createXlsxDraft requires approval to match plan and target path", async () => {
  const workspaceRoot = await createTempWorkspace();
  const plan = createExcelPlan("plan-3", "drafts/tasks.xlsx");

  const wrongPlan = await createXlsxDraft(workspaceRoot, plan, {
    planId: "other-plan",
    approvedAt: new Date().toISOString(),
    approvedTargetPath: plan.draft.targetPath,
  });
  assert.equal(wrongPlan.ok, false);
  if (!wrongPlan.ok) assert.equal(wrongPlan.error.code, "approval_plan_mismatch");

  const wrongTarget = await createXlsxDraft(workspaceRoot, plan, {
    planId: plan.id,
    approvedAt: new Date().toISOString(),
    approvedTargetPath: "drafts/other.xlsx",
  });
  assert.equal(wrongTarget.ok, false);
  if (!wrongTarget.ok) assert.equal(wrongTarget.error.code, "approval_target_mismatch");
});

test("createXlsxDraft rejects paths outside the workspace", async () => {
  const workspaceRoot = await createTempWorkspace();
  const plan = createExcelPlan("plan-4", "../outside.xlsx");

  const result = await createXlsxDraft(workspaceRoot, plan, createApproval(plan));

  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.error.code, "outside_workspace");
});

function createExcelPlan(planId: string, targetPath: string): DocumentGenerationPlan {
  const draft: ExcelWorkbookSchema = {
    id: `${planId}-draft`,
    kind: "excel",
    extension: ".xlsx",
    proposedFilename: path.basename(targetPath),
    targetPath,
    title: "Task Tracker",
    purpose: "Create a first draft workbook for project tracking.",
    draftDisclaimer: {
      label: "Draft",
      message: "Generated documents are drafts and must be reviewed by the user.",
      required: true,
    },
    sources: [{ kind: "user_instruction", label: "User request", excerpt: "make this into Excel" }],
    warnings: ["Review all values before sharing."],
    sheets: [
      {
        id: "sheet-tasks",
        name: "Tasks",
        purpose: "Track owners and status.",
        columns: [
          { id: "task", header: "Task", valueType: "text" },
          { id: "owner", header: "Owner", valueType: "text" },
          { id: "status", header: "Status", valueType: "text" },
        ],
        sampleRows: [
          { task: "Draft proposal", owner: "Alice", status: "In Progress" },
          { task: "Review plan", owner: "Bob", status: "Not Started" },
        ],
      },
      {
        id: "sheet-budget",
        name: "Budget",
        columns: [
          { id: "item", header: "Item", valueType: "text" },
          { id: "amount", header: "Amount", valueType: "currency" },
        ],
        sampleRows: [
          { item: "Research", amount: 1000 },
        ],
      },
    ],
  };

  return {
    id: planId,
    summary: "Create an Excel workbook draft.",
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
