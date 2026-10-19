"use client";

import { useState } from "react";
import type { FileNode } from "@/lib/parser/contract";
import type { Selection } from "@/lib/canvas/graph";
import { INSIGHT_DESCRIPTIONS, insightCount, type Insights } from "@/lib/canvas/insights";
import CategoryMark from "./category-mark";

type InsightsPanelProps = {
  insights: Insights;
  hoveredFiles: ReadonlySet<string>;
  onSelect: (path: string) => void;
  onHover: (selection: Selection) => void;
};

function FileEntries({ files, suffix, hoveredFiles, onSelect, onHover }: {
  files: readonly FileNode[];
  suffix?: (file: FileNode) => string;
  hoveredFiles: ReadonlySet<string>;
  onSelect: (path: string) => void;
  onHover: (selection: Selection) => void;
}) {
  return <ul className="detail-file-list">{files.map(file => <li key={file.path}>
    <button type="button" className={`detail-file-link ${hoveredFiles.has(file.path) ? "is-hovered" : ""}`}
      onClick={() => onSelect(file.path)} onMouseEnter={() => onHover({ kind: "file", path: file.path })} onMouseLeave={event => { if (!event.currentTarget.matches(":focus")) onHover(null); }}
      onFocus={() => onHover({ kind: "file", path: file.path })} onBlur={() => onHover(null)}>
      <CategoryMark path={file.path} /><span className="detail-path">{file.path}</span>
      {suffix && <span className="detail-count">{suffix(file)}</span>}
    </button>
  </li>)}</ul>;
}

export default function InsightsPanel({ insights, hoveredFiles, onSelect, onHover }: InsightsPanelProps) {
  const [open, setOpen] = useState(false);
  const total = insightCount(insights);
  const listProps = { hoveredFiles, onSelect, onHover };
  return <section className="insights-panel" aria-label="Insights">
    <button type="button" className="insights-toggle" aria-expanded={open} onClick={() => setOpen(!open)}>
      <span aria-hidden="true">{open ? "−" : "+"}</span>Insights<span className="detail-count">{total}</span>
    </button>
    {open && <div className="insights-body">
      <section className="detail-section">
        <h3>No file imports these<span className="detail-count">{insights.unimported.length}</span></h3>
        <p className="detail-note">{INSIGHT_DESCRIPTIONS.unimported}</p>
        {insights.unimported.length > 0 ? <FileEntries files={insights.unimported} {...listProps} /> : <p className="detail-note">None.</p>}
      </section>
      <section className="detail-section">
        <h3>Imported widely<span className="detail-count">{insights.widelyImported.length}</span></h3>
        <p className="detail-note">{INSIGHT_DESCRIPTIONS.widelyImported}</p>
        {insights.widelyImported.length > 0 ? <FileEntries files={insights.widelyImported} suffix={file => `${file.fanIn}`} {...listProps} /> : <p className="detail-note">None.</p>}
      </section>
      <section className="detail-section">
        <h3>Import cycles<span className="detail-count">{insights.cycles.length}</span></h3>
        <p className="detail-note">{INSIGHT_DESCRIPTIONS.cycles}</p>
        {insights.cycles.length === 0 ? <p className="detail-note">None.</p> : <ul className="cycle-list">{insights.cycles.map(cycle => <li key={cycle.join("→")}>
          <p className="cycle-path">{cycle.map((path, index) => <span key={`${path}:${index}`}>
            {index > 0 && <span aria-hidden="true"> → </span>}
            <button type="button" className={`cycle-file ${hoveredFiles.has(path) ? "is-hovered" : ""}`}
              onClick={() => onSelect(path)} onMouseEnter={() => onHover({ kind: "file", path })} onMouseLeave={event => { if (!event.currentTarget.matches(":focus")) onHover(null); }}
              onFocus={() => onHover({ kind: "file", path })} onBlur={() => onHover(null)}>{path}</button>
          </span>)}</p>
        </li>)}</ul>}
      </section>
      <section className="detail-section">
        <h3>Long files<span className="detail-count">{insights.longFiles.length}</span></h3>
        <p className="detail-note">{INSIGHT_DESCRIPTIONS.longFiles}</p>
        {insights.longFiles.length > 0 ? <FileEntries files={insights.longFiles} suffix={file => `${file.lineCount}`} {...listProps} /> : <p className="detail-note">None.</p>}
      </section>
    </div>}
  </section>;
}
