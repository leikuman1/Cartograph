import path from "node:path";
import type { RepositoryAdapter } from "./adapter";
import { fallbackAdapter } from "./adapter";
import type {
  AnalysisResult,
  FileMetadata,
  ImportRecord,
  ImportResolution,
  InternalImport,
  SkippedFile,
} from "./contract";
import { discoverRepository, type DiscoveryResult } from "./discovery";
import { buildGraph } from "./graph";
import { extractImports } from "./imports";
import {
  createResolutionIndex,
  parseSourceFiles,
  resolveImport,
} from "./resolution";
import { validateAnalysisResult } from "./serialization";

export type { AnalysisResult, DiscoveryResult, RepositoryAdapter };
export { fallbackAdapter } from "./adapter";
export { readAnalysisResult, writeAnalysisResult } from "./serialization";

export interface AnalyzeRepositoryOptions {
  adapter?: RepositoryAdapter;
}

function compareText(left: string, right: string) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function compareImports(left: ImportRecord, right: ImportRecord) {
  return compareText(left.source, right.source)
    || left.line - right.line
    || compareText(left.kind, right.kind)
    || compareText(left.specifier ?? "", right.specifier ?? "")
    || compareText(left.resolution.status, right.resolution.status);
}

function nearestPackageDirectory(folder: string, packageDirectories: ReadonlySet<string>) {
  let current = folder;
  while (true) {
    if (packageDirectories.has(current)) return current;
    if (current === ".") return null;
    const parent = path.posix.dirname(current);
    current = parent === "" ? "." : parent;
  }
}

function importCoverage(imports: readonly ImportRecord[]) {
  const coverage = {
    discovered: imports.length,
    internal: 0,
    external: 0,
    excluded: 0,
    unresolved: 0,
  };
  for (const occurrence of imports) coverage[occurrence.resolution.status] += 1;
  return coverage;
}

function sortSkippedFiles(files: SkippedFile[]) {
  return files.sort((left, right) => compareText(left.path, right.path));
}

export async function analyzeRepository(
  directory: string,
  options: AnalyzeRepositoryOptions = {},
): Promise<AnalysisResult> {
  return analyzeDiscoveredRepository(await discoverRepository(directory), options);
}

// The pipeline selects once, reports the selection, then parses the same
// snapshot. Keeping discovery outside this call makes those real stages rather
// than labels around a single opaque operation.
export async function analyzeDiscoveredRepository(
  discovered: DiscoveryResult,
  options: AnalyzeRepositoryOptions = {},
): Promise<AnalysisResult> {
  const adapter = options.adapter ?? fallbackAdapter;
  const parsed = await parseSourceFiles(discovered.rootPath, discovered.sourceFiles);
  const skippedFiles = sortSkippedFiles([
    ...discovered.skippedFiles,
    ...parsed.parseFailures,
  ]);
  const resolutionIndex = createResolutionIndex(
    discovered.rootPath,
    parsed.sourceFiles,
    skippedFiles,
    discovered.excludedDirectories,
  );

  const metadata: FileMetadata[] = parsed.sourceFiles.map(file => {
    const packageDirectory = nearestPackageDirectory(
      file.discovered.folder,
      discovered.packageDirectories,
    );
    return {
      path: file.discovered.path,
      folder: file.discovered.folder,
      module: adapter.moduleForFile({
        path: file.discovered.path,
        folder: file.discovered.folder,
        packageDirectory,
      }),
      lineCount: file.discovered.lineCount,
      contentHash: file.discovered.contentHash,
    };
  });

  const imports: ImportRecord[] = [];
  const internalImports: InternalImport[] = [];
  const resolved = new Map<string, Promise<ImportResolution>>();
  for (const source of parsed.sourceFiles) {
    for (const occurrence of extractImports(source.sourceFile, source.discovered.path)) {
      let resolution: ImportResolution;
      if (occurrence.specifier === null) {
        resolution = {
          status: "excluded",
          reason: "dynamic-import-not-string-literal",
        };
      } else {
        const key = `${source.discovered.path}\0${occurrence.specifier}`;
        let pending = resolved.get(key);
        if (!pending) {
          pending = resolveImport(source, occurrence.specifier, resolutionIndex);
          resolved.set(key, pending);
        }
        resolution = await pending;
      }

      imports.push({ ...occurrence, resolution });
      if (resolution.status === "internal") {
        internalImports.push({
          source: occurrence.source,
          target: resolution.target,
          kind: occurrence.kind,
        });
      }
    }
  }
  imports.sort(compareImports);

  const graph = buildGraph(metadata, internalImports);
  return validateAnalysisResult({
    schemaVersion: 1,
    files: graph.files,
    edges: graph.edges,
    imports,
    coverage: {
      files: {
        discovered: graph.files.length + skippedFiles.length,
        parsed: graph.files.length,
        skipped: skippedFiles.length,
        skippedFiles,
        excludedDirectories: discovered.excludedDirectories,
      },
      imports: importCoverage(imports),
    },
  });
}
