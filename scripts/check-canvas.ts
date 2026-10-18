import assert from "node:assert/strict";
import { analysis } from "../lib/canvas/fixture";
import { foldFolders, panelFiles, ROWS_PER_PANEL, selectionContext, shortestUniqueLabels, visibleConnections } from "../lib/canvas/graph";
import { routeBounds, routeConnections, segmentCrossesRectangle } from "../lib/canvas/routing";
import { fitViewport, layoutFolders } from "../lib/canvas/layout";
import { validateAnalysisResult } from "../lib/parser/serialization";

validateAnalysisResult(analysis);
const folded = foldFolders(analysis.files, analysis.edges);
const closed = new Set<string>();
const pages = new Map<string, number>();
const connections = visibleConnections(folded, analysis.edges, closed, pages);
const nodes = layoutFolders(folded, closed, pages, connections);
const ids = new Set(nodes.map(node => node.id));
const invalid = connections.filter(edge => !ids.has(edge.source) || !ids.has(edge.target));
const singleton = folded.groups.filter(group => group.files.length < 2);
assert(folded.groups.length <= 26);
assert.equal(singleton.length, 0);
assert.equal(invalid.length, 0);
assert.equal(folded.groups.reduce((total, group) => total + group.files.length, 0), analysis.files.length);
assert.equal(folded.owner.size, analysis.files.length);
assert.deepEqual(foldFolders([...analysis.files].reverse(), [...analysis.edges].reverse()), folded);
assert.deepEqual(layoutFolders(folded, closed, pages, connections), nodes);
for (const group of folded.groups) {
  const expanded = new Set([group.id]);
  for (let page = 0; page < Math.ceil(group.files.length / ROWS_PER_PANEL); page += 1) {
    const pageMap = new Map([[group.id, page]]);
    const rendered = new Set(panelFiles(group, page).map(file => file.path));
    const expandedEdges = visibleConnections(folded, analysis.edges, expanded, pageMap);
    for (const edge of expandedEdges) {
      assert(ids.has(edge.source) && ids.has(edge.target));
      const endpoint = (id: string, handle: string, direction: string) => {
        if (id !== group.id) assert.equal(handle, direction);
        else assert(handle === `${direction}:overflow` || rendered.has(handle.slice(direction.length + 1)));
      };
      endpoint(edge.source, edge.sourceHandle, "out");
      endpoint(edge.target, edge.targetHandle, edge.source === edge.target ? "in-right" : "in");
    }
    const visiblePaths = folded.groups.map(item => item.path).concat([...rendered]);
    const labels = shortestUniqueLabels(visiblePaths);
    assert.equal(new Set(labels.values()).size, labels.size);
    const positions = layoutFolders(folded, expanded, pageMap, expandedEdges);
    const routed = routeConnections(folded, positions, expandedEdges, pageMap);
    for (const edge of expandedEdges) {
      const route = routed.get(edge.id);
      assert(route, `Missing route ${edge.id}`);
      for (let i = 1; i < route.points.length; i += 1) {
        for (const card of positions) assert(!segmentCrossesRectangle(route.points[i - 1], route.points[i], card), `Route crosses ${card.id}: ${edge.id}`);
      }
    }
    const previous = fitViewport(nodes, 1100, 760, 1);
    const next = fitViewport([routeBounds(positions, routed)], 1100, 760, previous.zoom);
    assert(next.zoom <= previous.zoom);
    for (const node of positions) {
      assert(node.x * next.zoom + next.x >= -0.001);
      assert(node.y * next.zoom + next.y >= -0.001);
      assert((node.x + node.width) * next.zoom + next.x <= 1100.001);
      assert((node.y + node.height) * next.zoom + next.y <= 760.001);
    }
  }
}
const clientPath = "src/client/client.ts";
const clientFolder = "folder:src/client";
const clientSelection = selectionContext(folded, analysis.edges, { kind: "file", path: clientPath });
assert.equal(clientSelection.incoming.size, 3);
assert.equal(clientSelection.outgoing.size, 6);
const clientExpanded = new Set([clientFolder]);
const clientConnections = visibleConnections(folded, analysis.edges, clientExpanded, pages);
const clientNodes = layoutFolders(folded, clientExpanded, pages, clientConnections);
const clientRoutes = routeConnections(folded, clientNodes, clientConnections, pages);
assert.deepEqual(routeConnections(folded, clientNodes, clientConnections, pages), clientRoutes);
const incident = clientConnections.filter(edge => edge.originals.some(original => original.source === clientPath || original.target === clientPath));
assert.equal(incident.length, 7);
assert.equal(incident.flatMap(edge => edge.originals.filter(original => original.source === clientPath || original.target === clientPath)).length, 9);
const clientCard = clientNodes.find(node => node.id === clientFolder);
assert(clientCard);
const incomingTips = new Set<string>();
for (const edge of clientConnections) {
  const route = clientRoutes.get(edge.id);
  assert(route && route.points.length >= 2);
  for (let i = 1; i < route.points.length; i += 1) {
    for (const card of clientNodes) assert(!segmentCrossesRectangle(route.points[i - 1], route.points[i], card), `Route crosses ${card.id}: ${edge.id}`);
  }
  const last = route.points.at(-1);
  const previous = route.points.at(-2);
  assert(last && previous);
  assert.equal(last.y, previous.y, "Arrow must arrive horizontally at the file row");
  if (edge.source === edge.target) assert(previous.x > last.x, "Internal arrow must turn left into the target row");
  else assert(previous.x < last.x, "External arrow must turn right into the target row");
  if (edge.originals.some(original => original.target === clientPath)) incomingTips.add(`${last.x},${last.y}`);
}
assert.equal(incomingTips.size, 3, "Three incoming arrows must not overlap at the target");
const routingBounds = routeBounds(clientNodes, clientRoutes);
const routeViewport = fitViewport([routingBounds], 1100, 760, 1);
for (const route of clientRoutes.values()) for (const point of route.points) {
  assert(point.x * routeViewport.zoom + routeViewport.x >= 0 && point.x * routeViewport.zoom + routeViewport.x <= 1100);
  assert(point.y * routeViewport.zoom + routeViewport.y >= 0 && point.y * routeViewport.zoom + routeViewport.y <= 760);
}
console.log(`client.ts: ${clientSelection.incoming.size} incoming + ${clientSelection.outgoing.size} outgoing originals; ${incident.length} visible connections; ${incomingTips.size} distinct incoming tips`);
console.log(`Card-free orthogonal routes, target turns, aggregation preservation and route viewport: passed`);
console.log(`Parsed files: ${analysis.files.length}; raw edges: ${analysis.edges.length}`);
console.log(`Fold threshold: ${folded.threshold}; nodes: ${nodes.length}; files/node: ${(analysis.files.length / nodes.length).toFixed(2)}`);
console.log(`Files/node min-max: ${Math.min(...folded.groups.map(group => group.files.length))}-${Math.max(...folded.groups.map(group => group.files.length))}`);
console.log(`Single-file nodes: ${singleton.length}; visible edges: ${connections.length}; missing endpoints: ${invalid.length}`);
console.log(`Determinism, all expansion pages/handles, unique labels, viewport containment and no-zoom-in: passed`);
console.log(`Layout bounds: ${Math.ceil(Math.max(...nodes.map(node => node.x + node.width)))} × ${Math.ceil(Math.max(...nodes.map(node => node.y + node.height)))}`);
console.log(`Viewport at 1100×760: ${JSON.stringify(fitViewport(nodes, 1100, 760, 1))}`);
for (const group of folded.groups) console.log(`${group.path}: ${group.files.length} files; fan-in ${group.fanIn}; fan-out ${group.fanOut}`);
