import * as fs from "fs";
import * as path from "path";

import type {
  CorpusBuildLimits,
  CorpusBuildResult,
  CorpusDocumentEntry,
  CorpusIndex,
  CorpusSkillNode,
} from "./corpusTypes.js";
import { extractDocuments, toDocumentSourceSelection } from "../document/documentExtractionRunner.js";

const DEFAULT_LIMITS: CorpusBuildLimits = {
  maxFiles: 240,
  maxCharsPerFile: 16_000,
  maxTotalChars: 420_000,
  maxDepth: 8,
};

const TEXT_EXTENSIONS = new Set([
  ".md",
  ".markdown",
  ".txt",
  ".csv",
  ".json",
  ".jsonl",
  ".yaml",
  ".yml",
  ".toml",
  ".xml",
  ".html",
  ".css",
  ".js",
  ".jsx",
  ".ts",
  ".tsx",
  ".py",
  ".java",
  ".cs",
  ".go",
  ".rs",
  ".sql",
  ".log",
]);

const DOCUMENT_EXTENSIONS = new Set([".pdf", ".docx", ".xlsx", ".pptx"]);

const IGNORED_DIRS = new Set([
  ".git",
  ".melunai",
  "node_modules",
  "dist",
  "dist-electron",
  "build",
  ".next",
  ".vite",
  "coverage",
]);

interface ScannedFile {
  absolutePath: string;
  relativePath: string;
  name: string;
  extension: string;
  sizeBytes: number;
}

interface FolderBucket {
  relativePath: string;
  documents: CorpusDocumentEntry[];
}

interface CorpusReadableContent {
  content: string;
  sourceKind: "text" | "document";
  status: "indexed" | "partial";
  segmentCount: number;
  titleHint?: string;
  warnings: string[];
}

export async function buildCorpusSkill(args: {
  workspaceRoot: string;
  limits?: Partial<CorpusBuildLimits>;
}): Promise<CorpusBuildResult> {
  const workspaceRoot = path.resolve(args.workspaceRoot);
  const limits = { ...DEFAULT_LIMITS, ...(args.limits ?? {}) };
  const corpusDir = path.join(workspaceRoot, ".melunai", "corpus");
  const docsDir = path.join(corpusDir, "docs");
  const treeDir = path.join(corpusDir, "tree");
  const warnings: string[] = [];

  await fs.promises.mkdir(docsDir, { recursive: true });
  await fs.promises.mkdir(treeDir, { recursive: true });

  const scannedFiles = await scanFiles(workspaceRoot, limits, warnings);
  const documents: CorpusDocumentEntry[] = [];
  let totalCharsIndexed = 0;

  for (const scanned of scannedFiles) {
    if (documents.length >= limits.maxFiles) {
      warnings.push(`Skipped ${scanned.relativePath}: file limit reached.`);
      continue;
    }
    if (totalCharsIndexed >= limits.maxTotalChars) {
      warnings.push(`Skipped ${scanned.relativePath}: corpus character limit reached.`);
      continue;
    }

    const read = await readCorpusFile(workspaceRoot, scanned, limits);
    if (read === null) {
      warnings.push(`Skipped ${scanned.relativePath}: unsupported or unreadable content.`);
      continue;
    }
    warnings.push(...read.warnings.map((warning) => `${scanned.relativePath}: ${warning}`));

    const remaining = limits.maxTotalChars - totalCharsIndexed;
    const content = read.content.slice(0, Math.max(0, remaining));
    totalCharsIndexed += content.length;
    const id = `doc-${String(documents.length + 1).padStart(4, "0")}`;
    const title = read.titleHint ?? extractTitle(content, scanned.name);
    const keywords = extractKeywords(`${title}\n${scanned.relativePath}\n${content}`, 12);
    const docTextPath = path.join(docsDir, `${id}.txt`);
    await fs.promises.writeFile(
      docTextPath,
      [
        `# ${title}`,
        "",
        `Path: ${scanned.relativePath}`,
        `Extension: ${scanned.extension || "(none)"}`,
        "",
        content,
      ].join("\n"),
      "utf8",
    );

    documents.push({
      id,
      path: scanned.relativePath,
      name: scanned.name,
      extension: scanned.extension,
      sizeBytes: scanned.sizeBytes,
      sourceKind: read.sourceKind,
      status: read.status,
      segmentCount: read.segmentCount,
      title,
      preview: compactWhitespace(content).slice(0, 700),
      keywords,
      skillPath: relativeFromRoot(workspaceRoot, docTextPath),
    });
  }

  const buckets = bucketDocuments(documents);
  const root = buildSkillTree({
    workspaceRoot,
    corpusDir,
    treeDir,
    relativePath: "",
    buckets,
    documents,
  });

  await writeSkillFiles(workspaceRoot, root, documents);

  const rootSkillPath = path.join(corpusDir, "SKILL.md");
  await fs.promises.writeFile(
    rootSkillPath,
    renderRootSkill(root, documents, warnings),
    "utf8",
  );

  const index: CorpusIndex = {
    version: 1,
    builtAt: new Date().toISOString(),
    workspaceRoot,
    corpusDir,
    limits,
    rootSkillPath: relativeFromRoot(workspaceRoot, rootSkillPath),
    totalFilesScanned: scannedFiles.length,
    indexedFileCount: documents.length,
    skippedFileCount: Math.max(0, scannedFiles.length - documents.length),
    totalCharsIndexed,
    root,
    documents,
    warnings,
  };

  await fs.promises.writeFile(
    path.join(corpusDir, "index.json"),
    JSON.stringify(index, null, 2),
    "utf8",
  );

  return { index };
}

async function scanFiles(
  workspaceRoot: string,
  limits: CorpusBuildLimits,
  warnings: string[],
): Promise<ScannedFile[]> {
  const files: ScannedFile[] = [];
  // realpath ベースの訪問済みセットでジャンクション・symlink ループを検出する。
  // Windows のジャンクションは Dirent.isDirectory() が true を返してしまうため、
  // realpath が一致するディレクトリの再訪問を弾くことが唯一の防御策。
  const visited = new Set<string>();

  async function walk(absoluteDir: string, depth: number): Promise<void> {
    if (depth > limits.maxDepth) return;

    // realpath で実体を取り、訪問済みなら循環として中断
    let realDir: string;
    try {
      realDir = await fs.promises.realpath(absoluteDir);
    } catch {
      // realpath できないディレクトリは諦めて continue（symlink 切れ等）
      warnings.push(`Could not resolve real path for ${relativeFromRoot(workspaceRoot, absoluteDir)}.`);
      return;
    }
    if (visited.has(realDir)) {
      warnings.push(`Skipped repeated directory (loop?): ${relativeFromRoot(workspaceRoot, absoluteDir)}.`);
      return;
    }
    visited.add(realDir);

    let entries: fs.Dirent[];
    try {
      entries = await fs.promises.readdir(absoluteDir, { withFileTypes: true });
    } catch (cause) {
      warnings.push(`Could not read ${relativeFromRoot(workspaceRoot, absoluteDir)}: ${formatError(cause)}`);
      return;
    }

    entries.sort((a, b) => a.name.localeCompare(b.name));

    for (const entry of entries) {
      const absolutePath = path.join(absoluteDir, entry.name);
      const relativePath = relativeFromRoot(workspaceRoot, absolutePath);

      // シンボリックリンクは明示的にスキップ（リンク先脱出防止）
      if (entry.isSymbolicLink()) {
        continue;
      }

      if (entry.isDirectory()) {
        if (!IGNORED_DIRS.has(entry.name)) {
          await walk(absolutePath, depth + 1);
        }
        continue;
      }

      if (!entry.isFile()) continue;
      const extension = path.extname(entry.name).toLowerCase();
      if (!TEXT_EXTENSIONS.has(extension) && !DOCUMENT_EXTENSIONS.has(extension)) continue;

      try {
        // ファイルも lstat でチェックし、後続でシンボリックリンクを通さないようにする
        const lst = await fs.promises.lstat(absolutePath);
        if (lst.isSymbolicLink()) continue;
        files.push({
          absolutePath,
          relativePath,
          name: entry.name,
          extension,
          sizeBytes: lst.size,
        });
      } catch (cause) {
        warnings.push(`Could not stat ${relativePath}: ${formatError(cause)}`);
      }
    }
  }

  await walk(workspaceRoot, 0);
  return files;
}

async function readTextPreview(file: ScannedFile, maxChars: number): Promise<string | null> {
  try {
    const raw = await fs.promises.readFile(file.absolutePath, "utf8");
    const normalized = raw.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
    if (looksBinary(normalized)) return null;
    return normalized.slice(0, maxChars);
  } catch {
    return null;
  }
}

async function readCorpusFile(
  workspaceRoot: string,
  file: ScannedFile,
  limits: CorpusBuildLimits,
): Promise<CorpusReadableContent | null> {
  if (DOCUMENT_EXTENSIONS.has(file.extension)) {
    const selection = toDocumentSourceSelection(file.relativePath);
    if (selection === null) return null;

    const extracted = await extractDocuments({
      workspaceRoot,
      paths: [file.relativePath],
      userInstruction: "Build Corpus2Skill navigation map.",
      limits: {
        maxFiles: 1,
        maxCharsPerFile: limits.maxCharsPerFile,
        maxTotalChars: limits.maxCharsPerFile,
        maxPagesPerPdf: 12,
        maxParagraphsPerDocx: 220,
        maxSheetsPerXlsx: 8,
        maxCellsPerSheet: 1_200,
        maxSlidesPerPptx: 60,
      },
    });
    const document = extracted.documents[0];
    if (document === undefined || document.segments.length === 0) return null;

    const content = document.segments
      .map((segment) => {
        const label = segmentLabel(segment);
        return label.length > 0 ? `## ${label}\n${segment.text}` : segment.text;
      })
      .join("\n\n")
      .slice(0, limits.maxCharsPerFile);

    return {
      content,
      sourceKind: "document",
      status: document.truncated || document.status === "partial" ? "partial" : "indexed",
      segmentCount: document.segments.length,
      titleHint: document.metadata?.title,
      warnings: document.warnings,
    };
  }

  const text = await readTextPreview(file, limits.maxCharsPerFile);
  if (text === null) return null;
  return {
    content: text,
    sourceKind: "text",
    status: text.length >= limits.maxCharsPerFile ? "partial" : "indexed",
    segmentCount: 1,
    warnings: [],
  };
}

function bucketDocuments(documents: CorpusDocumentEntry[]): FolderBucket[] {
  const map = new Map<string, CorpusDocumentEntry[]>();
  for (const document of documents) {
    const folder = normalizeRelativeDir(path.dirname(document.path));
    const existing = map.get(folder) ?? [];
    existing.push(document);
    map.set(folder, existing);
  }
  return Array.from(map.entries()).map(([relativePath, docs]) => ({ relativePath, documents: docs }));
}

function buildSkillTree(args: {
  workspaceRoot: string;
  corpusDir: string;
  treeDir: string;
  relativePath: string;
  buckets: FolderBucket[];
  documents: CorpusDocumentEntry[];
}): CorpusSkillNode {
  const directDocuments = args.documents.filter(
    (document) => normalizeRelativeDir(path.dirname(document.path)) === args.relativePath,
  );

  const childNames = new Set<string>();
  for (const bucket of args.buckets) {
    if (bucket.relativePath === args.relativePath) continue;
    const remainder = args.relativePath.length === 0
      ? bucket.relativePath
      : stripPrefix(bucket.relativePath, `${args.relativePath}/`);
    if (remainder === null || remainder.length === 0) continue;
    childNames.add(remainder.split("/")[0] ?? "");
  }

  const children = Array.from(childNames)
    .filter((name) => name.length > 0)
    .sort((a, b) => a.localeCompare(b))
    .map((name) => buildSkillTree({
      ...args,
      relativePath: args.relativePath.length === 0 ? name : `${args.relativePath}/${name}`,
    }));

  const descendantDocumentIds = children.flatMap((child) => collectDocumentIds(child));
  const nodeDocumentIds = [...directDocuments.map((document) => document.id), ...descendantDocumentIds];
  const nodeDocuments = args.documents.filter((document) => nodeDocumentIds.includes(document.id));
  const name = args.relativePath.length === 0 ? "Corpus" : path.basename(args.relativePath);
  const keywords = extractKeywords(
    nodeDocuments.flatMap((document) => [document.title, document.path, ...document.keywords]).join("\n"),
    14,
  );
  const summary = summarizeNode(name, nodeDocuments, children);
  const skillAbsolutePath = args.relativePath.length === 0
    ? path.join(args.corpusDir, "SKILL.md")
    : path.join(args.treeDir, safeSkillFilename(args.relativePath), "SKILL.md");

  return {
    id: args.relativePath.length === 0 ? "root" : safeSkillFilename(args.relativePath),
    name,
    relativePath: args.relativePath,
    skillPath: relativeFromRoot(args.workspaceRoot, skillAbsolutePath),
    summary,
    keywords,
    documentIds: directDocuments.map((document) => document.id),
    children,
  };
}

async function writeSkillFiles(
  workspaceRoot: string,
  node: CorpusSkillNode,
  documents: CorpusDocumentEntry[],
): Promise<void> {
  if (node.relativePath.length > 0) {
    const absolutePath = path.join(workspaceRoot, node.skillPath);
    await fs.promises.mkdir(path.dirname(absolutePath), { recursive: true });
    await fs.promises.writeFile(absolutePath, renderNodeSkill(node, documents), "utf8");
  }
  for (const child of node.children) {
    await writeSkillFiles(workspaceRoot, child, documents);
  }
}

function renderRootSkill(
  root: CorpusSkillNode,
  documents: CorpusDocumentEntry[],
  warnings: string[],
): string {
  return [
    "# Corpus2Skill Index",
    "",
    "This folder is a generated navigation map for Melunai. Use it as a compact guide before reading source documents.",
    "",
    `- Indexed documents: ${documents.length}`,
    `- Text files: ${documents.filter((document) => document.sourceKind === "text").length}`,
    `- Extracted Office/PDF files: ${documents.filter((document) => document.sourceKind === "document").length}`,
    `- Top keywords: ${root.keywords.join(", ") || "(none)"}`,
    "",
    "## Agent Rules",
    "",
    "- Do not read every source document by default.",
    "- Start from this SKILL.md, then choose one or two relevant child skills.",
    "- Prefer the listed document excerpts before opening full original files.",
    "- If the user request is broad, summarize the relevant branch first and ask whether to go deeper.",
    "",
    "## How To Navigate",
    "",
    "1. Read this root skill first.",
    "2. Pick the most relevant child skill.",
    "3. Read only the listed document excerpts needed for the user request.",
    "",
    "## Child Skills",
    "",
    ...root.children.map((child) => `- [${child.name}](${child.skillPath}) - ${child.summary}`),
    "",
    "## Root Documents",
    "",
    ...renderDocumentList(root.documentIds, documents),
    "",
    warnings.length > 0 ? "## Warnings" : "",
    ...warnings.slice(0, 30).map((warning) => `- ${warning}`),
    "",
  ].join("\n");
}

function renderNodeSkill(node: CorpusSkillNode, documents: CorpusDocumentEntry[]): string {
  const nodeDocs = node.documentIds
    .map((id) => documents.find((document) => document.id === id))
    .filter((document): document is CorpusDocumentEntry => document !== undefined);

  return [
    `# ${node.name}`,
    "",
    node.summary,
    "",
    `- Relative path: ${node.relativePath}`,
    `- Keywords: ${node.keywords.join(", ") || "(none)"}`,
    "",
    "## Child Skills",
    "",
    ...(node.children.length > 0
      ? node.children.map((child) => `- [${child.name}](${child.skillPath}) - ${child.summary}`)
      : ["- None"]),
    "",
    "## Documents",
    "",
    ...renderDocumentList(node.documentIds, documents),
    "",
    "## Local Reading Notes",
    "",
    ...nodeDocs.slice(0, 8).map((document) => `- ${document.title}: ${document.preview}`),
    "",
  ].join("\n");
}

function renderDocumentList(ids: string[], documents: CorpusDocumentEntry[]): string[] {
  if (ids.length === 0) return ["- None"];
  return ids.flatMap((id) => {
    const document = documents.find((candidate) => candidate.id === id);
    if (document === undefined) return [];
    return [`- ${document.id}: [${document.title}](${document.skillPath}) - ${document.path} (${document.sourceKind}, ${document.segmentCount} segment(s), ${document.status})`];
  });
}

function summarizeNode(
  name: string,
  documents: CorpusDocumentEntry[],
  children: CorpusSkillNode[],
): string {
  const extensions = countBy(documents.map((document) => document.extension || "text"));
  const extensionSummary = Array.from(extensions.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 4)
    .map(([extension, count]) => `${extension} ${count}`)
    .join(", ");
  const childSummary = children.length > 0 ? `${children.length} child area(s)` : "no child areas";
  return `${name} contains ${documents.length} indexed document(s), ${childSummary}${extensionSummary.length > 0 ? `, ${extensionSummary}` : ""}.`;
}

function extractTitle(content: string, fallback: string): string {
  const heading = content
    .split("\n")
    .map((line) => line.trim())
    .find((line) => line.startsWith("#") && line.replace(/^#+\s*/, "").length > 0);
  if (heading !== undefined) return heading.replace(/^#+\s*/, "").slice(0, 120);
  const firstLine = content
    .split("\n")
    .map((line) => line.trim())
    .find((line) => line.length > 0);
  return (firstLine ?? fallback).slice(0, 120);
}

function extractKeywords(text: string, limit: number): string[] {
  const counts = new Map<string, number>();
  const words = text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}_\-./]+/gu, " ")
    .split(/\s+/)
    .map((word) => word.trim())
    .filter((word) => word.length >= 2 && !STOP_WORDS.has(word));

  for (const word of words) {
    counts.set(word, (counts.get(word) ?? 0) + 1);
  }

  return Array.from(counts.entries())
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, limit)
    .map(([word]) => word);
}

function collectDocumentIds(node: CorpusSkillNode): string[] {
  return [...node.documentIds, ...node.children.flatMap((child) => collectDocumentIds(child))];
}

/** Windows reserved file names. Even with extensions these crash on Windows. */
const WIN_RESERVED_NAMES: ReadonlySet<string> = new Set([
  "CON", "PRN", "AUX", "NUL",
  "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8", "COM9",
  "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9",
]);

function safeSkillFilename(relativePath: string): string {
  let result = relativePath
    .replace(/[<>:"\\|?*\u0000-\u001F]/g, "_")
    .replace(/[/.]+/g, "__")
    .replace(/^_+|_+$/g, "")
    .slice(0, 120);
  if (result.length === 0) return "root";
  // Avoid Windows reserved names (CON/PRN/AUX/NUL/COMx/LPTx) which cause EINVAL on writeFile.
  if (WIN_RESERVED_NAMES.has(result.toUpperCase())) result = `_${result}`;
  return result;
}

function relativeFromRoot(root: string, target: string): string {
  return path.relative(root, target).replace(/\\/g, "/");
}

function normalizeRelativeDir(value: string): string {
  if (value === "." || value.length === 0) return "";
  return value.replace(/\\/g, "/");
}

function stripPrefix(value: string, prefix: string): string | null {
  return value.startsWith(prefix) ? value.slice(prefix.length) : null;
}

function compactWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function looksBinary(value: string): boolean {
  if (value.includes("\u0000")) return true;
  const sample = value.slice(0, 2000);
  if (sample.length === 0) return false;
  const controlCount = Array.from(sample).filter((char) => {
    const code = char.charCodeAt(0);
    return code < 32 && char !== "\n" && char !== "\t";
  }).length;
  return controlCount / sample.length > 0.08;
}

function countBy(values: string[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  return counts;
}

function segmentLabel(segment: {
  kind: string;
  pageNumber?: number;
  sheetName?: string;
  cellRange?: string;
  slideNumber?: number;
}): string {
  if (segment.pageNumber !== undefined) return `page ${segment.pageNumber}`;
  if (segment.slideNumber !== undefined) return `slide ${segment.slideNumber}`;
  if (segment.sheetName !== undefined && segment.cellRange !== undefined) {
    return `${segment.sheetName} ${segment.cellRange}`;
  }
  if (segment.sheetName !== undefined) return segment.sheetName;
  return segment.kind;
}

function formatError(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

const STOP_WORDS = new Set([
  "the",
  "and",
  "for",
  "with",
  "from",
  "that",
  "this",
  "are",
  "was",
  "were",
  "です",
  "ます",
  "する",
  "した",
  "これ",
  "それ",
  "ため",
  "こと",
  "もの",
]);
