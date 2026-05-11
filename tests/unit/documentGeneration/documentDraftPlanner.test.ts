import assert from "node:assert/strict";
import test from "node:test";

import { prepareDocumentDraftPlan } from "../../../src/documentGeneration/documentDraftPlanner.js";

test("prepareDocumentDraftPlan creates a Word approval preview", () => {
  const plan = prepareDocumentDraftPlan(
    {
      userInstruction: "Create a proposal for a local AI file coworker.",
      outputKind: "word",
    },
    { now: () => new Date("2026-05-01T00:00:00.000Z") },
  );

  assert.equal(plan.status, "draft_proposed");
  assert.equal(plan.requiresApproval, true);
  assert.equal(plan.draft.kind, "word");
  assert.equal(plan.draft.extension, ".docx");
  assert.match(plan.draft.targetPath, /^generated\/.+\.docx$/);
  assert.equal(plan.draft.draftDisclaimer.required, true);
});

test("prepareDocumentDraftPlan creates PowerPoint and Excel previews", () => {
  const now = () => new Date("2026-05-01T00:00:00.000Z");
  const pptx = prepareDocumentDraftPlan(
    { userInstruction: "Make slides about Melunai.", outputKind: "powerpoint" },
    { now },
  );
  const xlsx = prepareDocumentDraftPlan(
    { userInstruction: "Make a task tracker.", outputKind: "excel" },
    { now },
  );

  assert.equal(pptx.draft.kind, "powerpoint");
  assert.equal(pptx.draft.extension, ".pptx");
  assert.match(pptx.draft.targetPath, /^generated\/.+\.pptx$/);

  assert.equal(xlsx.draft.kind, "excel");
  assert.equal(xlsx.draft.extension, ".xlsx");
  assert.match(xlsx.draft.targetPath, /^generated\/.+\.xlsx$/);
});
