import type {
  DocumentGenerationDisclaimer,
  DocumentGenerationPlan,
  ExcelDraftColumn,
  ExcelWorkbookSchema,
  GeneratedDocumentKind,
  PowerPointDraftOutline,
  WordDraftOutline,
} from "../types/index.js";

export interface DocumentDraftPrepareRequest {
  userInstruction: string;
  outputKind: GeneratedDocumentKind;
}

export function prepareDocumentDraftPlan(
  request: DocumentDraftPrepareRequest,
  options: { now?: () => Date } = {},
): DocumentGenerationPlan {
  const now = options.now?.() ?? new Date();
  const instruction = normalizeInstruction(request.userInstruction);
  const title = buildTitle(instruction, request.outputKind);
  const baseName = uniqueDraftBaseName(title, now);
  const disclaimer: DocumentGenerationDisclaimer = {
    label: "Draft",
    message: "This file is a Melunai draft. Please review and edit before final use.",
    required: true,
  };

  const common = {
    id: `docgen-${now.getTime()}`,
    proposedFilename: filenameFor(baseName, request.outputKind),
    targetPath: `generated/${filenameFor(baseName, request.outputKind)}`,
    title,
    purpose: instruction,
    draftDisclaimer: disclaimer,
    sources: [
      {
        kind: "user_instruction" as const,
        label: "User instruction",
        excerpt: instruction.slice(0, 500),
      },
    ],
    warnings: [
      "Generated content is a first draft and may need factual, formatting, and wording review.",
    ],
  };

  const draft =
    request.outputKind === "word"
      ? wordDraft(common, instruction)
      : request.outputKind === "powerpoint"
        ? powerpointDraft(common, instruction)
        : excelDraft(common, instruction);

  return {
    id: common.id,
    summary: `Prepare a ${request.outputKind} draft named ${common.proposedFilename}.`,
    draft,
    status: "draft_proposed",
    issues: [],
    requiresApproval: true,
  };
}

function wordDraft(
  common: Omit<WordDraftOutline, "kind" | "extension" | "sections">,
  instruction: string,
): WordDraftOutline {
  return {
    ...common,
    kind: "word",
    extension: ".docx",
    sections: [
      {
        id: "section-1",
        heading: "Overview",
        paragraphs: [
          instruction,
          "This section should be expanded with concrete background, goals, and assumptions.",
        ],
      },
      {
        id: "section-2",
        heading: "Key Points",
        paragraphs: ["Use this draft as a starting structure for the final document."],
        bullets: ["Main objective", "Important details", "Next actions"],
      },
      {
        id: "section-3",
        heading: "Next Steps",
        paragraphs: ["Review the draft, fill missing facts, and adjust wording for the audience."],
      },
    ],
  };
}

function powerpointDraft(
  common: Omit<PowerPointDraftOutline, "kind" | "extension" | "slides">,
  instruction: string,
): PowerPointDraftOutline {
  return {
    ...common,
    kind: "powerpoint",
    extension: ".pptx",
    slides: [
      {
        id: "slide-1",
        title: common.title,
        subtitle: "Draft presentation",
        bullets: [instruction],
      },
      {
        id: "slide-2",
        title: "Why it matters",
        bullets: ["Problem or opportunity", "Audience impact", "Expected outcome"],
      },
      {
        id: "slide-3",
        title: "Plan",
        bullets: ["Current state", "Proposed approach", "Next action"],
      },
      {
        id: "slide-4",
        title: "Next steps",
        bullets: ["Review content", "Add evidence", "Finalize design"],
      },
    ],
  };
}

function excelDraft(
  common: Omit<ExcelWorkbookSchema, "kind" | "extension" | "sheets">,
  instruction: string,
): ExcelWorkbookSchema {
  const columns: ExcelDraftColumn[] = [
    { id: "item", header: "Item", valueType: "text" },
    { id: "description", header: "Description", valueType: "text" },
    { id: "owner", header: "Owner", valueType: "text" },
    { id: "status", header: "Status", valueType: "text" },
  ];

  return {
    ...common,
    kind: "excel",
    extension: ".xlsx",
    sheets: [
      {
        id: "sheet-1",
        name: "Draft",
        purpose: instruction,
        columns,
        sampleRows: [
          {
            item: "Example",
            description: "Replace this row with real data.",
            owner: "",
            status: "Draft",
          },
        ],
      },
    ],
  };
}

function normalizeInstruction(value: string): string {
  const normalized = value.trim().replace(/\s+/g, " ");
  return normalized.length > 0 ? normalized : "Create a useful office document draft.";
}

function buildTitle(instruction: string, kind: GeneratedDocumentKind): string {
  const trimmed = instruction.replace(/[.。!?！？].*$/u, "").trim();
  if (trimmed.length > 0 && trimmed.length <= 48) return trimmed;

  const label =
    kind === "word" ? "Word Draft" :
      kind === "powerpoint" ? "Presentation Draft" :
        "Workbook Draft";
  return label;
}

function filenameFor(baseName: string, kind: GeneratedDocumentKind): string {
  const extension =
    kind === "word" ? ".docx" :
      kind === "powerpoint" ? ".pptx" :
        ".xlsx";
  return `${baseName}${extension}`;
}

function uniqueDraftBaseName(title: string, now: Date): string {
  const slug = slugify(title);
  const stamp = [
    now.getFullYear(),
    String(now.getMonth() + 1).padStart(2, "0"),
    String(now.getDate()).padStart(2, "0"),
    String(now.getHours()).padStart(2, "0"),
    String(now.getMinutes()).padStart(2, "0"),
    String(now.getSeconds()).padStart(2, "0"),
  ].join("");
  return `${slug}-${stamp}`;
}

function slugify(value: string): string {
  const ascii = value
    .normalize("NFKD")
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase();

  return ascii.length > 0 ? ascii.slice(0, 40) : "melunai-draft";
}
