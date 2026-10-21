import "server-only";

import { validateAnalysisResult } from "@/lib/parser/serialization";
import type { AnalysisResult } from "@/lib/parser/contract";
import type { AnalysisSummary } from "@/lib/pipeline/types";
import { createSupabaseClient } from "@/lib/supabase/server";

const ANALYSIS_LIMIT = 50;

const SUMMARY_COLUMNS = "id, status, is_seed, created_at, started_at, completed_at, error_message, stage, stage_message, updated_at, failed_stage, commit_sha, run_id, project:projects(name, repository_url, canonical_repository_url)";

async function ensureOrganization() {
  const supabase = await createSupabaseClient();
  // Clerk's prebuilt creation flow does not call our server. Register only the
  // organization in the verified token; this RPC cannot choose another ID.
  const { error } = await supabase.rpc("ensure_organization");
  if (error) {
    throw new Error("The current organization could not be synchronized.", { cause: error });
  }
  return supabase;
}

export async function listAnalyses() {
  const supabase = await ensureOrganization();
  // The active organization is enforced by RLS using the Clerk session token.
  const { data, error } = await supabase
    .from("analyses")
    .select(SUMMARY_COLUMNS)
    .order("created_at", { ascending: false })
    .order("id", { ascending: false })
    .limit(ANALYSIS_LIMIT + 1);

  if (error) {
    throw new Error("Analyses could not be loaded from the database.", { cause: error });
  }
  const rows: AnalysisSummary[] = data;
  return {
    analyses: rows.slice(0, ANALYSIS_LIMIT),
    hasMore: rows.length > ANALYSIS_LIMIT,
  };
}

export async function getAnalysis(id: string) {
  const supabase = await ensureOrganization();
  const { data, error } = await supabase
    .from("analyses")
    .select(SUMMARY_COLUMNS)
    .eq("id", id)
    .maybeSingle();
  if (error) {
    throw new Error("The analysis could not be loaded.", { cause: error });
  }
  return data;
}

export async function readProgress(ids: readonly string[]) {
  if (ids.length === 0) return [];
  const supabase = await ensureOrganization();
  const { data, error } = await supabase
    .from("analyses")
    .select(SUMMARY_COLUMNS)
    .in("id", ids.slice(0, ANALYSIS_LIMIT))
    .limit(ANALYSIS_LIMIT);
  if (error) {
    throw new Error("Analysis progress could not be refreshed.", { cause: error });
  }
  return data;
}

// Read the graph in one database snapshot, then validate the same parser
// contract used by the standalone command. A rerun in another tab invalidates
// the expected run instead of mixing its files with the previous graph.
export async function loadAnalysisResult(id: string, runId: string): Promise<AnalysisResult | null> {
  const supabase = await ensureOrganization();
  const { data, error } = await supabase.rpc("read_analysis_result_v2", {
    p_analysis_id: id,
    p_run_id: runId,
  });
  if (error) throw new Error("The stored graph could not be loaded.", { cause: error });
  return data === null ? null : validateAnalysisResult(data);
}
