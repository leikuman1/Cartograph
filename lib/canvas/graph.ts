import type { FileNode, GraphEdge } from "../parser/contract";

export function compareText(left: string, right: string) {
  return left < right ? -1 : left > right ? 1 : 0;
}

export interface FolderGroup {
  id: string;
  path: string;
  files: FileNode[];
  fanIn: number;
  fanOut: number;
}

export interface FoldedGraph {
  threshold: number;
  groups: FolderGroup[];
  owner: ReadonlyMap<string, string>;
}

function parentFolder(folder: string) {
  const separator = folder.lastIndexOf("/");
  return separator < 0 ? "." : folder.slice(0, separator);
}

function depth(folder: string) {
  return folder === "." ? 0 : folder.split("/").length;
}

function foldAtThreshold(files: readonly FileNode[], threshold: number) {
  const directories = new Map<string, FileNode[]>();
  directories.set(".", []);
  for (const file of [...files].sort((a, b) => compareText(a.path, b.path))) {
    let folder = file.folder;
    if (!directories.has(folder)) directories.set(folder, []);
    directories.get(folder)?.push(file);
    while (folder !== ".") {
      folder = parentFolder(folder);
      if (!directories.has(folder)) directories.set(folder, []);
    }
  }

  const maximumDepth = Math.max(0, ...Array.from(directories.keys(), depth));
  for (let level = maximumDepth; level > 0; level -= 1) {
    // Decide the entire level from one snapshot, then apply its merges together.
    const merging = [...directories.entries()]
      .filter(([folder, members]) => depth(folder) === level && members.length < threshold)
      .sort(([left], [right]) => compareText(left, right));
    for (const [folder, members] of merging) {
      directories.get(parentFolder(folder))?.push(...members);
      directories.delete(folder);
    }
  }
  return [...directories.entries()]
    .filter(([, members]) => members.length > 0)
    .sort(([left], [right]) => compareText(left, right));
}

export function foldFolders(files: readonly FileNode[], edges: readonly GraphEdge[]): FoldedGraph {
  const maximumNodes = 26;
  let threshold = 3;
  let folded = foldAtThreshold(files, threshold);
  while (files.length > 1 && (folded.length > maximumNodes || folded.some(([, members]) => members.length === 1))) {
    threshold += 1;
    folded = foldAtThreshold(files, threshold);
  }
  const groups: FolderGroup[] = folded.map(([folder, members]) => ({
    id: `folder:${folder}`,
    path: folder,
    files: members.sort((a, b) => compareText(a.path, b.path)),
    fanIn: 0,
    fanOut: 0,
  }));
  const owner = new Map<string, string>();
  const byId = new Map(groups.map(group => [group.id, group]));
  const incoming = new Map(groups.map(group => [group.id, new Set<string>()]));
  const outgoing = new Map(groups.map(group => [group.id, new Set<string>()]));
  for (const group of groups) for (const file of group.files) owner.set(file.path, group.id);
  for (const edge of edges) {
    const source = owner.get(edge.source);
    const target = owner.get(edge.target);
    if (!source || !target) throw new Error(`Edge has no folder owner: ${edge.source} → ${edge.target}`);
    if (source !== target) {
      incoming.get(target)?.add(edge.source);
      outgoing.get(source)?.add(edge.target);
    }
  }
  for (const [id, group] of byId) {
    group.fanIn = incoming.get(id)?.size ?? 0;
    group.fanOut = outgoing.get(id)?.size ?? 0;
  }
  return { threshold, groups, owner };
}

// Labels are suffixes of real paths, disambiguated against everything visible.
export function shortestUniqueLabels(paths: readonly string[]) {
  const labels = new Map<string, string>();
  for (const path of paths) {
    if (path === ".") {
      labels.set(path, ".");
      continue;
    }
    const parts = path.split("/");
    for (let length = 1; length <= parts.length; length += 1) {
      const suffix = parts.slice(-length).join("/");
      if (!paths.some(other => other !== path && (other === suffix || other.endsWith(`/${suffix}`)))) {
        labels.set(path, suffix);
        break;
      }
    }
    if (!labels.has(path)) labels.set(path, path);
  }
  return labels;
}

export type Selection = { kind: "folder"; id: string } | { kind: "file"; path: string } | null;

export function selectionContext(folded: FoldedGraph, edges: readonly GraphEdge[], selection: Selection) {
  const selectedFiles = new Set<string>();
  if (selection?.kind === "file") selectedFiles.add(selection.path);
  if (selection?.kind === "folder") {
    for (const file of folded.groups.find(group => group.id === selection.id)?.files ?? []) selectedFiles.add(file.path);
  }
  const visibleFiles = new Set(selectedFiles);
  const incoming = new Set<string>();
  const outgoing = new Set<string>();
  for (const edge of edges) {
    if (selectedFiles.has(edge.target)) {
      incoming.add(edge.source);
      visibleFiles.add(edge.source);
    }
    if (selectedFiles.has(edge.source)) {
      outgoing.add(edge.target);
      visibleFiles.add(edge.target);
    }
  }
  const visibleGroups = new Set<string>();
  for (const file of visibleFiles) {
    const group = folded.owner.get(file);
    if (group) visibleGroups.add(group);
  }
  return { selectedFiles, visibleFiles, visibleGroups, incoming, outgoing };
}

export const ROWS_PER_PANEL = 9;
export const PANEL_HEADER_HEIGHT = 62;
export const FILE_ROW_HEIGHT = 26;
export const PANEL_FOOTER_HEIGHT = 30;

export function panelFiles(group: FolderGroup, page: number) {
  const pageCount = Math.ceil(group.files.length / ROWS_PER_PANEL);
  const current = Math.max(0, Math.min(page, pageCount - 1));
  return group.files.slice(current * ROWS_PER_PANEL, (current + 1) * ROWS_PER_PANEL);
}

export function dependentHeight(fanIn: number) {
  return 66 + 10 * Math.log2(1 + fanIn);
}

export interface VisibleConnection {
  id: string;
  source: string;
  target: string;
  sourceHandle: string;
  targetHandle: string;
  originals: GraphEdge[];
}

export function visibleConnections(
  folded: FoldedGraph,
  edges: readonly GraphEdge[],
  expanded: ReadonlySet<string>,
  pages: ReadonlyMap<string, number>,
): VisibleConnection[] {
  const shown = new Map(folded.groups.map(group => [group.id, new Set(panelFiles(group, pages.get(group.id) ?? 0).map(file => file.path))]));
  const combined = new Map<string, VisibleConnection>();
  for (const edge of [...edges].sort((a, b) => compareText(a.source, b.source) || compareText(a.target, b.target))) {
    const source = folded.owner.get(edge.source);
    const target = folded.owner.get(edge.target);
    if (!source || !target) throw new Error(`Missing endpoint for ${edge.source} → ${edge.target}`);
    if (source === target && !expanded.has(source)) continue;
    const handle = (id: string, file: string, direction: string) => !expanded.has(id)
      ? direction
      : shown.get(id)?.has(file) ? `${direction}:${file}` : `${direction}:overflow`;
    const sourceHandle = handle(source, edge.source, "out");
    const targetHandle = handle(target, edge.target, source === target ? "in-right" : "in");
    const id = JSON.stringify([source, sourceHandle, target, targetHandle]);
    const existing = combined.get(id);
    if (existing) existing.originals.push(edge);
    else combined.set(id, { id, source, target, sourceHandle, targetHandle, originals: [edge] });
  }
  return [...combined.values()].sort((a, b) => compareText(a.id, b.id));
}
