import "server-only";

import { createClient } from "@supabase/supabase-js";
import { analyzeDiscoveredRepository } from "@/lib/parser";
import { discoverRepository } from "@/lib/parser/discovery";
import { getEnvironment } from "@/lib/env";
import { fetchRepository, normalizeRepositoryUrl } from "./repository";
import type { PipelineStage } from "./types";

type AdminClient = ReturnType<typeof createAdminClient>;

function createAdminClient() {
  const { supabaseUrl, supabaseSecretKey } = getEnvironment();
  return createClient(supabaseUrl, supabaseSecretKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
}

async function stage(
  client: AdminClient,
  analysisId: string,
  runId: string,
  stageName: PipelineStage,
  message: string,
  commitSha?: string,
) {
  const { data, error } = await client.rpc("set_analysis_stage", {
    p_analysis_id: analysisId,
    p_run_id: runId,
    p_stage: stageName,
    p_message: message,
    p_commit_sha: commitSha ?? null,
  });
  if (error) throw new Error(`The ${stageName} stage could not be recorded: ${error.message}`);
  // A different run took over; this run must stop rather than overwrite it.
  if (data !== true) throw new RunSuperseded();
}

class RunSuperseded extends Error {
  constructor() {
    super("A newer run replaced this one.");
  }
}

// The whole pipeline has one outer failure boundary. Any stage that throws is
// recorded with the stage it was in, so a row never stays "running" silently.
export async function runAnalysis(analysisId: string, runId: string, repositoryUrl: string) {
  const client = createAdminClient();
  let current: PipelineStage = "fetch";
  let fetched: Awaited<ReturnType<typeof fetchRepository>> | null = null;
  try {
    await stage(client, analysisId, runId, "fetch", "Fetching the repository archive");
    const repository = normalizeRepositoryUrl(repositoryUrl);
    fetched = await fetchRepository(repository);
    await stage(
      client, analysisId, runId, "fetch",
      `Fetched ${repository.fullName} at ${fetched.commitSha.slice(0, 7)}`,
      fetched.commitSha,
    );

    current = "select";
    await stage(client, analysisId, runId, "select", "Selecting files to parse");
    const discovery = await discoverRepository(fetched.directory);
    await stage(
      client, analysisId, runId, "select",
      `Selected ${discovery.sourceFiles.length} files; skipped ${discovery.skippedFiles.length}`,
    );

    current = "parse";
    await stage(client, analysisId, runId, "parse", "Parsing imports and resolving paths");
    const result = await analyzeDiscoveredRepository(discovery);
    await stage(
      client, analysisId, runId, "parse",
      `Parsed ${result.files.length} files and resolved ${result.edges.length} edges`,
    );

    current = "store";
    await stage(client, analysisId, runId, "store", "Storing the dependency map");
    const { data, error } = await client.rpc("store_analysis", {
      p_analysis_id: analysisId,
      p_run_id: runId,
      p_result: result,
    });
    if (error) throw new Error(`The dependency map could not be stored: ${error.message}`);
    if (data !== true) throw new RunSuperseded();
  } catch (error) {
    if (error instanceof RunSuperseded) return;
    const message = error instanceof Error ? error.message : "The analysis failed.";
    const { error: failureError } = await client.rpc("fail_analysis", {
      p_analysis_id: analysisId,
      p_run_id: runId,
      p_stage: current,
      p_message: message,
    });
    if (failureError) {
      // The outer boundary could not record the failure. Log it rather than
      // pretending the run was tracked; the row will show as stale.
      console.error("Analysis failure could not be recorded", {
        analysisId, runId, stage: current, message, failure: failureError.message,
      });
    }
  } finally {
    await fetched?.cleanup().catch(error => {
      console.error("Temporary repository cleanup failed", error instanceof Error ? error.message : error);
    });
  }
}
