import "server-only";
import type { AnalysisResult } from "../parser/contract";
import { createSupabaseClient } from "../supabase/server";
import { roleCandidates, validateRoles } from "./context";

export async function loadModelRoles(analysisId: string, runId: string, model: string, analysis: AnalysisResult) {
  const client = await createSupabaseClient();
  const { data, error } = await client.rpc("read_ai_roles", { p_analysis_id: analysisId, p_run_id: runId, p_model: model });
  if (error) throw new Error("AI roles could not be loaded. Apply the phase 10 migration.", { cause: error });
  // A stored subset leaves the remaining candidates available to Assign AI roles.
  return data === null ? [] : validateRoles(data, roleCandidates(analysis), false);
}
