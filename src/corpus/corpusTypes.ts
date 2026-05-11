export interface CorpusBuildLimits {
  maxFiles: number;
  maxCharsPerFile: number;
  maxTotalChars: number;
  maxDepth: number;
}

export interface CorpusDocumentEntry {
  id: string;
  path: string;
  name: string;
  extension: string;
  sizeBytes: number;
  sourceKind: "text" | "document";
  status: "indexed" | "partial";
  segmentCount: number;
  title: string;
  preview: string;
  keywords: string[];
  skillPath: string;
}

export interface CorpusSkillNode {
  id: string;
  name: string;
  relativePath: string;
  skillPath: string;
  summary: string;
  keywords: string[];
  documentIds: string[];
  children: CorpusSkillNode[];
}

export interface CorpusIndex {
  version: 1;
  builtAt: string;
  workspaceRoot: string;
  corpusDir: string;
  limits: CorpusBuildLimits;
  rootSkillPath: string;
  totalFilesScanned: number;
  indexedFileCount: number;
  skippedFileCount: number;
  totalCharsIndexed: number;
  root: CorpusSkillNode;
  documents: CorpusDocumentEntry[];
  warnings: string[];
}

export interface CorpusBuildResult {
  index: CorpusIndex;
}

export interface CorpusNavigateHit {
  kind: "skill" | "document";
  score: number;
  title: string;
  path: string;
  summary: string;
  keywords: string[];
}

export interface CorpusNavigateResult {
  query: string;
  rootSkillPath: string;
  hits: CorpusNavigateHit[];
  navigationMarkdown: string;
}
