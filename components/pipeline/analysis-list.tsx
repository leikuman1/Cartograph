"use client";

import Link from "next/link";
import { useAnalysisProgress } from "./use-analysis-progress";
import { ProgressBadge, useNow } from "./progress";
import { isStale, type AnalysisSummary } from "@/lib/pipeline/types";

function formatUtc(value: string) {
  return new Date(value).toISOString().slice(0, 19).replace("T", " ");
}

export default function AnalysisList({
  organizationId, initial, hasMore,
}: {
  organizationId: string;
  initial: AnalysisSummary[];
  hasMore: boolean;
}) {
  const { summaries, error, connected } = useAnalysisProgress(organizationId, initial);
  const analyses = initial.map(analysis => summaries.get(analysis.id) ?? analysis);
  const now = useNow(analyses.some(analysis => analysis.status === "running" || analysis.status === "queued"));

  return <section className="mt-3" aria-label="Analysis tasks">
    {error && <p role="alert" className="mb-2 text-xs text-muted">{error}</p>}
    <div className="overflow-x-auto">
      <table className="w-full text-left text-xs">
        <caption className="sr-only">Analysis tasks for this organization{connected ? "" : "; live updates disconnected"}</caption>
        <thead className="border-b border-border text-muted">
          <tr>
            <th scope="col" className="py-2 pr-4 font-medium">Project</th>
            <th scope="col" className="px-4 py-2 font-medium">Status</th>
            <th scope="col" className="px-4 py-2 font-medium">Current stage</th>
            <th scope="col" className="whitespace-nowrap px-4 py-2 font-medium">Created (UTC)</th>
            <th scope="col" className="whitespace-nowrap py-2 pl-4 font-medium">Completed (UTC)</th>
          </tr>
        </thead>
        <tbody>
          {analyses.map(analysis => {
            const stale = isStale(analysis, now);
            return <tr key={analysis.id} className="border-b border-border align-top">
              <td className="py-3 pr-4">
                <Link href={`/analyses/${analysis.id}`} className="font-medium hover:text-accent">
                  {analysis.project?.name ?? "Project unavailable"}
                </Link>
                {analysis.is_seed && <p className="mt-1 text-muted">Sample data</p>}
                {analysis.project && <p className="mt-1 break-all font-mono text-muted">{analysis.project.repository_url}</p>}
              </td>
              <td className="whitespace-nowrap px-4 py-3">
                <ProgressBadge analysis={analysis} now={now} />
              </td>
              <td className="px-4 py-3">
                <p>{analysis.stage_message || (analysis.status === "completed" ? "Stored the dependency map" : "—")}</p>
                {analysis.status === "failed" && analysis.error_message && (
                  <p className="mt-1 text-muted">{analysis.error_message}</p>
                )}
                {stale && <p className="mt-1 text-muted">No update for over five minutes. The run may have been interrupted.</p>}
              </td>
              <td className="whitespace-nowrap px-4 py-3 font-mono text-muted">
                <time dateTime={analysis.created_at}>{formatUtc(analysis.created_at)}</time>
              </td>
              <td className="whitespace-nowrap py-3 pl-4 font-mono text-muted">
                {analysis.completed_at
                  ? <time dateTime={analysis.completed_at}>{formatUtc(analysis.completed_at)}</time>
                  : <span aria-label="Not completed">—</span>}
              </td>
            </tr>;
          })}
        </tbody>
      </table>
    </div>
    {hasMore && <p className="mt-3 text-xs text-muted">Showing the latest 50 analyses.</p>}
  </section>;
}
