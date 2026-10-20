"use client";

import { useEffect, useState } from "react";
import {
  isStale, PIPELINE_STAGES, type AnalysisSummary, type PipelineStage,
} from "@/lib/pipeline/types";

const stageLabels: Record<PipelineStage, string> = {
  fetch: "Fetch",
  select: "Select",
  parse: "Parse",
  store: "Store",
};

function stageIndex(stage: PipelineStage | null) {
  return stage === null ? -1 : PIPELINE_STAGES.indexOf(stage);
}

// The clock is local; staleness is derived from the last recorded update and
// never causes a database read.
export function useNow(active: boolean) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const timer = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(timer);
  }, [active]);
  return now;
}

export function StageList({ analysis, now }: { analysis: AnalysisSummary; now: number }) {
  const current = stageIndex(analysis.stage);
  const stale = isStale(analysis, now);
  const failed = analysis.status === "failed";
  return <ol className="stage-list" aria-label="Analysis stages">
    {PIPELINE_STAGES.map((stage, index) => {
      const isFailed = failed && analysis.failed_stage === stage;
      const state = isFailed ? "failed"
        : analysis.status === "completed" && index <= current ? "done"
        : index < current ? "done"
        : index === current && analysis.status === "running" && !stale ? "active"
        : index === current && stale ? "stale"
        : "pending";
      return <li key={stage} className={`stage stage-${state}`}>
        <span className="stage-marker" aria-hidden="true">{state === "done" ? "✓" : state === "failed" ? "!" : index + 1}</span>
        <span className="stage-name">{stageLabels[stage]}</span>
        {index === current && <span className="stage-message">{isFailed ? analysis.error_message : analysis.stage_message}</span>}
        {index === current && stale && <span className="stage-message">No update for over 5 minutes; this run may have been interrupted.</span>}
      </li>;
    })}
  </ol>;
}

export function AnalysisProgress({ analysis }: { analysis: AnalysisSummary }) {
  const running = analysis.status === "queued" || analysis.status === "running";
  const now = useNow(running);
  const stale = isStale(analysis, now);
  return <section className="analysis-progress" aria-labelledby="progress-title" aria-live="polite">
    <h2 id="progress-title" className="text-sm font-semibold">
      {analysis.status === "failed" ? "Analysis failed"
        : analysis.status === "completed" ? "Analysis complete"
        : stale ? "Analysis stale"
        : "Analysis running"}
    </h2>
    <StageList analysis={analysis} now={now} />
    {analysis.status === "failed" && <p role="alert" className="mt-3 text-xs">
      <span className="text-muted">{analysis.failed_stage ? `${stageLabels[analysis.failed_stage]} stage · ` : ""}</span>
      {analysis.error_message ?? "The run failed without a recorded reason."}
    </p>}
    {stale && <p className="mt-3 text-xs text-muted">
      The last recorded stage was {analysis.stage ? stageLabels[analysis.stage] : "unknown"}, over five minutes ago.
      The process may have stopped. Rerun it to try again.
    </p>}
  </section>;
}

export function ProgressBadge({ analysis, now }: { analysis: AnalysisSummary; now: number }) {
  if (isStale(analysis, now)) {
    return <span className="progress-badge is-stale">Stale · {analysis.stage ? stageLabels[analysis.stage] : "unknown"}</span>;
  }
  if (analysis.status === "running" && analysis.stage) {
    return <span className="progress-badge">{stageLabels[analysis.stage]}</span>;
  }
  return <span className="progress-badge is-muted">{analysis.status}</span>;
}

export { stageLabels };
