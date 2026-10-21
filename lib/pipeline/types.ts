export const PIPELINE_STAGES = ["fetch", "select", "parse", "store"] as const;

export type PipelineStage = (typeof PIPELINE_STAGES)[number];

export type AnalysisStatus = "queued" | "running" | "completed" | "failed";

export interface AnalysisProject {
  name: string;
  repository_url: string;
  canonical_repository_url: string;
}

export interface AnalysisSummary {
  id: string;
  status: AnalysisStatus;
  is_seed: boolean;
  created_at: string;
  started_at: string | null;
  completed_at: string | null;
  error_message: string | null;
  stage: PipelineStage | null;
  stage_message: string;
  updated_at: string;
  failed_stage: PipelineStage | null;
  commit_sha: string | null;
  run_id: string | null;
  project: AnalysisProject | null;
}

export interface ProgressMessage {
  analysisId: string;
  runId: string | null;
  status: AnalysisStatus;
  stage: PipelineStage | null;
  message: string;
  updatedAt: string;
  failedStage: PipelineStage | null;
  completedAt: string | null;
}

const STAGES = new Set<string>(PIPELINE_STAGES);
const STATUSES = new Set<string>(["queued", "running", "completed", "failed"]);

export function isPipelineStage(value: unknown): value is PipelineStage {
  return typeof value === "string" && STAGES.has(value);
}

export function isProgressMessage(value: unknown): value is ProgressMessage {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return typeof record.analysisId === "string"
    && (record.runId === null || typeof record.runId === "string")
    && typeof record.status === "string" && STATUSES.has(record.status)
    && (record.stage === null || isPipelineStage(record.stage))
    && typeof record.message === "string"
    && typeof record.updatedAt === "string" && Number.isFinite(Date.parse(record.updatedAt))
    && (record.failedStage === null || isPipelineStage(record.failedStage))
    && (record.completedAt === null
      || (typeof record.completedAt === "string" && Number.isFinite(Date.parse(record.completedAt))));
}

// Five minutes without a stage update marks a run stale. There is no queue
// or heartbeat, so the timestamp signals a possible interruption; it cannot
// prove that the process stopped. No database polling is involved.
export const STALE_AFTER_MS = 5 * 60 * 1000;

export function isStale(summary: Pick<AnalysisSummary, "status" | "updated_at">, now = Date.now()) {
  return (summary.status === "queued" || summary.status === "running")
    && now - Date.parse(summary.updated_at) >= STALE_AFTER_MS;
}

export function applyProgress(summary: AnalysisSummary, message: ProgressMessage): AnalysisSummary {
  if (message.analysisId !== summary.id) return summary;
  const incoming = Date.parse(message.updatedAt);
  const existing = Date.parse(summary.updated_at);
  if (incoming < existing) return summary;
  // A newer run can start in another tab. Accept its newer timestamp, while
  // refusing a late event from an old run or an ambiguous timestamp tie.
  if (summary.run_id !== null && message.runId !== summary.run_id && incoming <= existing) return summary;
  return {
    ...summary,
    status: message.status,
    stage: message.stage,
    stage_message: message.message,
    updated_at: message.updatedAt,
    failed_stage: message.failedStage,
    completed_at: message.completedAt,
    run_id: message.runId ?? summary.run_id,
    error_message: message.status === "failed" ? message.message : null,
    is_seed: message.runId === null ? summary.is_seed : false,
    commit_sha: message.runId === summary.run_id ? summary.commit_sha : null,
  };
}
