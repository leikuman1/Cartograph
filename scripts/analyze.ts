import path from "node:path";
import { pathToFileURL } from "node:url";
import { analyzeRepository, writeAnalysisResult } from "../lib/parser/index";

interface Arguments {
  directory: string;
  output: string | null;
}

function parseArguments(values: readonly string[]): Arguments {
  let directory: string | null = null;
  let output: string | null = null;

  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (value === "--") continue;
    if (value === "--output") {
      const outputValue = values[index + 1];
      if (!outputValue || output !== null) throw new Error("--output requires one path and may only be used once.");
      output = outputValue;
      index += 1;
      continue;
    }
    if (value.startsWith("-")) throw new Error(`Unknown option: ${value}.`);
    if (directory !== null) throw new Error("Only one repository directory may be analyzed.");
    directory = value;
  }

  if (directory === null) {
    throw new Error("Usage: pnpm analyze <directory> [--output <json-file>]");
  }
  return { directory, output };
}

function printSummary(result: Awaited<ReturnType<typeof analyzeRepository>>, output: string) {
  const fileCoverage = result.coverage.files;
  const importCoverage = result.coverage.imports;
  const reExports = result.imports.filter(occurrence => occurrence.kind === "re-export");
  const resolvedReExports = reExports.filter(occurrence => occurrence.resolution.status === "internal");

  console.log(`Files: ${fileCoverage.discovered} discovered; ${fileCoverage.parsed} parsed; ${fileCoverage.skipped} skipped.`);
  console.log(`Folders: ${new Set(result.files.map(file => file.folder)).size}.`);
  console.log(`Edges: ${result.edges.length}.`);
  console.log(`Imports: ${importCoverage.discovered} discovered; ${importCoverage.internal} internal; ${importCoverage.external} external; ${importCoverage.excluded} excluded; ${importCoverage.unresolved} unresolved.`);
  console.log(`Re-exports: ${reExports.length} discovered; ${resolvedReExports.length} internal.`);
  console.log(`Excluded directories: ${fileCoverage.excludedDirectories.length}.`);

  if (fileCoverage.skippedFiles.length > 0) {
    console.log("Skipped files:");
    for (const file of fileCoverage.skippedFiles) {
      console.log(`- ${file.path}: ${file.reason}${file.detail ? ` (${file.detail})` : ""}`);
    }
  }

  const unresolved = result.imports.filter(occurrence => occurrence.resolution.status === "unresolved");
  if (unresolved.length > 0) {
    console.log("Unresolved imports:");
    for (const occurrence of unresolved.slice(0, 10)) {
      if (occurrence.resolution.status !== "unresolved") continue;
      console.log(`- ${occurrence.source}:${occurrence.line} ${occurrence.specifier ?? "<non-literal>"}: ${occurrence.resolution.reason}`);
    }
  }
  console.log(`Full result: ${path.resolve(output)}.`);
}

export async function run(values: readonly string[]) {
  const args = parseArguments(values);
  const result = await analyzeRepository(args.directory);
  if (args.output === null) {
    console.log(JSON.stringify(result, null, 2));
    return result;
  }
  const roundTripped = await writeAnalysisResult(args.output, result);
  printSummary(roundTripped, args.output);
  return roundTripped;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  run(process.argv.slice(2)).catch(error => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
