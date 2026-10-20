"use server";

import { after } from "next/server";
import { getAnalysis, readProgress } from "@/lib/analyses";
import { requireOrganization } from "@/lib/auth";
import { normalizeRepositoryUrl } from "@/lib/pipeline/repository";
import { runAnalysis } from "@/lib/pipeline/runner";
import type { AnalysisSummary } from "@/lib/pipeline/types";
import { createSupabaseClient } from "@/lib/supabase/server";

export interface AnalysisActionState {
  error: string | null;
  analysisId: string | null;
}

async function start(
  repositoryUrl: string,
  name: string,
  rerunId: string | null,
): Promise<AnalysisActionState> {
  const supabase = await createSupabaseClient();
  const { data, error } = rerunId === null
    ? await supabase.rpc("start_analysis", { p_repository_url: repositoryUrl, p_name: name })
    : await supabase.rpc("rerun_analysis", { p_analysis_id: rerunId });
  if (error) return { error: error.message, analysisId: rerunId };
  const started = data?.[0];
  if (!started) return { error: "The analysis could not be started.", analysisId: rerunId };
  if (started.started && started.run_id) {
    const { analysis_id: analysisId, run_id: runId } = started;
    // The action returns now; the pipeline continues in this server process.
    after(() => runAnalysis(analysisId, runId, repositoryUrl));
  }
  return { error: null, analysisId: started.analysis_id };
}

export async function startAnalysis(
  expectedOrganizationId: string,
  _previousState: AnalysisActionState,
  formData: FormData,
): Promise<AnalysisActionState> {
  const { orgId } = await requireOrganization();
  // A stale form in another tab must not analyze a repository for a different team.
  if (orgId !== expectedOrganizationId) {
    return { error: "Your active team changed. Reload this page before analyzing a repository.", analysisId: null };
  }
  const input = formData.get("repositoryUrl");
  const value = typeof input === "string" ? input.trim() : "";
  if (!value) return { error: "Enter a public GitHub repository URL.", analysisId: null };

  let repository;
  try {
    repository = normalizeRepositoryUrl(value);
  } catch (error) {
    return { error: error instanceof Error ? error.message : "Enter a valid repository URL.", analysisId: null };
  }
  return start(repository.url, repository.fullName, null);
}

export async function rerunAnalysis(
  expectedOrganizationId: string,
  analysisId: string,
): Promise<AnalysisActionState> {
  const { orgId } = await requireOrganization();
  if (orgId !== expectedOrganizationId) {
    return { error: "Your active team changed. Reload this page before rerunning.", analysisId };
  }
  // A rerun uses the URL already stored for this analysis, never a form value.
  const analysis = await getAnalysis(analysisId);
  if (!analysis?.project) {
    return { error: "The repository URL for this analysis is unavailable.", analysisId };
  }
  return start(analysis.project.repository_url, analysis.project.name, analysisId);
}

export async function readProgressSnapshot(
  expectedOrganizationId: string,
  ids: string[],
): Promise<AnalysisSummary[]> {
  const { orgId } = await requireOrganization();
  if (orgId !== expectedOrganizationId || !Array.isArray(ids)) return [];
  return readProgress(ids.filter(id => typeof id === "string"));
}
