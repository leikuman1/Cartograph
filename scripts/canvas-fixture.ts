import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { analyzeRepository } from "../lib/parser";
import { validateAnalysisResult } from "../lib/parser/serialization";

async function main() {
  const directory = process.argv[2];
  if (!directory) throw new Error("Usage: pnpm fixture:canvas <hono-v4.10.2-checkout>");
  const root = path.resolve(directory);
  const packageContents = await readFile(path.join(root, "package.json"), "utf8");
  const packageValue: unknown = JSON.parse(packageContents);
  if (typeof packageValue !== "object" || packageValue === null || !("name" in packageValue) || packageValue.name !== "hono" || !("version" in packageValue) || packageValue.version !== "4.10.2") {
    throw new Error("The canvas fixture must be generated from the Hono v4.10.2 checkout.");
  }
  const revision = execFileSync("git", ["-C", root, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  if (revision !== "0c6455dc10db6428257bdd601eca559247e27de6") throw new Error("Expected the pinned Hono v4.10.2 commit.");
  if (execFileSync("git", ["-C", root, "status", "--porcelain"], { encoding: "utf8" }).trim()) throw new Error("Generate from an unchanged Hono checkout.");
  const result = validateAnalysisResult(await analyzeRepository(root));
  const destination = path.resolve("lib/canvas/fixture/analysis.ts");
  await writeFile(destination, `import type { AnalysisResult } from "../../parser/contract";\n\nexport const analysis: AnalysisResult = ${JSON.stringify(result, null, 2)};\n`, "utf8");
  const license = await readFile(path.join(root, "LICENSE"), "utf8");
  await writeFile(path.resolve("lib/canvas/fixture/LICENSE"), license, "utf8");
  const hash = createHash("sha256").update(await readFile(destination)).digest("hex");
  console.log(`${result.files.length} files; ${result.edges.length} edges; ${result.coverage.files.skipped} skipped; ${result.coverage.imports.unresolved} unresolved`);
  console.log(`analysis.ts SHA-256: ${hash}`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
