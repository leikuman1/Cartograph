"use client";

import { useId, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import type { FileNode, GraphEdge } from "@/lib/parser/contract";
import { categories, fileCategory, type FolderGroup, type Selection } from "@/lib/canvas/graph";
import { countFileCategories, importedFileCounts, type RepositoryDetails } from "@/lib/canvas/details";
import { TRAVERSAL_DEPTH, traverse, type EntryReason, type Insights, type TraversalDirection } from "@/lib/canvas/insights";
import CategoryMark from "./category-mark";
import InsightsPanel from "./insights-panel";

type DetailPanelProps = {
  repositoryName: string;
  details: RepositoryDetails;
  files: readonly FileNode[];
  edges: readonly GraphEdge[];
  edgeCount: number;
  selection: Selection;
  group: FolderGroup | undefined;
  entryExclusions: Record<EntryReason, number>;
  insights: Insights;
  hoveredFiles: ReadonlySet<string>;
  hoveredFolder: string | null;
  onSelect: (path: string) => void;
  onHover: (selection: Selection) => void;
  onClear: () => void;
};

function FileList({ title, files, counts, empty, scrollable = false, hoveredFiles, onSelect, onHover }: {
  title: string;
  files: readonly FileNode[];
  counts?: ReadonlyMap<string, number>;
  empty: string;
  scrollable?: boolean;
  hoveredFiles: ReadonlySet<string>;
  onSelect: (path: string) => void;
  onHover: (selection: Selection) => void;
}) {
  return <section className="detail-section">
    <h3>{title}<span className="detail-count">{files.length}</span></h3>
    {files.length === 0 ? <p className="detail-note">{empty}</p> : <ul className={`detail-file-list ${scrollable ? "detail-list-scroll" : ""}`} aria-label={title} tabIndex={scrollable ? 0 : undefined}>
      {files.map(file => <li key={file.path}>
        <button type="button" className={`detail-file-link ${hoveredFiles.has(file.path) ? "is-hovered" : ""}`}
          onClick={() => onSelect(file.path)} onMouseEnter={() => onHover({ kind: "file", path: file.path })} onMouseLeave={event => { if (!event.currentTarget.matches(":focus")) onHover(null); }}
          onFocus={() => onHover({ kind: "file", path: file.path })} onBlur={() => onHover(null)}>
          <CategoryMark path={file.path} /><span className="detail-path">{file.path}</span>
          {counts && <span className="detail-count" aria-label={`${counts.get(file.path) ?? 0} dependents`}>{counts.get(file.path) ?? 0}</span>}
        </button>
      </li>)}
    </ul>}
  </section>;
}

function Facts({ children }: { children: ReactNode }) {
  return <dl className="detail-facts">{children}</dl>;
}

export default function DetailPanel({ repositoryName, details, files, edges, edgeCount, selection, group, entryExclusions, insights, hoveredFiles, hoveredFolder, onSelect, onHover, onClear }: DetailPanelProps) {
  const [tab, setTab] = useState<"structure" | "explanation">("structure");
  const [traversal, setTraversal] = useState<TraversalDirection | null>(null);
  const id = useId();
  const structureTab = useRef<HTMLButtonElement>(null);
  const explanationTab = useRef<HTMLButtonElement>(null);
  const selected = selection?.kind === "file" ? details.byPath.get(selection.path) : undefined;
  const category = selected ? categories.find(category => category.id === fileCategory(selected.file.path)) : undefined;
  const members = group ? countFileCategories(group.files) : null;
  const counts = useMemo(() => new Map(importedFileCounts(files, edges).map(file => [file.path, file.importerCount])), [edges, files]);
  const walk = useMemo(() => selected && traversal ? traverse(files, edges, selected.file.path, traversal) : null, [edges, files, selected, traversal]);
  const excludedEntries = Object.values(entryExclusions).reduce((total, count) => total + count, 0);
  const listProps = { hoveredFiles, onSelect, onHover };
  const title = selected ? "File" : group ? "Folder" : "Repository";

  function moveTab(event: KeyboardEvent<HTMLDivElement>) {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const next = event.key === "Home" ? "structure" : event.key === "End" ? "explanation" : tab === "structure" ? "explanation" : "structure";
    setTab(next);
    (next === "structure" ? structureTab : explanationTab).current?.focus();
  }

  return <aside className="detail-column" aria-label="Details">
    <header className="detail-header"><h2>{title}</h2>{selection && <button type="button" onClick={onClear}>Clear selection</button>}</header>
    <div className="detail-tabs" role="tablist" aria-label="Details" onKeyDown={moveTab}>
      <button type="button" role="tab" ref={structureTab} id={`${id}-structure`} aria-selected={tab === "structure"} aria-controls={`${id}-content`} tabIndex={tab === "structure" ? 0 : -1} onClick={() => setTab("structure")}>Structure</button>
      <button type="button" role="tab" ref={explanationTab} id={`${id}-explanation`} aria-selected={tab === "explanation"} aria-controls={`${id}-content`} tabIndex={tab === "explanation" ? 0 : -1} onClick={() => setTab("explanation")}>Explanation</button>
    </div>
    <div className="detail-content" role="tabpanel" id={`${id}-content`} aria-labelledby={`${id}-${tab}`} tabIndex={0}>
      {selected ? <button type="button" className={`detail-selected-path detail-file-link ${hoveredFiles.has(selected.file.path) ? "is-hovered" : ""}`}
        onClick={() => onSelect(selected.file.path)} onMouseEnter={() => onHover({ kind: "file", path: selected.file.path })} onMouseLeave={event => { if (!event.currentTarget.matches(":focus")) onHover(null); }}
        onFocus={() => onHover({ kind: "file", path: selected.file.path })} onBlur={() => onHover(null)}>
        <CategoryMark path={selected.file.path} /><span className="detail-path">{selected.file.path}</span>
      </button> : group ? <p className={`detail-folder-path ${hoveredFolder === group.id ? "is-hovered" : ""}`}>{group.path}</p> : <p className="detail-repository-name">{repositoryName}</p>}
      {tab === "explanation" ? <section className="detail-empty"><h3>No explanation yet</h3><p>Explanations will appear here once generated. No explanation has been generated for this {title.toLowerCase()}.</p></section> : selected ? <>
        <Facts><dt>Kind</dt><dd>{category?.label}</dd><dt>Length</dt><dd>{selected.file.lineCount} lines</dd><dt>Dependencies</dt><dd>{selected.dependencies.length}</dd><dt>Dependents</dt><dd>{selected.dependents.length}</dd></Facts>
        {category?.id === "source" && <p className="detail-note">Source is the fallback kind; no test or declaration convention matched.</p>}
        <section className="detail-section">
          <div className="traversal-buttons" role="group" aria-label="Graph traversal">
            <button type="button" aria-pressed={traversal === "dependents"} onClick={() => setTraversal(traversal === "dependents" ? null : "dependents")}>Blast radius</button>
            <button type="button" aria-pressed={traversal === "dependencies"} onClick={() => setTraversal(traversal === "dependencies" ? null : "dependencies")}>Dependency chain</button>
          </div>
          {walk ? <div className="traversal-result" aria-live="polite">
            <p className="detail-note">{walk.direction === "dependents"
              ? `Files affected if this file changes, up to ${TRAVERSAL_DEPTH} steps.`
              : `Files this file reaches, up to ${TRAVERSAL_DEPTH} steps.`}</p>
            {walk.levels.map(level => <div key={level.depth} className="traversal-level">
              <h4>{walk.direction === "dependents" ? "Dependents" : "Dependencies"} · {level.depth} {level.depth === 1 ? "step" : "steps"}<span className="detail-count">{level.files.length}</span></h4>
              <ul className="detail-file-list">{level.files.map(file => <li key={file.path}>
                <button type="button" className={`detail-file-link ${hoveredFiles.has(file.path) ? "is-hovered" : ""}`}
                  onClick={() => onSelect(file.path)} onMouseEnter={() => onHover({ kind: "file", path: file.path })} onMouseLeave={event => { if (!event.currentTarget.matches(":focus")) onHover(null); }}
                  onFocus={() => onHover({ kind: "file", path: file.path })} onBlur={() => onHover(null)}>
                  <CategoryMark path={file.path} /><span className="detail-path">{file.path}</span>
                </button>
              </li>)}</ul>
            </div>)}
            {walk.files.length === 0 && <p className="detail-note">{walk.direction === "dependents" ? "No parsed file depends on this one." : "This file imports no parsed files."}</p>}
            <p className="detail-note">{walk.files.length} files at depth {TRAVERSAL_DEPTH} or less.</p>
          </div> : <p className="detail-note">Both walk the resolved imports, two steps out.</p>}
        </section>
        <FileList title="Dependencies" files={selected.dependencies} empty="No resolved file dependencies." {...listProps} />
        <FileList title="Dependents" files={selected.dependents} empty="No files import this file." {...listProps} />
      </> : group && members ? <>
        <Facts><dt>Files</dt><dd>{group.files.length}</dd></Facts>
        <section className="detail-section"><h3>File kinds</h3><ul className="detail-kind-list">{categories.filter(category => members[category.id] > 0).map(category => <li key={category.id}>
          <span className={`category-mark category-${category.id}`}>{category.code}</span><span>{category.label}</span><span className="detail-count">{members[category.id]}</span>
        </li>)}</ul></section>
        <FileList title="Files in this folder" files={group.files} empty="No parsed files." {...listProps} />
      </> : <>
        <Facts><dt>Framework</dt><dd>Not detected</dd><dt>Files</dt><dd>{details.byPath.size}</dd><dt>Import edges</dt><dd>{edgeCount}</dd><dt>Routes</dt><dd>Not analyzed</dd></Facts>
        <p className="detail-note">This preview uses the fallback adapter; framework detection and route extraction have not run.</p>
        <p className="detail-note">Counts below are distinct files connected by resolved imports.</p>
        <FileList title="Most depended on" files={details.mostImported.map(item => item.file)} counts={counts} empty="No files have dependents." scrollable {...listProps} />
        <p className="detail-note">Sorted by dependent count, then file path.</p>
        <FileList title="Start reading" files={details.entryPoints.map(item => item.file)} empty="Every file has at least one dependent." scrollable {...listProps} />
        <p className="detail-note">Files with no dependents, sorted by path.</p>
        <section className="detail-section"><h3>Unclassified by convention<span className="detail-count">{details.categoryCounts.source}</span></h3><p className="detail-note">These files use the fallback Source kind. Only tests and declarations are identified by current filename conventions.</p></section>
        <p className="detail-note">{excludedEntries} files with no importers are treated as framework or tool entry points and left out of the unimported insight ({entryExclusions.test} tests, {entryExclusions.config} configs, {entryExclusions["framework-entry"]} route files, {entryExclusions["ambient-declaration"]} declarations).</p>
        <InsightsPanel insights={insights} hoveredFiles={hoveredFiles} onSelect={onSelect} onHover={onHover} />
      </>}
    </div>
  </aside>;
}
