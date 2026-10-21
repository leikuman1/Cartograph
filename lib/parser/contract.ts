import type { FileRole, Framework } from "../frameworks/taxonomy";

export const IMPORT_KINDS = ["import", "re-export", "dynamic-import", "require"] as const;

export type ImportKind = (typeof IMPORT_KINDS)[number];

export interface FileNode {
  path: string;
  folder: string;
  module: string;
  lineCount: number;
  contentHash: string;
  fanIn: number;
  fanOut: number;
  exports: string[];
}

export interface GraphEdge {
  source: string;
  target: string;
  kinds: ImportKind[];
}

export interface InternalResolution {
  status: "internal";
  target: string;
}

export interface ExternalResolution {
  status: "external";
  reason: string;
}

export interface ExcludedResolution {
  status: "excluded";
  reason: string;
  target?: string;
}

export interface UnresolvedResolution {
  status: "unresolved";
  reason: string;
}

export type ImportResolution =
  | InternalResolution
  | ExternalResolution
  | ExcludedResolution
  | UnresolvedResolution;

export interface ImportRecord {
  source: string;
  specifier: string | null;
  kind: ImportKind;
  line: number;
  resolution: ImportResolution;
}

export type SkippedFileReason =
  | "ignored"
  | "unsupported-extension"
  | "symlink"
  | "read-failed"
  | "invalid-utf8"
  | "unsupported-file-type"
  | "parse-failed";

export interface SkippedFile {
  path: string;
  reason: SkippedFileReason;
  detail?: string;
}

export type ExcludedDirectoryReason =
  | "ignored"
  | "structural-exclusion"
  | "symlink";

export interface ExcludedDirectory {
  path: string;
  reason: ExcludedDirectoryReason;
  detail?: string;
}

export interface FileCoverage {
  discovered: number;
  parsed: number;
  skipped: number;
  skippedFiles: SkippedFile[];
  excludedDirectories: ExcludedDirectory[];
}

export interface ImportCoverage {
  discovered: number;
  internal: number;
  external: number;
  excluded: number;
  unresolved: number;
}

export interface AnalysisCoverage {
  files: FileCoverage;
  imports: ImportCoverage;
}

export interface FileRoleRecord {
  file: string;
  role: FileRole;
}

export interface HttpRoute {
  file: string;
  method: string;
  path: string;
  line: number;
}

export interface AnalysisResult {
  schemaVersion: 1;
  framework: Framework;
  fileRoles: FileRoleRecord[];
  frameworkEntries: string[];
  routes: HttpRoute[];
  files: FileNode[];
  edges: GraphEdge[];
  imports: ImportRecord[];
  coverage: AnalysisCoverage;
}

export interface FileMetadata {
  path: string;
  folder: string;
  module: string;
  lineCount: number;
  contentHash: string;
  exports?: string[];
}

export interface InternalImport {
  source: string;
  target: string;
  kind: ImportKind;
}
