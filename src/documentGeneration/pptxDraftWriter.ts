import fs from "node:fs/promises";
import path from "node:path";

import JSZip from "jszip";

import type {
  DocumentGenerationApproval,
  DocumentGenerationPlan,
  DocumentGenerationResult,
  PowerPointDraftOutline,
  PowerPointDraftSlide,
  ToolResult,
} from "../types/index.js";
import { resolveWorkspacePath } from "../utils/pathUtils.js";

const SLIDE_WIDTH_EMU = 12_192_000;
const SLIDE_HEIGHT_EMU = 6_858_000;

export async function createPptxDraft(
  workspaceRoot: string,
  plan: DocumentGenerationPlan,
  approval: DocumentGenerationApproval,
): Promise<ToolResult<DocumentGenerationResult>> {
  try {
    const validation = validateApprovedPowerPointPlan(plan, approval);
    if (validation !== null) {
      return fail(validation.code, validation.message);
    }

    const draft = plan.draft as PowerPointDraftOutline;
    const absolutePath = resolveWorkspacePath(workspaceRoot, draft.targetPath);

    if (path.extname(absolutePath).toLowerCase() !== ".pptx") {
      return fail("invalid_extension", "PPTX draft generation requires a .pptx target path.");
    }

    await rejectSymlinkTraversal(workspaceRoot, absolutePath, { includeTarget: false });
    await fs.mkdir(path.dirname(absolutePath), { recursive: true });

    const pptxBuffer = await buildPptxBuffer(draft);
    await fs.writeFile(absolutePath, pptxBuffer, { flag: "wx" });

    return ok({
      planId: plan.id,
      status: "created",
      targetPath: draft.targetPath,
      createdAt: new Date().toISOString(),
      warnings: draft.warnings,
    });
  } catch (cause) {
    if (isFileExistsError(cause)) {
      return fail("target_exists", "Target PPTX already exists. Generated documents do not overwrite files.");
    }

    if (isUnsafePathError(cause)) {
      return fail("outside_workspace", "PPTX target path is outside the selected workspace or uses unsupported symlink traversal.", cause);
    }

    return fail("pptx_generation_failed", "Unable to create PPTX draft.", cause);
  }
}

async function buildPptxBuffer(draft: PowerPointDraftOutline): Promise<Buffer> {
  const slideCount = Math.max(draft.slides.length, 1);
  const zip = new JSZip();
  zip.file("[Content_Types].xml", contentTypesXml(slideCount));
  zip.folder("_rels")?.file(".rels", rootRelationshipsXml());

  zip.folder("docProps")?.file("core.xml", corePropertiesXml(draft.title));
  zip.folder("docProps")?.file("app.xml", appPropertiesXml(slideCount));

  const ppt = zip.folder("ppt");
  ppt?.file("presentation.xml", presentationXml(slideCount));
  ppt?.file("presProps.xml", emptyPresentationPartXml("presProps"));
  ppt?.file("viewProps.xml", emptyPresentationPartXml("viewPr"));
  ppt?.file("tableStyles.xml", tableStylesXml());
  ppt?.folder("theme")?.file("theme1.xml", themeXml());
  ppt?.folder("slideMasters")?.file("slideMaster1.xml", slideMasterXml());
  ppt?.folder("slideMasters")?.folder("_rels")?.file("slideMaster1.xml.rels", slideMasterRelationshipsXml());
  ppt?.folder("slideLayouts")?.file("slideLayout1.xml", slideLayoutXml());
  ppt?.folder("slideLayouts")?.folder("_rels")?.file("slideLayout1.xml.rels", slideLayoutRelationshipsXml());
  ppt?.folder("_rels")?.file("presentation.xml.rels", presentationRelationshipsXml(slideCount));

  const slideFolder = ppt?.folder("slides");
  const slideRelsFolder = slideFolder?.folder("_rels");
  const slides = draft.slides.length > 0 ? draft.slides : [fallbackSlide(draft)];

  slides.forEach((slide, index) => {
    slideFolder?.file(`slide${index + 1}.xml`, slideXml(slide, index + 1, draft));
    slideRelsFolder?.file(`slide${index + 1}.xml.rels`, slideRelationshipsXml());
  });

  return zip.generateAsync({
    type: "nodebuffer",
    compression: "DEFLATE",
    compressionOptions: { level: 6 },
  });
}

function validateApprovedPowerPointPlan(
  plan: DocumentGenerationPlan,
  approval: DocumentGenerationApproval,
): { code: string; message: string } | null {
  if (plan.status !== "draft_proposed" || plan.requiresApproval !== true) {
    return { code: "invalid_plan_state", message: "Only proposed drafts that require approval can be generated." };
  }

  if (plan.draft.kind !== "powerpoint" || plan.draft.extension !== ".pptx") {
    return { code: "unsupported_draft_kind", message: "Only PowerPoint .pptx drafts are supported by this writer." };
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

function slideXml(slide: PowerPointDraftSlide, slideNumber: number, draft: PowerPointDraftOutline): string {
  const shapes = [
    textShapeXml(1, "Title", slide.title, 700_000, 520_000, 10_800_000, 800_000, 36, true),
    slide.subtitle === undefined ? "" : textShapeXml(2, "Subtitle", slide.subtitle, 700_000, 1_240_000, 10_800_000, 480_000, 18, false),
    ...slide.bullets.map((bullet, index) =>
      textShapeXml(10 + index, `Bullet ${index + 1}`, `- ${bullet}`, 950_000, 2_000_000 + index * 520_000, 10_100_000, 420_000, 20, false),
    ),
    slide.speakerNotes === undefined ? "" : textShapeXml(90, "Speaker Notes", `Notes: ${slide.speakerNotes}`, 700_000, 5_740_000, 10_800_000, 360_000, 11, false),
    slideNumber === 1
      ? textShapeXml(92, "Deck Title", draft.title, 700_000, 180_000, 10_800_000, 280_000, 13, false)
      : "",
    slideNumber === 1
      ? textShapeXml(91, "Draft Disclaimer", draft.draftDisclaimer.message, 700_000, 6_160_000, 10_800_000, 300_000, 10, false)
      : "",
  ].join("");

  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <p:cSld>
    <p:spTree>
      <p:nvGrpSpPr>
        <p:cNvPr id="1" name=""/>
        <p:cNvGrpSpPr/>
        <p:nvPr/>
      </p:nvGrpSpPr>
      <p:grpSpPr>
        <a:xfrm>
          <a:off x="0" y="0"/>
          <a:ext cx="0" cy="0"/>
          <a:chOff x="0" y="0"/>
          <a:chExt cx="0" cy="0"/>
        </a:xfrm>
      </p:grpSpPr>
      ${backgroundShapeXml()}
      ${shapes}
    </p:spTree>
  </p:cSld>
  <p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr>
</p:sld>`;
}

function backgroundShapeXml(): string {
  return `<p:sp>
    <p:nvSpPr><p:cNvPr id="200" name="Background"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr>
    <p:spPr>
      <a:xfrm><a:off x="0" y="0"/><a:ext cx="${SLIDE_WIDTH_EMU}" cy="${SLIDE_HEIGHT_EMU}"/></a:xfrm>
      <a:prstGeom prst="rect"><a:avLst/></a:prstGeom>
      <a:solidFill><a:srgbClr val="FFFDF9"/></a:solidFill>
      <a:ln><a:noFill/></a:ln>
    </p:spPr>
    <p:txBody><a:bodyPr/><a:lstStyle/><a:p/></p:txBody>
  </p:sp>`;
}

function textShapeXml(
  id: number,
  name: string,
  text: string,
  x: number,
  y: number,
  width: number,
  height: number,
  fontSizePt: number,
  bold: boolean,
): string {
  const boldXml = bold ? "<a:b/>" : "";
  const color = bold ? "222222" : "424242";

  return `<p:sp>
    <p:nvSpPr><p:cNvPr id="${300 + id}" name="${escapeXml(name)}"/><p:cNvSpPr txBox="1"/><p:nvPr/></p:nvSpPr>
    <p:spPr>
      <a:xfrm><a:off x="${x}" y="${y}"/><a:ext cx="${width}" cy="${height}"/></a:xfrm>
      <a:prstGeom prst="rect"><a:avLst/></a:prstGeom>
      <a:noFill/>
      <a:ln><a:noFill/></a:ln>
    </p:spPr>
    <p:txBody>
      <a:bodyPr wrap="square" lIns="0" tIns="0" rIns="0" bIns="0"/>
      <a:lstStyle/>
      <a:p>
        <a:r>
          <a:rPr lang="ja-JP" sz="${fontSizePt * 100}">${boldXml}<a:solidFill><a:srgbClr val="${color}"/></a:solidFill><a:latin typeface="Aptos"/><a:ea typeface="Yu Gothic"/></a:rPr>
          <a:t>${escapeXml(text)}</a:t>
        </a:r>
      </a:p>
    </p:txBody>
  </p:sp>`;
}

function contentTypesXml(slideCount: number): string {
  const slideOverrides = Array.from({ length: slideCount }, (_, index) =>
    `<Override PartName="/ppt/slides/slide${index + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>`,
  ).join("");

  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>
  <Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>
  <Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/>
  <Override PartName="/ppt/presProps.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presProps+xml"/>
  <Override PartName="/ppt/viewProps.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.viewProps+xml"/>
  <Override PartName="/ppt/tableStyles.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.tableStyles+xml"/>
  <Override PartName="/ppt/theme/theme1.xml" ContentType="application/vnd.openxmlformats-officedocument.theme+xml"/>
  <Override PartName="/ppt/slideMasters/slideMaster1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideMaster+xml"/>
  <Override PartName="/ppt/slideLayouts/slideLayout1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideLayout+xml"/>
  ${slideOverrides}
</Types>`;
}

function rootRelationshipsXml(): string {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="ppt/presentation.xml"/>
  <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>
  <Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/>
</Relationships>`;
}

function presentationXml(slideCount: number): string {
  const slideIds = Array.from({ length: slideCount }, (_, index) =>
    `<p:sldId id="${256 + index}" r:id="rId${index + 2}"/>`,
  ).join("");

  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:presentation xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rId1"/></p:sldMasterIdLst>
  <p:sldIdLst>${slideIds}</p:sldIdLst>
  <p:sldSz cx="${SLIDE_WIDTH_EMU}" cy="${SLIDE_HEIGHT_EMU}" type="screen16x9"/>
  <p:notesSz cx="6858000" cy="9144000"/>
</p:presentation>`;
}

function presentationRelationshipsXml(slideCount: number): string {
  const slideRelationships = Array.from({ length: slideCount }, (_, index) =>
    `<Relationship Id="rId${index + 2}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide${index + 1}.xml"/>`,
  ).join("");

  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideMaster" Target="slideMasters/slideMaster1.xml"/>
  ${slideRelationships}
</Relationships>`;
}

function slideRelationshipsXml(): string {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout" Target="../slideLayouts/slideLayout1.xml"/>
</Relationships>`;
}

function slideMasterXml(): string {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sldMaster xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/></p:spTree></p:cSld>
  <p:clrMap bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"/>
  <p:sldLayoutIdLst><p:sldLayoutId id="2147483649" r:id="rId1"/></p:sldLayoutIdLst>
</p:sldMaster>`;
}

function slideMasterRelationshipsXml(): string {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout" Target="../slideLayouts/slideLayout1.xml"/>
  <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/theme" Target="../theme/theme1.xml"/>
</Relationships>`;
}

function slideLayoutXml(): string {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sldLayout xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" type="blank" preserve="1">
  <p:cSld name="Blank"><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/></p:spTree></p:cSld>
  <p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr>
</p:sldLayout>`;
}

function slideLayoutRelationshipsXml(): string {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideMaster" Target="../slideMasters/slideMaster1.xml"/>
</Relationships>`;
}

function emptyPresentationPartXml(tag: "presProps" | "viewPr"): string {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:${tag} xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"/>`;
}

function tableStylesXml(): string {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<a:tblStyleLst xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" def="{5C22544A-7EE6-4342-B048-85BDC9FD1C3A}"/>`;
}

function themeXml(): string {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" name="Melunai Draft">
  <a:themeElements>
    <a:clrScheme name="Melunai">
      <a:dk1><a:srgbClr val="222222"/></a:dk1><a:lt1><a:srgbClr val="FFFDF9"/></a:lt1>
      <a:dk2><a:srgbClr val="424242"/></a:dk2><a:lt2><a:srgbClr val="F3EFE7"/></a:lt2>
      <a:accent1><a:srgbClr val="49697E"/></a:accent1><a:accent2><a:srgbClr val="9B6D36"/></a:accent2>
      <a:accent3><a:srgbClr val="6A8A78"/></a:accent3><a:accent4><a:srgbClr val="A45454"/></a:accent4>
      <a:accent5><a:srgbClr val="7A6E66"/></a:accent5><a:accent6><a:srgbClr val="D8C7A6"/></a:accent6>
      <a:hlink><a:srgbClr val="49697E"/></a:hlink><a:folHlink><a:srgbClr val="8A7167"/></a:folHlink>
    </a:clrScheme>
    <a:fontScheme name="Melunai Fonts"><a:majorFont><a:latin typeface="Aptos"/><a:ea typeface="Yu Gothic"/></a:majorFont><a:minorFont><a:latin typeface="Aptos"/><a:ea typeface="Yu Gothic"/></a:minorFont></a:fontScheme>
    <a:fmtScheme name="Melunai Format"><a:fillStyleLst/><a:lnStyleLst/><a:effectStyleLst/><a:bgFillStyleLst/></a:fmtScheme>
  </a:themeElements>
</a:theme>`;
}

function corePropertiesXml(title: string): string {
  const now = new Date().toISOString();
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
  <dc:title>${escapeXml(title)}</dc:title>
  <dc:creator>Melunai</dc:creator>
  <cp:lastModifiedBy>Melunai</cp:lastModifiedBy>
  <dcterms:created xsi:type="dcterms:W3CDTF">${now}</dcterms:created>
  <dcterms:modified xsi:type="dcterms:W3CDTF">${now}</dcterms:modified>
</cp:coreProperties>`;
}

function appPropertiesXml(slideCount: number): string {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties" xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes">
  <Application>Melunai</Application>
  <PresentationFormat>On-screen Show (16:9)</PresentationFormat>
  <Slides>${slideCount}</Slides>
</Properties>`;
}

function fallbackSlide(draft: PowerPointDraftOutline): PowerPointDraftSlide {
  return {
    id: "slide-1",
    title: draft.title,
    subtitle: draft.purpose,
    bullets: [],
  };
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
