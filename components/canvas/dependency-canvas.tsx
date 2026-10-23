"use client";

import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  BaseEdge, Controls, Handle, Position, ReactFlow, ReactFlowProvider,
  useReactFlow, useStore, useUpdateNodeInternals, type Edge, type EdgeProps, type Node, type NodeProps,
} from "@xyflow/react";
import type { AnalysisResult, FileNode } from "@/lib/parser/contract";
import { categoriesForDisplay, categoryForFile, displayRoles, FRAMEWORK_LABELS, type CategoryDefinition, type DisplayRoleRecord } from "@/lib/frameworks/taxonomy";
import type { AiPanelContext, Freshness, ModelRoleRecord } from "@/lib/ai/types";
import { roleCandidates } from "@/lib/ai/candidates";
import { classify } from "@/app/(workspace)/analyses/[id]/explain-actions";
import {
  foldFolders, FILE_ROW_HEIGHT, PANEL_HEADER_HEIGHT,
  ROWS_PER_PANEL, panelFiles, selectionContext, shortestUniqueLabels, visibleConnections,
  type FolderGroup, type Selection, type VisibleConnection,
} from "@/lib/canvas/graph";
import { githubSourceUrl, repositoryDetails } from "@/lib/canvas/details";
import { buildInsights, entryExclusionCounts } from "@/lib/canvas/insights";
import { fitViewport, layoutFolders } from "@/lib/canvas/layout";
import CategoryMark, { CategorySymbol } from "./category-mark";
import DetailPanel from "./detail-panel";
import { routeBounds, routeConnections, type ConnectionRoute } from "@/lib/canvas/routing";
import "@xyflow/react/dist/style.css";
import "./canvas.css";
import CoverageBanner from "./coverage-banner";

type FolderData = {
  group: FolderGroup;
  label: string;
  labels: ReadonlyMap<string, string>;
  open: boolean;
  page: number;
  rows: FileNode[];
  dimmed: boolean;
  selection: Selection;
  related: ReadonlySet<string>;
  hovered: boolean;
  hoveredFiles: ReadonlySet<string>;
  category: CategoryDefinition | null;
  fileRoles: readonly DisplayRoleRecord[];
  matchingFiles: ReadonlySet<string> | null;
  onToggle: (id: string) => void;
  onSelect: (path: string) => void;
  onPage: (id: string, page: number) => void;
  onHover: (selection: Selection) => void;
};
type FolderNode = Node<FolderData, "folder">;
type ImportEdge = Edge<{ connection: VisibleConnection; route: ConnectionRoute; highlighted: boolean }, "import">;
type CanvasProps = {
  analysis: AnalysisResult;
  repositoryName: string;
  repositoryUrl: string | null;
  commitSha: string | null;
  aiContext: AiPanelContext;
  freshness: Freshness;
  initialModelRoles: ModelRoleRecord[];
};

function Ports({ top, suffix = "" }: { top: number | string; suffix?: string }) {
  return <>
    <Handle type="target" position={Position.Left} id={`in${suffix}`} style={{ top }} isConnectable={false} />
    <Handle type="source" position={Position.Right} id={`out${suffix}`} style={{ top }} isConnectable={false} />
    {suffix && <Handle type="target" position={Position.Right} id={`in-right${suffix}`} style={{ top }} isConnectable={false} />}
  </>;
}

function Folder({ data }: NodeProps<FolderNode>) {
  const { group, open, rows, page, selection, related } = data;
  const updateInternals = useUpdateNodeInternals();
  useLayoutEffect(() => {
    updateInternals(group.id);
  }, [group.id, open, page, data.labels, updateInternals]);
  const selected = selection?.kind === "folder" && selection.id === group.id;
  const hidden = group.files.length - rows.length;
  const pageCount = Math.ceil(group.files.length / ROWS_PER_PANEL);
  const title = `${group.path} · ${group.files.length} files · ${group.fanIn} external dependents · ${group.fanOut} external dependencies`;
  const matching = data.category && data.matchingFiles ? group.files.filter(file => data.matchingFiles?.has(file.path)).length : null;
  return <article className={`folder-object ${open ? "folder-open" : "folder-closed"} ${data.dimmed && !data.hovered ? "is-dimmed" : ""} ${selected ? "is-selected" : ""} ${data.hovered ? "is-hovered" : ""}`} aria-label={title}>
    {!open && <Ports top="50%" />}
    <button type="button" className="folder-heading nodrag" onClick={() => data.onToggle(group.id)} aria-expanded={open} title={`${title} · ${open ? "Collapse" : "Expand"}`}
      onMouseEnter={() => data.onHover({ kind: "folder", id: group.id })} onMouseLeave={event => { if (!event.currentTarget.matches(":focus")) data.onHover(null); }}
      onFocus={() => data.onHover({ kind: "folder", id: group.id })} onBlur={() => data.onHover(null)}>
      <span className="folder-name"><span aria-hidden="true" className="folder-chevron">{open ? "−" : "+"}</span>{data.label}</span>
      <span className="folder-stats"><span className={data.category ? "category-match" : undefined}>{data.category ? `${matching} ${data.category.label.toLowerCase()} of ${group.files.length}` : `${group.files.length} files`}</span><span title="Distinct files outside this folder that import it">in {group.fanIn}</span><span title="Distinct files outside this folder that it imports">out {group.fanOut}</span></span>
    </button>
    {open && <>
      <div className="folder-rows">
        {rows.map((file, index) => {
          const isSelected = selection?.kind === "file" && selection.path === file.path;
          const hovered = data.hoveredFiles.has(file.path);
          const outsideCategory = data.matchingFiles !== null && !data.matchingFiles.has(file.path);
          const dimmed = (selection !== null && !related.has(file.path) && !hovered) || (outsideCategory && !hovered);
          return <div key={file.path} className={`file-row-wrap ${dimmed ? "is-dimmed" : ""}`}>
            <Ports top={PANEL_HEADER_HEIGHT + index * FILE_ROW_HEIGHT + FILE_ROW_HEIGHT / 2} suffix={`:${file.path}`} />
            <button type="button" className={`file-row nodrag ${isSelected ? "is-selected" : ""} ${hovered ? "is-hovered" : ""}`} data-file-path={file.path} onClick={() => data.onSelect(file.path)} aria-pressed={isSelected} title={`${file.path} · ${file.fanIn} dependents · ${file.fanOut} dependencies`}
              onMouseEnter={() => data.onHover({ kind: "file", path: file.path })} onMouseLeave={event => { if (!event.currentTarget.matches(":focus")) data.onHover(null); }}
              onFocus={() => data.onHover({ kind: "file", path: file.path })} onBlur={() => data.onHover(null)}>
              <CategoryMark path={file.path} fileRoles={data.fileRoles} />
              <span className="file-name">{data.labels.get(file.path) ?? file.path}</span>
              <span className="file-fans"><span title={`${file.fanIn} files import this file`}>in {file.fanIn}</span> <span title={`This file imports ${file.fanOut} files`}>out {file.fanOut}</span></span>
            </button>
          </div>;
        })}
      </div>
      <div className="folder-footer">
        {hidden > 0 && <Ports top={PANEL_HEADER_HEIGHT + rows.length * FILE_ROW_HEIGHT + 15} suffix=":overflow" />}
        <span className={group.files.some(file => data.hoveredFiles.has(file.path) && !rows.some(row => row.path === file.path)) ? "overflow-highlight" : undefined} title="Edges for rows on other pages attach here">{hidden > 0 ? `+${hidden} files not shown` : "All files shown"}</span>
        {pageCount > 1 && <span className="folder-pagination nodrag">
          <button type="button" disabled={page === 0} onClick={() => data.onPage(group.id, page - 1)} aria-label={`Previous files in ${group.path}`}>‹</button>
          <span>{page + 1}/{pageCount}</span>
          <button type="button" disabled={page + 1 === pageCount} onClick={() => data.onPage(group.id, page + 1)} aria-label={`Next files in ${group.path}`}>›</button>
        </span>}
      </div>
    </>}
  </article>;
}

const BADGE_WIDTH = 20;
const BADGE_HEIGHT = 14;

function ImportConnection(props: EdgeProps<ImportEdge>) {
  const markerId = useId();
  // Edges live inside the zoomed viewport, so a fixed size in flow units shrinks
  // with the map. Counter-scaling keeps the count the same size on screen at any zoom.
  // Edges without a badge return a constant zoom, so a pan or zoom does not re-render them.
  const badgeZoom = props.data?.highlighted && props.data.connection.originals.length > 1;
  const zoom = useStore(store => (badgeZoom ? store.transform[2] : 1));
  const data = props.data;
  if (!data) return null;
  const originals = data.connection.originals;
  const title = originals.map(edge => `${edge.source} → ${edge.target}`).join("\n");
  const color = props.style?.stroke ?? "var(--edge)";
  const labelSegment = data.route.points.slice(1).map((end, index) => {
    const start = data.route.points[index];
    return { x: (start.x + end.x) / 2, y: (start.y + end.y) / 2, length: Math.abs(end.x - start.x) + Math.abs(end.y - start.y) };
  }).sort((a, b) => b.length - a.length)[0];
  return <g>
    <title>{title}</title>
    <defs><marker id={markerId} viewBox="0 0 10 10" refX="10" refY="5" markerWidth="9" markerHeight="6" markerUnits="userSpaceOnUse" orient="auto">
      <path d="M 0,0 L 10,5 L 0,10 Z" fill={color} />
    </marker></defs>
    {data.highlighted && <path d={data.route.path} fill="none" stroke="var(--background)" strokeWidth="5" pointerEvents="none" />}
    <BaseEdge id={props.id} path={data.route.path} markerEnd={`url(#${markerId})`} style={props.style} interactionWidth={18} />
    {data.highlighted && originals.length > 1 && labelSegment && <g className="import-count" transform={`translate(${labelSegment.x},${labelSegment.y}) scale(${1 / zoom})`}>
      <rect x={-BADGE_WIDTH / 2} y={-BADGE_HEIGHT / 2} width={BADGE_WIDTH} height={BADGE_HEIGHT} rx="3" />
      <text textAnchor="middle" dominantBaseline="central">{originals.length}</text>
    </g>}
  </g>;
}

const nodeTypes = { folder: Folder };
const edgeTypes = { import: ImportConnection };

function FileTable({ analysis, fileRoles, onSelect }: { analysis: AnalysisResult; fileRoles: readonly DisplayRoleRecord[]; onSelect: (path: string, focusInMap?: boolean) => void }) {
  const imports = useMemo(() => {
    const result = new Map<string, string[]>();
    for (const edge of analysis.edges) {
      const current = result.get(edge.source) ?? [];
      current.push(edge.target);
      result.set(edge.source, current);
    }
    return result;
  }, [analysis.edges]);
  return <div className="canvas-table-scroll"><table className="canvas-table">
    <caption className="sr-only">Parsed files and their resolved dependencies</caption>
    <thead><tr><th>File</th><th>Kind</th><th>In</th><th>Out</th><th>Resolved imports</th></tr></thead>
    <tbody>{analysis.files.map(file => <tr key={file.path}>
      {/* Keyboard activation reports detail 0; only then does the unmounted table need to hand focus to the map. */}
      <td><button type="button" onClick={event => onSelect(file.path, event.detail === 0)} className="table-file">{file.path}</button></td>
      <td><CategoryMark path={file.path} fileRoles={fileRoles} /> {categoryForFile(file.path, fileRoles).label}</td>
      <td>{file.fanIn}</td><td>{file.fanOut}</td>
      <td>{file.fanOut > 0 ? <details><summary>{file.fanOut} dependencies</summary>{imports.get(file.path)?.map(target => <p key={target} className="font-mono">{target}</p>)}</details> : "—"}</td>
    </tr>)}</tbody>
  </table></div>;
}

function RouteTable({ analysis, repositoryUrl, commitSha, onSelect }: Pick<CanvasProps, "analysis" | "repositoryUrl" | "commitSha"> & { onSelect: (path: string, focusInMap?: boolean) => void }) {
  return <div className="canvas-table-scroll">
    <p className="routes-note">Only routes whose HTTP method and full path were recovered are shown.</p>
    <table className="canvas-table routes-table">
      <caption className="sr-only">Recovered routes and their source code at the analyzed commit</caption>
      <thead><tr><th scope="col">Method</th><th scope="col">Path</th><th scope="col">Source</th></tr></thead>
      <tbody>{analysis.routes.length === 0 ? <tr><td colSpan={3} className="routes-empty">No routes were fully recovered. Only routes with a known HTTP method and complete path are listed.</td></tr> : analysis.routes.map(route => {
        const sourceUrl = githubSourceUrl(repositoryUrl, commitSha, route.file, route.line);
        return <tr key={JSON.stringify([route.file, route.line, route.method, route.path])}>
          <td><code>{route.method}</code></td>
          <td><button type="button" className="table-file" onClick={event => onSelect(route.file, event.detail === 0)} title={`Reveal ${route.file} in the map`}>{route.path}</button></td>
          <td><button type="button" className="table-file" onClick={event => onSelect(route.file, event.detail === 0)} title="Reveal source file in the map">{route.file}:{route.line}</button>
            {sourceUrl ? <a className="route-source-link" href={sourceUrl} target="_blank" rel="noreferrer" title={`View ${route.file}:${route.line} at commit ${commitSha}`}>View code ↗</a> : <span className="route-source-unavailable">Source link unavailable</span>}
          </td>
        </tr>;
      })}</tbody>
    </table>
  </div>;
}

function Canvas({ analysis, repositoryName, repositoryUrl, commitSha, aiContext, freshness, initialModelRoles }: CanvasProps) {
  const [modelRoles, setModelRoles] = useState(initialModelRoles);
  const [classifying, setClassifying] = useState(false);
  const [roleError, setRoleError] = useState<string | null>(null);
  const fileRoles = useMemo(() => displayRoles(analysis.fileRoles, modelRoles), [analysis.fileRoles, modelRoles]);
  const categories = categoriesForDisplay(analysis.framework, fileRoles);
  const unclassified = roleCandidates(analysis).filter(file => !modelRoles.some(role => role.file === file.path)).length;
  const folded = useMemo(() => foldFolders(analysis.files, analysis.edges), [analysis]);
  const details = useMemo(() => repositoryDetails(analysis.files, analysis.edges, fileRoles), [analysis, fileRoles]);
  const insights = useMemo(() => buildInsights(analysis.files, analysis.edges, analysis.framework, analysis.fileRoles, analysis.frameworkEntries), [analysis]);
  const entryExclusions = useMemo(() => entryExclusionCounts(analysis.files.filter(file => file.fanIn === 0), analysis.framework, analysis.fileRoles, analysis.frameworkEntries), [analysis.files, analysis.framework, analysis.fileRoles, analysis.frameworkEntries]);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set());
  const [pages, setPages] = useState<ReadonlyMap<string, number>>(() => new Map());
  const [selection, setSelection] = useState<Selection>(null);
  const [hover, setHover] = useState<Selection>(null);
  const [category, setCategory] = useState<CategoryDefinition | null>(null);
  const matchingFiles = useMemo(() => category ? new Set(analysis.files.filter(file => categoryForFile(file.path, fileRoles).id === category.id).map(file => file.path)) : null, [analysis.files, fileRoles, category]);
  const [view, setView] = useState<"map" | "table" | "routes">("map");
  const [dimensions, setDimensions] = useState({ width: 0, height: 0 });
  const [ready, setReady] = useState(false);
  const [zoom, setZoom] = useState(1);
  const frame = useRef<HTMLDivElement>(null);
  const instance = useReactFlow<FolderNode, ImportEdge>();
  const needsFit = useRef(true);
  const pendingFocus = useRef<string | null>(null);
  const connections = useMemo(() => visibleConnections(folded, analysis.edges, expanded, pages), [folded, analysis.edges, expanded, pages]);
  const positions = useMemo(() => layoutFolders(folded, expanded, pages, connections), [folded, expanded, pages, connections]);
  const routes = useMemo(() => routeConnections(folded, positions, connections, pages), [folded, positions, connections, pages]);
  const bounds = useMemo(() => [routeBounds(positions, routes)], [positions, routes]);
  const context = useMemo(() => selectionContext(folded, analysis.edges, selection), [folded, analysis.edges, selection]);
  const labels = useMemo(() => shortestUniqueLabels(folded.groups.flatMap(group => [group.path, ...(expanded.has(group.id) ? panelFiles(group, pages.get(group.id) ?? 0).map(file => file.path) : [])])), [folded, expanded, pages]);
  const hoveredFiles = useMemo(() => new Set(hover?.kind === "file" ? [hover.path] : hover?.kind === "folder" ? folded.groups.find(group => group.id === hover.id)?.files.map(file => file.path) : []), [folded, hover]);
  const hoveredFolder = hover?.kind === "file" ? folded.owner.get(hover.path) : hover?.kind === "folder" ? hover.id : null;
  const categoryCounts = details.categoryCounts;

  useEffect(() => {
    const element = frame.current;
    if (!element) return;
    const observer = new ResizeObserver(([entry]) => {
      needsFit.current = true;
      setDimensions({ width: entry.contentRect.width, height: entry.contentRect.height });
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!ready || view !== "map" || !dimensions.width || !dimensions.height || !needsFit.current) return;
    needsFit.current = false;
    // Explicit dimensions come from the newly derived layout, never stale RF measurements.
    const viewport = fitViewport(bounds, dimensions.width, dimensions.height, Math.min(1, instance.getZoom()));
    void instance.setViewport(viewport, { duration: 0 });
  }, [bounds, dimensions, instance, ready, view]);

  useEffect(() => {
    const path = pendingFocus.current;
    const element = frame.current;
    if (!path || view !== "map" || !ready || !element) return;
    const focusRow = () => {
      const row = element.querySelector<HTMLButtonElement>(`[data-file-path="${CSS.escape(path)}"]`);
      if (!row) return false;
      pendingFocus.current = null;
      row.focus();
      return true;
    };
    if (focusRow()) return;
    // React Flow can commit the expanded rows after this effect has run.
    const observer = new MutationObserver(() => {
      if (focusRow()) observer.disconnect();
    });
    observer.observe(element, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, [expanded, pages, ready, view]);

  const toggle = useCallback((id: string) => {
    needsFit.current = true;
    setExpanded(current => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
    setSelection({ kind: "folder", id });
  }, []);
  const selectFile = useCallback((path: string) => setSelection({ kind: "file", path }), []);
  const revealFile = useCallback((path: string, focusInMap = false) => {
    const id = folded.owner.get(path);
    const group = folded.groups.find(group => group.id === id);
    if (!id || !group) throw new Error(`Missing folder for ${path}`);
    const index = group.files.findIndex(file => file.path === path);
    if (index < 0) throw new Error(`Missing file ${path}`);
    needsFit.current = true;
    pendingFocus.current = focusInMap ? path : null;
    setPages(current => new Map(current).set(id, Math.floor(index / ROWS_PER_PANEL)));
    setExpanded(current => new Set(current).add(id));
    setHover(null);
    selectFile(path);
    setView("map");
  }, [folded, selectFile, setHover, setView]);
  const clearSelection = useCallback(() => {
    setSelection(null);
    setHover(null);
  }, [setHover]);
  const changePage = useCallback((id: string, page: number) => {
    needsFit.current = true;
    setPages(current => new Map(current).set(id, page));
  }, []);

  const nodes: FolderNode[] = positions.map(position => {
    const group = folded.groups.find(group => group.id === position.id);
    if (!group) throw new Error(`Missing folder ${position.id}`);
    const page = pages.get(group.id) ?? 0;
    return {
      id: group.id, type: "folder", zIndex: 3, position: { x: position.x, y: position.y }, width: position.width, height: position.height,
      // React Flow disables pointer events when dragging and built-in selection are off.
      style: { width: position.width, height: position.height, pointerEvents: "all" },
      data: { group, label: position.label, labels, open: expanded.has(group.id), page, rows: panelFiles(group, page),
        dimmed: (selection !== null && !context.visibleGroups.has(group.id)) || (matchingFiles !== null && !group.files.some(file => matchingFiles.has(file.path))),
        selection, related: context.visibleFiles, hovered: hoveredFolder === group.id, hoveredFiles, category, fileRoles, matchingFiles,
        onToggle: toggle, onSelect: selectFile, onPage: changePage, onHover: setHover },
    };
  });
  const edges: ImportEdge[] = connections.map(connection => {
    const incoming = selection !== null && connection.originals.some(edge => context.selectedFiles.has(edge.target));
    const outgoing = selection !== null && connection.originals.some(edge => context.selectedFiles.has(edge.source));
    const highlighted = incoming || outgoing;
    const color = incoming && outgoing ? "var(--accent)" : incoming ? "var(--incoming)" : outgoing ? "var(--outgoing)" : "var(--edge)";
    const route = routes.get(connection.id);
    if (!route) throw new Error(`Missing import route ${connection.id}`);
    return {
      id: connection.id, source: connection.source, target: connection.target,
      sourceHandle: connection.sourceHandle, targetHandle: connection.targetHandle, type: "import",
      data: { connection, route, highlighted }, zIndex: highlighted ? 2 : 0,
      style: { stroke: color, strokeWidth: highlighted ? 1.8 : 1.1, opacity: selection === null ? 0.65 : highlighted ? 1 : 0.09, pointerEvents: "visibleStroke" },
    };
  });
  const selectedLabel = selection?.kind === "file" ? selection.path : selection?.kind === "folder" ? folded.groups.find(group => group.id === selection.id)?.path : null;
  return <div className="canvas-workspace" onKeyDown={event => { if (event.key === "Escape") clearSelection(); }}>
    <CoverageBanner coverage={analysis.coverage} />
    <div className="canvas-columns">
    <aside className="category-sidebar" aria-label="File categories">
      <h2>File kinds</h2>
      {categories.map(item => <button key={item.id} type="button" className="category-item" aria-pressed={category?.id === item.id}
        title={category?.id === item.id ? `Stop filtering by ${item.label}` : `Dim files that are not ${item.label}: ${item.description}`}
        onClick={() => setCategory(category?.id === item.id ? null : item)}>
        <CategorySymbol category={item} /><span>{item.label}</span><span className="category-count">{categoryCounts.get(item.id) ?? 0}</span>
      </button>)}
      {unclassified > 0 && <div className="sidebar-section"><p>{unclassified} files without a role</p><button type="button" className="control" disabled={classifying} onClick={async () => {
        setClassifying(true);
        setRoleError(null);
        try {
          const result = await classify(aiContext);
          if (result.error) setRoleError(result.error);
          else setModelRoles(result.roles);
        } catch { setRoleError("File roles could not be assigned. Try again."); }
        finally { setClassifying(false); }
      }}>{classifying ? "Assigning roles…" : "Assign AI roles"}</button>{roleError && <p role="alert">{roleError}</p>}</div>}
      <p className="sidebar-filter-note">{category ? `Dimming files that are not ${category.label.toLowerCase()}. Click again to clear.` : "Click a kind to dim the rest."}</p>
      <div className="sidebar-section"><h2>Reading the map</h2><p>Height = dependents</p><p>Width = label length</p><p>In / out = distinct files</p><p>Arrow → dependency</p>
        <p><span className="direction-mark incoming" /> Incoming</p><p><span className="direction-mark outgoing" /> Outgoing</p>
      </div>
      <div className="sidebar-bottom"><p>{analysis.files.length} parsed files</p><p>{analysis.edges.length} resolved edges</p><p>{analysis.coverage.files.skipped} files skipped</p><p>{analysis.coverage.imports.unresolved} unresolved imports</p>
        <details><summary>Coverage details</summary><p>{analysis.coverage.imports.external} external imports</p><p>{analysis.coverage.imports.excluded} excluded imports</p><p>{analysis.coverage.files.excludedDirectories.length} excluded directories</p>
          {analysis.imports.filter(occurrence => occurrence.resolution.status === "unresolved").map(occurrence => <p key={`${occurrence.source}:${occurrence.line}`} className="coverage-path" title={"reason" in occurrence.resolution ? occurrence.resolution.reason : undefined}>{occurrence.source}:{occurrence.line}<br />{occurrence.specifier}</p>)}
          <p>Skipped files: {Array.from(new Set(analysis.coverage.files.skippedFiles.map(file => file.reason))).join(", ")}</p>
        </details>
      </div>
    </aside>
    <section className="map-column" aria-label="Dependency map">
      <div className="map-toolbar">
        <div className="view-switch" role="group" aria-label="View"><button type="button" aria-pressed={view === "map"} onClick={() => { needsFit.current = true; setView("map"); }}>Map</button><button type="button" aria-pressed={view === "table"} onClick={() => setView("table")}>Files</button><button type="button" aria-pressed={view === "routes"} onClick={() => setView("routes")}>Routes</button></div>
        <span>{FRAMEWORK_LABELS[analysis.framework]} · {view === "routes" ? `${analysis.routes.length} routes` : `${folded.groups.length} folders · threshold ${folded.threshold}`}</span>
        <button type="button" className="control map-fit" disabled={view !== "map"} onClick={() => { void instance.setViewport(fitViewport(bounds, dimensions.width, dimensions.height, 1), { duration: 0 }); }}>Fit map</button>
      </div>
      <div className="map-frame" ref={frame}>
        <div className="flow-layer" style={{ visibility: view === "map" ? "visible" : "hidden" }} aria-hidden={view !== "map"}>
          <ReactFlow<FolderNode, ImportEdge> nodes={nodes} edges={edges} nodeTypes={nodeTypes} edgeTypes={edgeTypes}
            onInit={() => setReady(true)} onMove={(_, viewport) => setZoom(viewport.zoom)}
            nodesDraggable={false} nodesConnectable={false} nodesFocusable={false} edgesFocusable={false}
            elementsSelectable={false} edgesReconnectable={false} deleteKeyCode={null} zoomOnDoubleClick={false}
            minZoom={0.01} maxZoom={2} onPaneClick={clearSelection} colorMode="system"
            aria-label="Repository imports; click a folder to expand, a file to select, background to clear">
            <Controls showInteractive={false} showFitView={false} />
          </ReactFlow>
        </div>
        {view === "table" && <FileTable analysis={analysis} fileRoles={fileRoles} onSelect={revealFile} />}
        {view === "routes" && <RouteTable analysis={analysis} repositoryUrl={repositoryUrl} commitSha={commitSha} onSelect={revealFile} />}
      </div>
      <footer className="map-status"><span title={selectedLabel ?? undefined}>{selectedLabel ?? "Click a folder to expand · select a file to trace imports"}</span>{selection && <button type="button" onClick={clearSelection}>Clear selection</button>}<span>{Math.round(zoom * 100)}%</span></footer>
    </section>
    <DetailPanel aiContext={aiContext} freshness={freshness} modelRoles={modelRoles} repositoryName={repositoryName} framework={analysis.framework} fileRoles={fileRoles} routeCount={analysis.routes.length} details={details} files={analysis.files} edges={analysis.edges}
      edgeCount={analysis.edges.length} selection={selection} entryExclusions={entryExclusions} insights={insights}
      group={selection?.kind === "folder" ? folded.groups.find(group => group.id === selection.id) : undefined}
      hoveredFiles={hoveredFiles} hoveredFolder={hoveredFolder ?? null} onSelect={revealFile} onHover={setHover} onClear={clearSelection} />
    </div>
  </div>;
}

export default function DependencyCanvas(props: CanvasProps) {
  return <div className="analysis-shell">
    <ReactFlowProvider><Canvas {...props} /></ReactFlowProvider>
  </div>;
}
