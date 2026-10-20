import type { FileNode, FileRoleRecord, GraphEdge } from "../parser/contract";
import { genericCategoryForPath, type Framework } from "../frameworks/taxonomy";
import { isFrameworkEntry } from "../frameworks/entry-points";
import { compareText } from "./graph";

export const TRAVERSAL_DEPTH = 2;
export const UNUSUALLY_IMPORTED = 10;
export const LONG_FILE_LINES = 500;

export type TraversalDirection = "dependents" | "dependencies";

export interface TraversalLevel {
  depth: number;
  files: FileNode[];
}

export interface TraversalResult {
  root: FileNode;
  direction: TraversalDirection;
  levels: TraversalLevel[];
  files: FileNode[];
}

function adjacency(edges: readonly GraphEdge[], direction: TraversalDirection) {
  const next = new Map<string, Set<string>>();
  for (const edge of edges) {
    const from = direction === "dependents" ? edge.target : edge.source;
    const to = direction === "dependents" ? edge.source : edge.target;
    const targets = next.get(from) ?? new Set<string>();
    targets.add(to);
    next.set(from, targets);
  }
  return next;
}

// Both directions are the same walk; only which endpoint counts as "from" changes.
export function traverse(
  files: readonly FileNode[],
  edges: readonly GraphEdge[],
  path: string,
  direction: TraversalDirection,
  maxDepth = TRAVERSAL_DEPTH,
): TraversalResult {
  const byPath = new Map(files.map(file => [file.path, file]));
  const root = byPath.get(path);
  if (!root) throw new Error(`Missing traversal root ${path}`);
  const next = adjacency(edges, direction);
  const seen = new Set([path]);
  const levels: TraversalLevel[] = [];
  let frontier = [path];
  for (let depth = 1; depth <= maxDepth; depth += 1) {
    const found = new Set<string>();
    for (const current of frontier) {
      for (const neighbor of next.get(current) ?? []) if (!seen.has(neighbor)) found.add(neighbor);
    }
    if (found.size === 0) break;
    const levelFiles = [...found].sort(compareText).map(neighbor => {
      const file = byPath.get(neighbor);
      if (!file) throw new Error(`Traversal reached missing file ${neighbor}`);
      return file;
    });
    for (const file of levelFiles) seen.add(file.path);
    levels.push({ depth, files: levelFiles });
    frontier = levelFiles.map(file => file.path);
  }
  return { root, direction, levels, files: levels.flatMap(level => level.files) };
}

export type EntryReason = "test" | "config" | "framework-entry" | "ambient-declaration";

const CONFIG_FILE = /(^|\/)[^/]*\.config\.[cm]?[jt]sx?$/;
// Tool config often lives in a dot directory, e.g. .vitest.config/setup.ts.
const CONFIG_DIRECTORY = /(^|\/)\.[^/]*config[^/]*(\/|$)/;
const AMBIENT_DECLARATION = /\.[cm]?d\.[cm]?ts$/;

// These files are reached by a framework or a tool rather than by an import, so
// a missing importer says nothing about whether the code is used.
export function entryReason(path: string, framework: Framework, fileRoles: readonly FileRoleRecord[]): EntryReason | null {
  if (AMBIENT_DECLARATION.test(path)) return "ambient-declaration";
  // Config before test: a vitest config inside a runtime-tests directory is still a tool entry point.
  if (CONFIG_FILE.test(path) || CONFIG_DIRECTORY.test(path)) return "config";
  if (isFrameworkEntry(framework, path, fileRoles)) return "framework-entry";
  if (genericCategoryForPath(path).id === "test") return "test";
  return null;
}

export function entryExclusionCounts(files: readonly FileNode[], framework: Framework, fileRoles: readonly FileRoleRecord[]) {
  const counts: Record<EntryReason, number> = { test: 0, config: 0, "framework-entry": 0, "ambient-declaration": 0 };
  for (const file of files) {
    const reason = entryReason(file.path, framework, fileRoles);
    if (reason) counts[reason] += 1;
  }
  return counts;
}

function sortedAdjacency(paths: readonly string[], edges: readonly GraphEdge[]) {
  const next = new Map<string, string[]>(paths.map(path => [path, []]));
  for (const edge of edges) next.get(edge.source)?.push(edge.target);
  for (const [path, targets] of next) next.set(path, [...new Set(targets)].sort(compareText));
  return next;
}

// Iterative Tarjan: a real repository can be deep enough to overflow a recursive walk.
function stronglyConnected(paths: readonly string[], next: ReadonlyMap<string, readonly string[]>) {
  let counter = 0;
  const index = new Map<string, number>();
  const low = new Map<string, number>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  const components: string[][] = [];

  for (const root of paths) {
    if (index.has(root)) continue;
    const work: { node: string; next: number }[] = [];
    const visit = (node: string) => {
      index.set(node, counter);
      low.set(node, counter);
      counter += 1;
      stack.push(node);
      onStack.add(node);
      work.push({ node, next: 0 });
    };
    visit(root);
    while (work.length > 0) {
      const frame = work[work.length - 1];
      const neighbors = next.get(frame.node) ?? [];
      if (frame.next < neighbors.length) {
        const neighbor = neighbors[frame.next];
        frame.next += 1;
        if (!index.has(neighbor)) visit(neighbor);
        else if (onStack.has(neighbor)) low.set(frame.node, Math.min(low.get(frame.node) ?? 0, index.get(neighbor) ?? 0));
      } else {
        work.pop();
        const parent = work.at(-1);
        if (parent) low.set(parent.node, Math.min(low.get(parent.node) ?? 0, low.get(frame.node) ?? 0));
        if (low.get(frame.node) === index.get(frame.node)) {
          const component: string[] = [];
          let node: string;
          do {
            node = stack.pop() ?? "";
            onStack.delete(node);
            component.push(node);
          } while (node !== frame.node);
          if (component.length > 1) components.push(component.sort(compareText));
        }
      }
    }
  }
  return components.sort((left, right) => compareText(left[0], right[0]));
}

function shortestCycle(component: readonly string[], start: string, next: ReadonlyMap<string, readonly string[]>) {
  const allowed = new Set(component);
  const parent = new Map<string, string>();
  const queue: string[] = [];
  for (const neighbor of next.get(start) ?? []) {
    if (!allowed.has(neighbor)) continue;
    if (neighbor === start) return [start, start];
    if (!parent.has(neighbor)) {
      parent.set(neighbor, start);
      queue.push(neighbor);
    }
  }
  for (let head = 0; head < queue.length; head += 1) {
    const current = queue[head];
    for (const neighbor of next.get(current) ?? []) {
      if (!allowed.has(neighbor)) continue;
      if (neighbor === start) {
        const path = [current];
        let cursor = current;
        while (cursor !== start) {
          cursor = parent.get(cursor) ?? start;
          path.push(cursor);
        }
        return path.reverse().concat(start);
      }
      if (!parent.has(neighbor)) {
        parent.set(neighbor, current);
        queue.push(neighbor);
      }
    }
  }
  throw new Error(`No cycle found in the strongly connected component containing ${start}`);
}

export interface Insights {
  unimported: FileNode[];
  widelyImported: FileNode[];
  cycles: string[][];
  longFiles: FileNode[];
}

export const INSIGHT_DESCRIPTIONS = {
  unimported: "No parsed file imports this file. Framework and tool entry points are excluded.",
  widelyImported: `At least ${UNUSUALLY_IMPORTED} parsed files import this file.`,
  cycles: "These files import each other through a closed path.",
  longFiles: `At least ${LONG_FILE_LINES} lines.`,
} as const;

export const INSIGHT_ORDER = ["unimported", "widelyImported", "cycles", "longFiles"] as const;

export function buildInsights(files: readonly FileNode[], edges: readonly GraphEdge[], framework: Framework, fileRoles: readonly FileRoleRecord[]): Insights {
  const paths = files.map(file => file.path).sort(compareText);
  const next = sortedAdjacency(paths, edges);
  const components = stronglyConnected(paths, next);
  const inCycle = new Set(components.flat());
  const cycles = components.map(component => shortestCycle(component, component[0], next));
  for (const path of paths) {
    if (!inCycle.has(path) && (next.get(path) ?? []).includes(path)) cycles.push([path, path]);
  }
  cycles.sort((left, right) => compareText(left[0], right[0]));
  return {
    unimported: files.filter(file => file.fanIn === 0 && entryReason(file.path, framework, fileRoles) === null)
      .sort((left, right) => compareText(left.path, right.path)),
    widelyImported: files.filter(file => file.fanIn >= UNUSUALLY_IMPORTED)
      .sort((left, right) => right.fanIn - left.fanIn || compareText(left.path, right.path)),
    cycles,
    longFiles: files.filter(file => file.lineCount >= LONG_FILE_LINES)
      .sort((left, right) => right.lineCount - left.lineCount || compareText(left.path, right.path)),
  };
}

export function insightCount(insights: Insights) {
  return insights.unimported.length + insights.widelyImported.length + insights.cycles.length + insights.longFiles.length;
}
