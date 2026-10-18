import type { FileNode, GraphEdge } from "../parser/contract";
import { compareText, fileCategory } from "./graph";

export interface FileDetails {
  file: FileNode;
  dependencies: FileNode[];
  dependents: FileNode[];
}

export function countFileCategories(files: readonly FileNode[]) {
  const counts = { source: 0, test: 0, declaration: 0 };
  for (const file of files) counts[fileCategory(file.path)] += 1;
  return counts;
}

export function repositoryDetails(files: readonly FileNode[], edges: readonly GraphEdge[]) {
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
  return { byPath, mostImported, entryPoints, categoryCounts: countFileCategories(files) };
}

export type RepositoryDetails = ReturnType<typeof repositoryDetails>;
