"use client";

import { useEffect, useMemo, useRef } from "react";
import { useRouter } from "next/navigation";
import RerunButton from "@/app/(workspace)/rerun-button";
import { AnalysisProgress, stageLabels, useNow } from "./progress";
import { useAnalysisProgress } from "./use-analysis-progress";
import { isStale, type AnalysisSummary } from "@/lib/pipeline/types";

export default function AnalysisDetail({
  organizationId, initial, graphRunId, children,
}: {
  organizationId: string;
  initial: AnalysisSummary;
  graphRunId: string | null;
  children: React.ReactNode;
}) {
  const router = useRouter();
  const initialRows = useMemo(() => [initial], [initial]);
  const { summaries, error, connected } = useAnalysisProgress(organizationId, initialRows);
  const analysis = summaries.get(initial.id) ?? initial;
  const graphReady = graphRunId !== null && graphRunId === analysis.run_id;
  const refreshed = useRef<string | null>(null);
  const terminal = analysis.status === "completed" || analysis.status === "failed";
  const now = useNow(!terminal);
  const stale = isStale(analysis, now);
  const canRerun = terminal || stale;

  useEffect(() => {
    // Both a broadcast and the post-subscribe snapshot can reveal completion.
    // Refresh once for that terminal state to load the graph and commit metadata.
    if (!terminal) return;
    if (analysis.updated_at === initial.updated_at && analysis.run_id === initial.run_id
      && analysis.status === initial.status && (analysis.status !== "completed" || graphReady)) return;
    const key = `${analysis.run_id}:${analysis.updated_at}:${analysis.status}`;
    if (refreshed.current === key) return;
    refreshed.current = key;
    router.refresh();
  }, [analysis, initial, graphReady, terminal, router]);

  return <div className="flex min-h-0 flex-1 flex-col">
    <header className="border-b border-border px-4 py-3">
      <div className="flex flex-wrap items-baseline gap-x-4 gap-y-2">
        <h1 className="text-sm font-semibold">{analysis.project?.name ?? "Analysis"}</h1>
        {analysis.project && <p className="break-all font-mono text-xs text-muted">{analysis.project.repository_url}</p>}
        {analysis.commit_sha && analysis.project && <a
          className="font-mono text-xs text-accent"
          href={`${analysis.project.repository_url}/commit/${analysis.commit_sha}`}
          target="_blank" rel="noreferrer"
        >commit {analysis.commit_sha.slice(0, 7)}</a>}
        {analysis.status === "running" && analysis.stage && <span className="text-xs text-muted" aria-live="polite">
          {stageLabels[analysis.stage]} · {analysis.stage_message}
        </span>}
        <div className="ml-auto flex items-center gap-3">
          <span className="text-xs text-muted">{connected ? "Live" : "Not live"}</span>
          {canRerun && <RerunButton organizationId={organizationId} analysisId={analysis.id} />}
        </div>
      </div>
      {error && <p role="alert" className="mt-2 text-xs text-muted">{error}</p>}
    </header>
    {analysis.status === "completed"
      ? graphReady ? children : <p role="status" className="p-4 text-xs text-muted">Loading stored map…</p>
      : <div className="p-4"><AnalysisProgress analysis={analysis} /></div>}
  </div>;
}
