import type { AnalysisResult } from "../parser/contract";
import { normalizeRepositoryUrl, readRepositorySource, resolveRepositoryHead } from "../pipeline/repository";
import type { Freshness } from "./types";

const SOURCE_READ_CONCURRENCY = 4;

export async function repositoryFreshness(repositoryUrl: string, commitSha: string, files: readonly AnalysisResult["files"][number][] = []): Promise<Freshness> {
  try {
    const repository = normalizeRepositoryUrl(repositoryUrl);
    const head = await resolveRepositoryHead(repository);
    const changedFiles: string[] = [];
    for (let offset = 0; offset < files.length; offset += SOURCE_READ_CONCURRENCY) {
      const batch = files.slice(offset, offset + SOURCE_READ_CONCURRENCY);
      // Settle every in-flight read before returning unknown on a failed batch.
      const results = await Promise.allSettled(batch.map(async file => {
        const current = await readRepositorySource(repository, head, file.path);
        return !current || current.contentHash !== file.contentHash ? file.path : null;
      }));
      for (const result of results) {
        if (result.status === "rejected") throw result.reason;
        if (result.value !== null) changedFiles.push(result.value);
      }
    }
    if (head !== commitSha || changedFiles.length) return {
      status: "stale", head, changedFiles,
      message: changedFiles.length
        ? `${changedFiles.length} explained ${changedFiles.length === 1 ? "file has" : "files have"} changed or been removed. This explanation uses the analyzed commit. Reanalyze to update the map and explanation.`
        : "The repository has a different commit from this analysis. Reanalyze to update the map and explanations.",
    };
    return { status: "fresh", head, changedFiles, message: "The repository matches the analyzed commit." };
  } catch (error) {
    return { status: "unknown", head: null, changedFiles: [], message: error instanceof Error ? `Freshness unavailable: ${error.message}` : "Repository freshness could not be checked." };
  }
}
