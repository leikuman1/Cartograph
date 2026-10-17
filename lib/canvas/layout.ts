import { Graph, layout, type EdgeLabel, type GraphLabel, type NodeLabel } from "@dagrejs/dagre";
import type { FoldedGraph, VisibleConnection } from "./graph";
import { internalLanes, type Rectangle } from "./routing";
import { compareText, dependentHeight, FILE_ROW_HEIGHT, PANEL_FOOTER_HEIGHT, PANEL_HEADER_HEIGHT, panelFiles, shortestUniqueLabels } from "./graph";

export interface PositionedFolder {
  id: string;
  label: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

function textWidth(value: string) {
  return value.length * 7.3;
}

export function layoutFolders(
  folded: FoldedGraph,
  expanded: ReadonlySet<string>,
  pages: ReadonlyMap<string, number>,
  connections: readonly VisibleConnection[],
): PositionedFolder[] {
  const visiblePaths = folded.groups.flatMap(group => [group.path, ...(expanded.has(group.id) ? panelFiles(group, pages.get(group.id) ?? 0).map(file => file.path) : [])]);
  const labels = shortestUniqueLabels(visiblePaths);
  const nodes = folded.groups.map(group => {
    const label = labels.get(group.path) ?? group.path;
    const open = expanded.has(group.id);
    const rows = panelFiles(group, pages.get(group.id) ?? 0);
    const longestRow = Math.max(0, ...rows.map(file => textWidth(labels.get(file.path) ?? file.path)));
    return {
      id: group.id, label, x: 0, y: 0,
      width: open ? Math.max(250, textWidth(label) + 76, longestRow + 130) : Math.max(154, textWidth(label) + 52),
      height: open ? PANEL_HEADER_HEIGHT + rows.length * FILE_ROW_HEIGHT + PANEL_FOOTER_HEIGHT : dependentHeight(group.fanIn),
    };
  });
  const graph = new Graph<GraphLabel, NodeLabel, EdgeLabel>();
  graph.setGraph({ rankdir: "TB", ranksep: 58, nodesep: 24, edgesep: 10, marginx: 20, marginy: 20, ranker: "tight-tree" });
  for (const node of nodes) graph.setNode(node.id, { width: node.width, height: node.height });
  const pairs = new Map<string, { source: string; target: string; weight: number }>();
  for (const edge of connections) {
    if (edge.source === edge.target) continue;
    const key = JSON.stringify([edge.source, edge.target]);
    const pair = pairs.get(key);
    if (pair) pair.weight += edge.originals.length;
    else pairs.set(key, { source: edge.source, target: edge.target, weight: edge.originals.length });
  }
  for (const [, edge] of [...pairs].sort(([a], [b]) => compareText(a, b))) {
    graph.setEdge(edge.source, edge.target, { weight: edge.weight });
  }
  layout(graph);
  const routingWidths = internalLanes(folded, connections, pages).widths;
  const ordered = [...nodes].sort((a, b) => {
    const left = graph.node(a.id);
    const right = graph.node(b.id);
    if (left.x === undefined || left.y === undefined || right.x === undefined || right.y === undefined) throw new Error("Layout has no position");
    return left.y - right.y || left.x - right.x || compareText(a.id, b.id);
  });
  // Cycles and disconnected benchmark trees make unbounded ranks unreadably tall.
  // Keep dagre's dependency order, then pack whole objects into balanced shelves.
  let best: PositionedFolder[] = [];
  let bestScale = Infinity;
  for (let columns = 1; columns <= ordered.length; columns += 1) {
    const packed: PositionedFolder[] = [];
    let y = 0;
    let width = 0;
    for (let start = 0; start < ordered.length; start += columns) {
      const row = ordered.slice(start, start + columns);
      const height = Math.max(...row.map(node => node.height));
      let x = 0;
      for (const node of row) {
        packed.push({ ...node, x, y: y + (height - node.height) / 2 });
        x += node.width + Math.max(26, (routingWidths.get(node.id) ?? 0) + 20);
      }
      width = Math.max(width, x - 26);
      y += height + 36;
    }
    const scale = Math.max(width / 1060, (y - 36) / 720);
    if (scale < bestScale) {
      bestScale = scale;
      best = packed;
    }
  }
  return best.sort((a, b) => compareText(a.id, b.id));
}

export interface Viewport { x: number; y: number; zoom: number }

export function fitViewport(nodes: readonly Rectangle[], width: number, height: number, maximumZoom: number): Viewport {
  if (!nodes.length || width <= 0 || height <= 0) return { x: 0, y: 0, zoom: Math.min(1, maximumZoom) };
  const left = Math.min(...nodes.map(node => node.x));
  const top = Math.min(...nodes.map(node => node.y));
  const right = Math.max(...nodes.map(node => node.x + node.width));
  const bottom = Math.max(...nodes.map(node => node.y + node.height));
  const zoom = Math.max(0.01, Math.min(maximumZoom, (width - 40) / (right - left), (height - 40) / (bottom - top)));
  return { x: (width - (left + right) * zoom) / 2, y: (height - (top + bottom) * zoom) / 2, zoom };
}
