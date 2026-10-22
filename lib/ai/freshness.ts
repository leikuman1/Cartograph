import type { AnalysisResult } from "../parser/contract";
import { normalizeRepositoryUrl, readRepositorySource, resolveRepositoryHead } from "../pipeline/repository";
import type { Freshness } from "./types";

export async function repositoryFreshness(repositoryUrl: string, commitSha: string, files: readonly AnalysisResult["files"][number][] = []): Promise<Freshness> {
  try {
    const repository = normalizeRepositoryUrl(repositoryUrl);
    const head = await resolveRepositoryHead(repository);
    const changedFiles: string[] = [];
    for (const file of files) {
      const current = await readRepositorySource(repository, head, file.path);
      if (!current || current.contentHash !== file.contentHash) changedFiles.push(file.path);
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
