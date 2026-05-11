import fs from "node:fs/promises";
import path from "node:path";

import JSZip from "jszip";

import type {
  DocumentGenerationApproval,
  DocumentGenerationPlan,
  DocumentGenerationResult,
  ToolResult,
  WordDraftOutline,
  WordDraftSection,
} from "../types/index.js";
import { resolveWorkspacePath } from "../utils/pathUtils.js";

export async function createDocxDraft(
  workspaceRoot: string,
  plan: DocumentGenerationPlan,
  approval: DocumentGenerationApproval,
): Promise<ToolResult<DocumentGenerationResult>> {
  try {
    const validation = validateApprovedWordPlan(plan, approval);
    if (validation !== null) {
      return fail(validation.code, validation.message);
    }

    const draft = plan.draft as WordDraftOutline;
    const absolutePath = resolveWorkspacePath(workspaceRoot, draft.targetPath);

    if (path.extname(absolutePath).toLowerCase() !== ".docx") {
      return fail("invalid_extension", "DOCX draft generation requires a .docx target path.");
    }

    await rejectSymlinkTraversal(workspaceRoot, absolutePath, { includeTarget: false });
    await fs.mkdir(path.dirname(absolutePath), { recursive: true });

    const docxBuffer = await buildDocxBuffer(draft);
    await fs.writeFile(absolutePath, docxBuffer, { flag: "wx" });

    return ok({
      planId: plan.id,
      status: "created",
      targetPath: draft.targetPath,
      createdAt: new Date().toISOString(),
      warnings: draft.warnings,
    });
  } catch (cause) {
    if (isFileExistsError(cause)) {
      return fail("target_exists", "Target DOCX already exists. Generated documents do not overwrite files.");
    }

    if (isUnsafePathError(cause)) {
      return fail("outside_workspace", "DOCX target path is outside the selected workspace or uses unsupported symlink traversal.", cause);
    }

    return fail("docx_generation_failed", "Unable to create DOCX draft.", cause);
  }
}

async function buildDocxBuffer(draft: WordDraftOutline): Promise<Buffer> {
  const zip = new JSZip();
  zip.file("[Content_Types].xml", contentTypesXml());
  zip.folder("_rels")?.file(".rels", rootRelationshipsXml());

  const word = zip.folder("word");
  word?.file("document.xml", documentXml(draft));
  word?.file("styles.xml", stylesXml());
  word?.folder("_rels")?.file("document.xml.rels", documentRelationshipsXml());

  return zip.generateAsync({
    type: "nodebuffer",
    compression: "DEFLATE",
    compressionOptions: { level: 6 },
  });
}

function validateApprovedWordPlan(
  plan: DocumentGenerationPlan,
  approval: DocumentGenerationApproval,
): { code: string; message: string } | null {
  if (plan.status !== "draft_proposed" || plan.requiresApproval !== true) {
    return { code: "invalid_plan_state", message: "Only proposed drafts that require approval can be generated." };
  }

  if (plan.draft.kind !== "word" || plan.draft.extension !== ".docx") {
    return { code: "unsupported_draft_kind", message: "Only Word .docx drafts are supported by this writer." };
  }

  if (approval.planId !== plan.id) {
    return { code: "approval_plan_mismatch", message: "Approval does not match the document generation plan." };
  }

  if (approval.approvedTargetPath !== plan.draft.targetPath) {
    return { code: "approval_target_mismatch", message: "Approval target path does not match the previewed draft." };
  }

  const blockedIssue = plan.issues.find((issue) => issue.level === "blocked");
  if (blockedIssue !== undefined) {
    return { code: blockedIssue.code, message: blockedIssue.message };
  }

  return null;
}

function documentXml(draft: WordDraftOutline): string {
  const paragraphs = [
    paragraphXml(draft.title, "Heading1"),
    paragraphXml(draft.draftDisclaimer.message, "Normal"),
    draft.purpose === undefined ? "" : paragraphXml(draft.purpose, "Normal"),
    ...draft.sections.flatMap(sectionXml),
  ].join("");

  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body>
    ${paragraphs}
    <w:sectPr>
      <w:pgSz w:w="11906" w:h="16838"/>
      <w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="720" w:footer="720" w:gutter="0"/>
    </w:sectPr>
  </w:body>
</w:document>`;
}

function sectionXml(section: WordDraftSection): string[] {
  const blocks = [paragraphXml(section.heading, "Heading1")];

  for (const paragraph of section.paragraphs) {
    blocks.push(paragraphXml(paragraph, "Normal"));
  }

  for (const bullet of section.bullets ?? []) {
    blocks.push(bulletParagraphXml(bullet));
  }

  return blocks;
}

function paragraphXml(text: string, style: "Heading1" | "Normal"): string {
  const styleXml = style === "Normal" ? "" : `<w:pPr><w:pStyle w:val="${style}"/></w:pPr>`;
  return `<w:p>${styleXml}<w:r><w:t xml:space="preserve">${escapeXml(text)}</w:t></w:r></w:p>`;
}

function bulletParagraphXml(text: string): string {
  return `<w:p>
    <w:r><w:t xml:space="preserve">- ${escapeXml(text)}</w:t></w:r>
  </w:p>`;
}

function contentTypesXml(): string {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
  <Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>
</Types>`;
}

function rootRelationshipsXml(): string {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`;
}

function documentRelationshipsXml(): string {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rIdStyles" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>`;
}

function stylesXml(): string {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:style w:type="paragraph" w:default="1" w:styleId="Normal">
    <w:name w:val="Normal"/>
    <w:pPr><w:spacing w:after="160" w:line="276" w:lineRule="auto"/></w:pPr>
    <w:rPr><w:sz w:val="22"/></w:rPr>
  </w:style>
  <w:style w:type="paragraph" w:styleId="Heading1">
    <w:name w:val="heading 1"/>
    <w:pPr><w:spacing w:before="260" w:after="120"/></w:pPr>
    <w:rPr><w:b/><w:sz w:val="28"/></w:rPr>
  </w:style>
</w:styles>`;
}

function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("\"", "&quot;")
    .replaceAll("'", "&apos;");
}

function ok<T>(data: T): ToolResult<T> {
  return { ok: true, data };
}

function fail<T = never>(code: string, message: string, cause?: unknown): ToolResult<T> {
  return {
    ok: false,
    error: { code, message, cause },
  };
}

async function rejectSymlinkTraversal(
  workspaceRoot: string,
  absoluteTargetPath: string,
  options: { includeTarget?: boolean } = {},
): Promise<void> {
  const includeTarget = options.includeTarget ?? true;
  const resolvedWorkspaceRoot = path.resolve(workspaceRoot);
  const resolvedTargetPath = path.resolve(absoluteTargetPath);
  const relativePath = path.relative(resolvedWorkspaceRoot, resolvedTargetPath);

  if (relativePath.startsWith("..") || path.isAbsolute(relativePath)) {
    throw new Error("Path escapes workspace.");
  }

  const parts = relativePath ? relativePath.split(path.sep) : [];
  const partsToCheck = includeTarget ? parts : parts.slice(0, -1);
  let currentPath = resolvedWorkspaceRoot;

  const rootStats = await fs.lstat(currentPath);
  if (rootStats.isSymbolicLink()) {
    throw new Error("Symlink traversal is not supported.");
  }

  for (const part of partsToCheck) {
    currentPath = path.join(currentPath, part);

    try {
      const stats = await fs.lstat(currentPath);
      if (stats.isSymbolicLink()) {
        throw new Error("Symlink traversal is not supported.");
      }
    } catch (error) {
      if (isMissingPathError(error)) {
        return;
      }

      throw error;
    }
  }
}

function isFileExistsError(error: unknown): boolean {
  return Boolean(
    error &&
      typeof error === "object" &&
      "code" in error &&
      (error as { code?: string }).code === "EEXIST",
  );
}

function isMissingPathError(error: unknown): boolean {
  return Boolean(
    error &&
      typeof error === "object" &&
      "code" in error &&
      (error as { code?: string }).code === "ENOENT",
  );
}

function isUnsafePathError(error: unknown): boolean {
  return error instanceof Error &&
    (
      error.message.includes("Absolute paths are not allowed") ||
      error.message.includes("Parent traversal is not allowed") ||
      error.message.includes("escapes workspace") ||
      error.message.includes("Symlink traversal is not supported")
    );
}
