import type {
  DocumentGenerationApproval,
  DocumentGenerationPlan,
  DocumentGenerationResult,
  ToolResult,
} from "../types/index.js";
import { createDocxDraft } from "./docxDraftWriter.js";
import { createPptxDraft } from "./pptxDraftWriter.js";
import { createXlsxDraft } from "./xlsxDraftWriter.js";

export async function createApprovedDocumentDraft(
  workspaceRoot: string,
  plan: DocumentGenerationPlan,
): Promise<ToolResult<DocumentGenerationResult>> {
  const approval: DocumentGenerationApproval = {
    planId: plan.id,
    approvedAt: new Date().toISOString(),
    approvedTargetPath: plan.draft.targetPath,
  };

  switch (plan.draft.kind) {
    case "word":
      return createDocxDraft(workspaceRoot, plan, approval);
    case "powerpoint":
      return createPptxDraft(workspaceRoot, plan, approval);
    case "excel":
      return createXlsxDraft(workspaceRoot, plan, approval);
  }
}
