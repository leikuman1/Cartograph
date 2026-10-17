import {
  compareText, FILE_ROW_HEIGHT, PANEL_HEADER_HEIGHT, panelFiles,
  type FoldedGraph, type VisibleConnection,
} from "./graph";

export interface Point { x: number; y: number }
export interface Rectangle { x: number; y: number; width: number; height: number }
export interface RoutingNode extends Rectangle { id: string }
export interface ConnectionRoute { points: Point[]; path: string }

const clearance = 10;
const laneSpacing = 9;
const firstLane = 20;
const epsilon = 1e-7;

function rowOffset(folded: FoldedGraph, id: string, handle: string, pages: ReadonlyMap<string, number>, height: number) {
  if (!handle.includes(":")) return height / 2;
  const group = folded.groups.find(group => group.id === id);
  if (!group) throw new Error(`Missing route folder ${id}`);
  const rows = panelFiles(group, pages.get(id) ?? 0);
  const file = handle.slice(handle.indexOf(":") + 1);
  if (file === "overflow") return PANEL_HEADER_HEIGHT + rows.length * FILE_ROW_HEIGHT + 15;
  const index = rows.findIndex(row => row.path === file);
  if (index < 0) throw new Error(`Missing route row ${file}`);
  return PANEL_HEADER_HEIGHT + index * FILE_ROW_HEIGHT + FILE_ROW_HEIGHT / 2;
}

// Interval colouring gives overlapping internal imports separate outside lanes.
export function internalLanes(folded: FoldedGraph, connections: readonly VisibleConnection[], pages: ReadonlyMap<string, number>) {
  const assignments = new Map<string, number>();
  const widths = new Map<string, number>();
  for (const group of folded.groups) {
    const lanes: { start: number; end: number }[][] = [];
    for (const edge of [...connections].sort((a, b) => compareText(a.id, b.id))) {
      if (edge.source !== group.id || edge.target !== group.id) continue;
      const source = rowOffset(folded, group.id, edge.sourceHandle, pages, 0);
      const target = rowOffset(folded, group.id, edge.targetHandle, pages, 0);
      const interval = { start: Math.min(source, target) - 9, end: Math.max(source, target) + 9 };
      let lane = lanes.findIndex(used => used.every(other => interval.end < other.start || interval.start > other.end));
      if (lane < 0) { lane = lanes.length; lanes.push([]); }
      lanes[lane].push(interval);
      assignments.set(edge.id, lane);
    }
    widths.set(group.id, lanes.length ? firstLane + lanes.length * laneSpacing : 0);
  }
  return { assignments, widths };
}

export function segmentCrossesRectangle(a: Point, b: Point, rectangle: Rectangle) {
  const right = rectangle.x + rectangle.width;
  const bottom = rectangle.y + rectangle.height;
  if (a.x === b.x) return a.x > rectangle.x + epsilon && a.x < right - epsilon && Math.max(a.y, b.y) > rectangle.y + epsilon && Math.min(a.y, b.y) < bottom - epsilon;
  if (a.y === b.y) return a.y > rectangle.y + epsilon && a.y < bottom - epsilon && Math.max(a.x, b.x) > rectangle.x + epsilon && Math.min(a.x, b.x) < right - epsilon;
  throw new Error("Import routes must be orthogonal");
}

function simplify(points: readonly Point[]) {
  const result: Point[] = [];
  for (const point of points) {
    const previous = result.at(-1);
    if (previous?.x === point.x && previous.y === point.y) continue;
    const before = result.at(-2);
    if (before && previous && ((before.x === previous.x && previous.x === point.x) || (before.y === previous.y && previous.y === point.y))) result.pop();
    result.push(point);
  }
  return result;
}

export function routePath(points: readonly Point[]) {
  return points.map((point, index) => `${index ? "L" : "M"} ${point.x},${point.y}`).join(" ");
}

// Search only horizontal/vertical corridors outside all card rectangles.
function corridorRoute(start: Point, end: Point, obstacles: readonly Rectangle[], used: readonly [Point, Point][]) {
  const xs = [...new Set([start.x, end.x, ...obstacles.flatMap(rect => [rect.x, rect.x + rect.width])])].sort((a, b) => a - b);
  const ys = [...new Set([start.y, end.y, ...obstacles.flatMap(rect => [rect.y, rect.y + rect.height])])].sort((a, b) => a - b);
  const index = (x: number, y: number) => y * xs.length + x;
  const point = (id: number) => ({ x: xs[id % xs.length], y: ys[Math.floor(id / xs.length)] });
  const startId = index(xs.indexOf(start.x), ys.indexOf(start.y));
  const endId = index(xs.indexOf(end.x), ys.indexOf(end.y));
  const costs = new Map<number, number>([[startId, 0]]);
  const previous = new Map<number, number>();
  const pending = new Set([startId]);
  const blocked = (p: Point) => obstacles.some(rect => p.x > rect.x + epsilon && p.x < rect.x + rect.width - epsilon && p.y > rect.y + epsilon && p.y < rect.y + rect.height - epsilon);
  const heuristic = (id: number) => { const p = point(id); return Math.abs(p.x - end.x) + Math.abs(p.y - end.y); };
  while (pending.size) {
    let current = -1;
    let best = Infinity;
    for (const candidate of pending) {
      const cost = (costs.get(candidate) ?? Infinity) + heuristic(candidate);
      if (cost < best) { current = candidate; best = cost; }
    }
    if (current === endId) {
      const route: Point[] = [end];
      let id = endId;
      while (id !== startId) {
        const parent = previous.get(id);
        if (parent === undefined) throw new Error("Incomplete import route");
        id = parent;
        route.push(point(id));
      }
      return route.reverse();
    }
    pending.delete(current);
    const x = current % xs.length;
    const y = Math.floor(current / xs.length);
    const neighbours = [[x - 1, y], [x + 1, y], [x, y - 1], [x, y + 1]];
    for (const [nx, ny] of neighbours) {
      if (nx < 0 || ny < 0 || nx >= xs.length || ny >= ys.length) continue;
      const next = index(nx, ny);
      const a = point(current);
      const b = point(next);
      if (blocked(b) || obstacles.some(rect => segmentCrossesRectangle(a, b, rect))) continue;
      const distance = Math.abs(a.x - b.x) + Math.abs(a.y - b.y);
      // Discourage reusing complete rail segments so distinct dependencies remain traceable.
      const overlap = used.some(([c, d]) => a.x === b.x && c.x === d.x && a.x === c.x
        ? Math.min(Math.max(a.y, b.y), Math.max(c.y, d.y)) > Math.max(Math.min(a.y, b.y), Math.min(c.y, d.y))
        : a.y === b.y && c.y === d.y && a.y === c.y && Math.min(Math.max(a.x, b.x), Math.max(c.x, d.x)) > Math.max(Math.min(a.x, b.x), Math.min(c.x, d.x)));
      const parent = previous.get(current);
      const prior = parent === undefined ? null : point(parent);
      const turn = prior && (prior.x === a.x) !== (a.x === b.x) ? 12 : 0;
      const cost = (costs.get(current) ?? Infinity) + distance * (overlap ? 1.6 : 1) + turn;
      if (cost >= (costs.get(next) ?? Infinity)) continue;
      costs.set(next, cost);
      previous.set(next, current);
      pending.add(next);
    }
  }
  throw new Error(`No card-free import route from ${start.x},${start.y} to ${end.x},${end.y}`);
}

export function routeConnections(folded: FoldedGraph, nodes: readonly RoutingNode[], connections: readonly VisibleConnection[], pages: ReadonlyMap<string, number>) {
  const byId = new Map(nodes.map(node => [node.id, node]));
  const lanes = internalLanes(folded, connections, pages);
  const obstacles = nodes.map(node => ({ x: node.x - clearance, y: node.y - clearance, width: node.width + clearance * 2, height: node.height + clearance * 2 }));
  const routes = new Map<string, ConnectionRoute>();
  const ports = new Map<string, string[]>();
  for (const edge of connections) {
    for (const key of [JSON.stringify([edge.source, edge.sourceHandle]), JSON.stringify([edge.target, edge.targetHandle])]) {
      const members = ports.get(key) ?? [];
      members.push(edge.id);
      ports.set(key, members);
    }
  }
  const portOffset = (node: RoutingNode, handle: string, edge: VisibleConnection) => {
    const members = ports.get(JSON.stringify([node.id, handle])) ?? [];
    if (members.length <= 1) return 0;
    const spread = handle.includes(":") ? 7 : node.height / 2 - 14;
    return -spread + 2 * spread * members.indexOf(edge.id) / (members.length - 1);
  };
  const used: [Point, Point][] = [];
  for (const edge of connections) {
    const source = byId.get(edge.source);
    const target = byId.get(edge.target);
    if (!source || !target) throw new Error(`Missing route endpoint ${edge.id}`);
    const internal = source.id === target.id;
    const start = { x: source.x + source.width, y: source.y + rowOffset(folded, source.id, edge.sourceHandle, pages, source.height) + portOffset(source, edge.sourceHandle, edge) };
    const end = { x: internal ? target.x + target.width : target.x, y: target.y + rowOffset(folded, target.id, edge.targetHandle, pages, target.height) + portOffset(target, edge.targetHandle, edge) };
    let points: Point[];
    if (internal) {
      const rail = start.x + firstLane + (lanes.assignments.get(edge.id) ?? 0) * laneSpacing;
      // Same-card imports enter the target from the right, never through the card.
      points = [start, { x: rail, y: start.y }, { x: rail, y: end.y }, end];
      if (start.y === end.y) points = [start, { x: rail, y: start.y }, { x: rail, y: start.y - 9 }, { x: rail - 5, y: start.y - 9 }, { x: rail - 5, y: end.y }, end];
    } else {
      const lead = { x: start.x + clearance, y: start.y };
      const approach = { x: end.x - clearance, y: end.y };
      points = [start, ...corridorRoute(lead, approach, obstacles, used), end];
    }
    const simplified = simplify(points);
    for (let i = 1; i < simplified.length; i += 1) used.push([simplified[i - 1], simplified[i]]);
    routes.set(edge.id, { points: simplified, path: routePath(simplified) });
  }
  return routes;
}

export function routeBounds(nodes: readonly Rectangle[], routes: ReadonlyMap<string, ConnectionRoute>): Rectangle {
  const points = [...routes.values()].flatMap(route => route.points);
  const left = Math.min(...nodes.map(node => node.x), ...points.map(point => point.x));
  const top = Math.min(...nodes.map(node => node.y), ...points.map(point => point.y));
  const right = Math.max(...nodes.map(node => node.x + node.width), ...points.map(point => point.x));
  const bottom = Math.max(...nodes.map(node => node.y + node.height), ...points.map(point => point.y));
  return { x: left, y: top, width: right - left, height: bottom - top };
}
