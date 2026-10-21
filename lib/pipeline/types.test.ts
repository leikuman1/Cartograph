import assert from "node:assert/strict";
import test from "node:test";
import { applyProgress, isProgressMessage, isStale, STALE_AFTER_MS, type AnalysisSummary, type ProgressMessage } from "./types";

const summary: AnalysisSummary = {
  id: "analysis-1", run_id: "run-1", status: "running", stage: "parse",
  stage_message: "Parsing", updated_at: "2026-10-19T05:00:00Z",
  is_seed: false, created_at: "2026-10-19T04:59:00Z", started_at: "2026-10-19T04:59:00Z",
  completed_at: null, error_message: null, failed_stage: null,
  commit_sha: "a".repeat(40), project: {
    name: "example/repo", repository_url: "https://github.com/Example/Repo.GIT",
    canonical_repository_url: "https://github.com/example/repo",
  },
};

function progress(values: Partial<ProgressMessage> = {}): ProgressMessage {
  return {
    analysisId: summary.id, runId: summary.run_id, status: "completed", stage: "store",
    message: "Stored", updatedAt: "2026-10-19T05:01:00Z", failedStage: null,
    completedAt: "2026-10-19T05:01:00Z", ...values,
  };
}

test("a rerun started in another tab replaces the previous run in live state", () => {
  const rerun = applyProgress(summary, progress({
    runId: "run-2", status: "running", stage: "fetch", message: "Fetching", completedAt: null,
  }));
  assert.equal(rerun.run_id, "run-2");
  assert.equal(rerun.stage, "fetch");
  assert.equal(rerun.commit_sha, null);
  assert.equal(applyProgress(rerun, progress()), rerun);
  assert.equal(applyProgress(rerun, progress({ updatedAt: summary.updated_at })), rerun);
});

test("live failures show their reason immediately and old or unrelated events are ignored", () => {
  const failed = applyProgress(summary, progress({ status: "failed", failedStage: "parse", stage: "parse", message: "Invalid tsconfig" }));
  assert.equal(failed.error_message, "Invalid tsconfig");
  assert.equal(failed.failed_stage, "parse");
  assert.equal(applyProgress(failed, progress({ updatedAt: summary.updated_at })), failed);
  assert.equal(applyProgress(summary, progress({ analysisId: "other-analysis" })), summary);
});

test("staleness depends on the last update and never labels terminal rows stale", () => {
  const updatedAt = Date.parse(summary.updated_at);
  assert.equal(isStale(summary, updatedAt + STALE_AFTER_MS - 1), false);
  assert.equal(isStale(summary, updatedAt + STALE_AFTER_MS), true);
  assert.equal(isStale({ ...summary, status: "completed" }, updatedAt + STALE_AFTER_MS), false);
  assert.equal(isStale({ ...summary, status: "failed" }, updatedAt + STALE_AFTER_MS), false);
});

test("progress payloads need usable timestamps before they enter live state", () => {
  assert.equal(isProgressMessage(progress()), true);
  assert.equal(isProgressMessage(progress({ updatedAt: "not a timestamp" })), false);
  assert.equal(isProgressMessage(progress({ completedAt: "not a timestamp" })), false);
  assert.equal(isProgressMessage({ ...progress(), stage: "deploy" }), false);
});
