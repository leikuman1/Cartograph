"use client";

import { Fragment, startTransition, useRef, useState, type ReactNode } from "react";
import { explain } from "@/app/(workspace)/analyses/[id]/explain-actions";
import RerunButton from "@/app/(workspace)/rerun-button";
import type { AiPanelContext, ExplanationDocument, ExplanationInline, ExplainTarget, Freshness } from "@/lib/ai/types";

type ExplanationPanelProps = {
  target: ExplainTarget | null;
  context: AiPanelContext;
  freshness: Freshness;
  onSelect: (path: string, focusInMap?: boolean) => void;
};

type ExplanationState = {
  document: ExplanationDocument | null;
  error: string | null;
  pending: boolean;
  cacheHit: boolean | null;
  freshness: Freshness | null;
  request: number;
};

function inlineContent(children: readonly ExplanationInline[], onSelect: ExplanationPanelProps["onSelect"]) {
  return children.map((inline, index) => {
    switch (inline.kind) {
      case "text": return <Fragment key={index}>{inline.text}</Fragment>;
      case "code": return <code key={index}>{inline.text}</code>;
      case "strong": return <strong key={index}>{inline.text}</strong>;
      case "file": return <button key={index} type="button" className="explanation-file" onClick={event => onSelect(inline.path, event.detail === 0)}>{inline.path}</button>;
    }
  });
}

function ExplanationContent({ document, onSelect }: { document: ExplanationDocument; onSelect: ExplanationPanelProps["onSelect"] }) {
  const blocks: ReactNode[] = [];
  for (let index = 0; index < document.blocks.length; index++) {
    const block = document.blocks[index];
    if (block.kind === "paragraph") {
      blocks.push(<p key={index}>{inlineContent(block.children, onSelect)}</p>);
      continue;
    }
    const first = index;
    const items: ReactNode[] = [];
    while (index < document.blocks.length && document.blocks[index].kind === "bullet") {
      items.push(<li key={index}>{inlineContent(document.blocks[index].children, onSelect)}</li>);
      index++;
    }
    index--;
    blocks.push(<ul key={first}>{items}</ul>);
  }
  return <div className="explanation-document">{blocks}</div>;
}

export default function ExplanationPanel({ target, context, freshness, onSelect }: ExplanationPanelProps) {
  const [results, setResults] = useState(() => new Map<string, ExplanationState>());
  const request = useRef(0);
  const key = target ? JSON.stringify([context.organizationId, context.analysisId, context.runId, context.model, target.kind, target.path]) : null;
  const result = key ? results.get(key) : undefined;
  const currentFreshness = result?.freshness ?? freshness;
  const notices = currentFreshness.status === "fresh" ? [] : [currentFreshness];
  // A newer explanation check may refine freshness, but cannot hide a stale page snapshot.
  if (freshness.status === "stale" && currentFreshness.status !== "stale") notices.push(freshness);

  function generate() {
    if (!target || !key) return;
    const requestId = ++request.current;
    const requestKey = key;
    const requestTarget = target;
    setResults(current => new Map(current).set(requestKey, {
      document: null, cacheHit: null, freshness: null,
      ...current.get(requestKey), pending: true, error: null, request: requestId,
    }));
    startTransition(async () => {
      try {
        const response = await explain(context, requestTarget);
        setResults(current => {
          const previous = current.get(requestKey);
          if (!previous || previous.request !== requestId) return current;
          return new Map(current).set(requestKey, {
            ...previous,
            document: response.document ?? previous.document,
            error: response.error ?? (response.document ? null : "No explanation was returned. Click Explain to retry."),
            pending: false,
            cacheHit: response.document ? response.cacheHit : previous.cacheHit,
            freshness: response.freshness,
          });
        });
      } catch (error) {
        setResults(current => {
          const previous = current.get(requestKey);
          if (!previous || previous.request !== requestId) return current;
          return new Map(current).set(requestKey, {
            ...previous, pending: false,
            error: error instanceof Error ? error.message : "The explanation request failed. Click Explain to retry.",
          });
        });
      }
    });
  }

  return <section className="explanation-panel" aria-label="Explanation">
    {target ? <div className="explanation-toolbar">
      <button type="button" className="control explanation-trigger" disabled={result?.pending} onClick={generate}>{result?.pending ? "Explaining…" : "Explain"}</button>
      <span className="explanation-status" role="status">{result?.pending ? "Generating explanation…" : result?.document ? result.cacheHit ? "Cache hit" : "Generated" : null}</span>
    </div> : <p className="explanation-note">Select a file or folded folder to explain.</p>}
    <p className="explanation-meta">Model: <code>{context.model ?? "Not configured"}</code></p>
    <p className="explanation-meta">{context.tracing ? "Tracing configured." : "Tracing not configured."}</p>
    {notices.length > 0 && <div className="explanation-freshness" role="status">
      {notices.map((notice, index) => <p key={index}><strong>{notice.status === "stale" ? "Analysis is out of date." : "Freshness unknown."}</strong> {notice.message}</p>)}
      <RerunButton organizationId={context.organizationId} analysisId={context.analysisId} />
    </div>}
    {result?.error && <p className="explanation-error" role="alert">{result.error}</p>}
    <div aria-busy={result?.pending ?? false}>
      {result?.document ? <ExplanationContent document={result.document} onSelect={onSelect} /> : target && !result?.pending && !result?.error ? <p className="explanation-note">{target.kind === "file" ? "Explain this file using its resolved dependencies and dependents." : "Explain what is in this folder and why other files depend on it."}</p> : null}
    </div>
  </section>;
}
