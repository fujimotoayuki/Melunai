import assert from "node:assert/strict";
import test from "node:test";

import type {
  DocumentGenerationPlan,
  ExcelWorkbookSchema,
  PowerPointDraftOutline,
  WordDraftOutline,
} from "../../../src/types/index.js";

test("document generation contracts represent draft-only Word, PowerPoint, and Excel plans", () => {
  const disclaimer = {
    label: "Draft",
    message: "Generated documents are drafts and must be reviewed by the user.",
    required: true,
  } as const;

  const wordDraft: WordDraftOutline = {
    id: "draft-word",
    kind: "word",
    extension: ".docx",
    proposedFilename: "proposal.docx",
    targetPath: "outputs/proposal.docx",
    title: "Proposal",
    draftDisclaimer: disclaimer,
    sources: [{ kind: "user_instruction", label: "User request" }],
    warnings: [],
    sections: [{ id: "section-1", heading: "Purpose", paragraphs: ["Explain the purpose."] }],
  };

  const deckDraft: PowerPointDraftOutline = {
    id: "draft-deck",
    kind: "powerpoint",
    extension: ".pptx",
    proposedFilename: "proposal.pptx",
    targetPath: "outputs/proposal.pptx",
    title: "Proposal Deck",
    draftDisclaimer: disclaimer,
    sources: [{ kind: "user_instruction", label: "User request" }],
    warnings: [],
    slides: [{ id: "slide-1", title: "Overview", bullets: ["Goal", "Plan"] }],
  };

  const workbookDraft: ExcelWorkbookSchema = {
    id: "draft-workbook",
    kind: "excel",
    extension: ".xlsx",
    proposedFilename: "todo.xlsx",
    targetPath: "outputs/todo.xlsx",
    title: "Todo List",
    draftDisclaimer: disclaimer,
    sources: [{ kind: "user_instruction", label: "User request" }],
    warnings: [],
    sheets: [{
      id: "sheet-1",
      name: "Tasks",
      columns: [
        { id: "col-1", header: "Task", valueType: "text" },
        { id: "col-2", header: "Due Date", valueType: "date" },
      ],
    }],
  };

  const plans: DocumentGenerationPlan[] = [wordDraft, deckDraft, workbookDraft].map((draft, index) => ({
    id: `plan-${index + 1}`,
    summary: `Create ${draft.proposedFilename}`,
    draft,
    status: "draft_proposed",
    issues: [],
    requiresApproval: true,
  }));

  assert.deepEqual(plans.map((plan) => plan.draft.extension), [".docx", ".pptx", ".xlsx"]);
  assert.equal(plans.every((plan) => plan.requiresApproval), true);
  assert.equal(plans.every((plan) => plan.draft.draftDisclaimer.required), true);
});
