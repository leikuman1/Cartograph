"use server";

import { after } from "next/server";
import { requireOrganization } from "@/lib/auth";
import { getAnalysis, loadAnalysisResult } from "@/lib/analyses";
import { aiConfiguration } from "@/lib/ai/config";
import { explanationContext, roleCandidates } from "@/lib/ai/context";
import { flushTraces } from "@/lib/ai/client";
import { repositoryFreshness } from "@/lib/ai/freshness";
import { classifySnapshot, explainSnapshot } from "@/lib/ai/operations";
import { createAiWriter, requestCache } from "@/lib/ai/storage";
import { UNKNOWN_FRESHNESS, type AiPanelContext, type ExplanationResponse, type ExplainTarget, type ModelRoleRecord } from "@/lib/ai/types";
import { normalizeRepositoryUrl, readRepositorySource } from "@/lib/pipeline/repository";

async function snapshot(context: AiPanelContext) {
  const { orgId } = await requireOrganization();
  if (orgId !== context.organizationId) throw new Error("Your active team changed. Reload before generating an explanation.");
  const summary = await getAnalysis(context.analysisId);
  if (!summary?.project || !summary.commit_sha || summary.status !== "completed" || summary.run_id !== context.runId) {
    throw new Error("This analysis was replaced or is unavailable. Reload the page.");
  }
  const analysis = await loadAnalysisResult(summary.id, context.runId);
  if (!analysis) throw new Error("The graph changed. Reload the page.");
  return { orgId, summary, analysis, repository: normalizeRepositoryUrl(summary.project.canonical_repository_url), commit: summary.commit_sha };
}

function scheduleTraceFlush() {
  after(async () => {
    await flushTraces().catch(() => console.error("LangSmith traces could not be flushed. Check the tracing configuration."));
  });
}

export async function explain(context: AiPanelContext, target: ExplainTarget): Promise<ExplanationResponse> {
  let freshness = UNKNOWN_FRESHNESS;
  try {
    if (!target || !["file", "folder"].includes(target.kind) || typeof target.path !== "string") throw new Error("Select a file or folder to explain.");
    const current = await snapshot(context);
    const input = explanationContext(current.analysis, target);
    freshness = await repositoryFreshness(current.repository.url, current.commit,
      current.analysis.files.filter(file => input.members.includes(file.path)));
    const config = aiConfiguration();
    const cache = await requestCache(current.orgId, config.model);
    const result = await explainSnapshot(current.analysis, target, cache, async (path, hash) => {
      const source = await readRepositorySource(current.repository, current.commit, path);
      if (!source || source.contentHash !== hash) throw new Error(`The analyzed source for ${path} no longer matches its stored hash. Reanalyze the repository.`);
      return source.content;
    });
    await snapshot(context);
    return { document: result.value, cacheHit: result.cacheHit, error: null, freshness };
  } catch (error) {
    return { document: null, cacheHit: false, error: error instanceof Error ? error.message : "The explanation could not be generated.", freshness };
  } finally {
    scheduleTraceFlush();
  }
}

export async function classify(context: AiPanelContext): Promise<{ roles: ModelRoleRecord[]; error: string | null }> {
  try {
    const current = await snapshot(context);
    const sources = new Map<string, string>();
    for (const file of roleCandidates(current.analysis)) {
      const source = await readRepositorySource(current.repository, current.commit, file.path);
      if (!source || source.contentHash !== file.contentHash) throw new Error(`The analyzed source for ${file.path} is unavailable. Reanalyze the repository.`);
      sources.set(file.path, source.content);
    }
    const config = aiConfiguration();
    const roles = await classifySnapshot(current.analysis, sources, await requestCache(current.orgId, config.model));
    const { data, error } = await createAiWriter().rpc("write_ai_roles", {
      p_analysis_id: context.analysisId, p_run_id: context.runId, p_model: config.model, p_roles: roles,
    });
    if (error || data !== true) throw new Error("The roles could not be attached to this run. Reload the page.");
    await snapshot(context);
    return { roles, error: null };
  } catch (error) {
    return { roles: [], error: error instanceof Error ? error.message : "File roles could not be assigned." };
  } finally {
    scheduleTraceFlush();
  }
}
