import type { FileNode, GraphEdge } from "../parser/contract";
import { categoryForFile, type DisplayRoleRecord, type FileCategory } from "../frameworks/taxonomy";
import { compareText } from "./graph";

export interface FileDetails {
  file: FileNode;
  dependencies: FileNode[];
  dependents: FileNode[];
}

export function countFileCategories(files: readonly FileNode[], fileRoles: readonly DisplayRoleRecord[]) {
  const counts = new Map<FileCategory, number>();
  for (const file of files) {
    const category = categoryForFile(file.path, fileRoles).id;
    counts.set(category, (counts.get(category) ?? 0) + 1);
  }
  return counts;
}

export function repositoryDetails(files: readonly FileNode[], edges: readonly GraphEdge[], fileRoles: readonly DisplayRoleRecord[]) {
  const byPath = new Map<string, FileDetails>(files.map(file => [file.path, { file, dependencies: [], dependents: [] }]));
  const dependencies = new Map(files.map(file => [file.path, new Set<string>()]));
  const dependents = new Map(files.map(file => [file.path, new Set<string>()]));
  for (const edge of edges) {
    if (!byPath.has(edge.source) || !byPath.has(edge.target)) {
      throw new Error(`Missing file for ${edge.source} → ${edge.target}`);
    }
    dependencies.get(edge.source)?.add(edge.target);
    dependents.get(edge.target)?.add(edge.source);
  }
  function resolve(paths: ReadonlySet<string> | undefined) {
    return [...(paths ?? [])].sort(compareText).map(path => {
      const details = byPath.get(path);
      if (!details) throw new Error(`Missing file ${path}`);
      return details.file;
    });
  }
  for (const [path, details] of byPath) {
    details.dependencies = resolve(dependencies.get(path));
    details.dependents = resolve(dependents.get(path));
  }
  const ordered = [...byPath.values()].sort((a, b) => compareText(a.file.path, b.file.path));
  const mostImported = ordered.filter(details => details.dependents.length > 0)
    .sort((a, b) => b.dependents.length - a.dependents.length || compareText(a.file.path, b.file.path));
  const entryPoints = ordered.filter(details => details.dependents.length === 0);
  return { byPath, mostImported, entryPoints, categoryCounts: countFileCategories(files, fileRoles) };
}

export type RepositoryDetails = ReturnType<typeof repositoryDetails>;

export function githubSourceUrl(repositoryUrl: string | null, commitSha: string | null, file: string, line: number): string | null {
  if (!repositoryUrl || !commitSha || !/^[a-f0-9]{40}$/i.test(commitSha) || !Number.isSafeInteger(line) || line < 1) return null;
  let repository: URL;
  try {
    repository = new URL(repositoryUrl);
  } catch {
    return null;
  }
  if (repository.protocol !== "https:" || repository.hostname !== "github.com") return null;
  const path = repository.pathname.replace(/\/$/, "").replace(/\.git$/, "");
  if (!/^\/[^/]+\/[^/]+$/.test(path)) return null;
  const segments = file.split("/");
  if (segments.some(segment => !segment || segment === "." || segment === ".." || segment.includes("\\"))) return null;
  const source = segments.map(segment => encodeURIComponent(segment)).join("/");
  return `https://github.com${path}/blob/${commitSha}/${source}#L${line}`;
}

export interface ImportedFile extends FileNode {
  importerCount: number;
}

export function fileImporters(files: readonly FileNode[], edges: readonly GraphEdge[]) {
  const importers = new Map<string, Set<string>>(files.map(file => [file.path, new Set<string>()]));
  for (const edge of edges) {
    const targets = importers.get(edge.target);
    if (!targets) throw new Error(`Missing imported file ${edge.target}`);
    targets.add(edge.source);
  }
  return importers;
}

export function importedFileCounts(files: readonly FileNode[], edges: readonly GraphEdge[]): ImportedFile[] {
  const importers = fileImporters(files, edges);
  return files.filter(file => (importers.get(file.path)?.size ?? 0) > 0)
    .map(file => ({ ...file, importerCount: importers.get(file.path)?.size ?? 0 }))
    .sort((a, b) => b.importerCount - a.importerCount || compareText(a.path, b.path));
}
