import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { AiCache } from "../lib/ai/cache";
import { roleCandidates } from "../lib/ai/candidates";
import { classifySnapshot } from "../lib/ai/operations";
import { MODEL_ROLES, type ModelRole } from "../lib/ai/types";
import type { Framework } from "../lib/frameworks/taxonomy";
import { analyzeRepository, type AnalysisResult } from "../lib/parser";
import fixtures from "./fixtures/roles.json";

export type RoleExample = {
  path: string;
  content: string;
  contentHash: string;
  expectedRole: ModelRole;
  framework: Framework;
};

export async function loadRoleDataset(): Promise<RoleExample[]> {
  const root = await mkdtemp(path.join(tmpdir(), "cartograph-role-eval-"));
  const examples: RoleExample[] = [];
  try {
    for (const project of fixtures.projects) {
      const directory = path.join(root, project.name);
      const sources = new Map<string, string>(Object.entries(project.files));
      for (const [file, content] of sources) {
        const destination = path.join(directory, file);
        await mkdir(path.dirname(destination), { recursive: true });
        await writeFile(destination, content, "utf8");
      }
      const analysis = await analyzeRepository(directory);
      const parseFailures = analysis.coverage.files.skippedFiles.filter(file => file.reason === "parse-failed");
      if (parseFailures.length) {
        throw new Error(`Role fixtures failed to parse: ${parseFailures.map(file => `${project.name}/${file.path}`).join(", ")}.`);
      }
      // Hold out adapter labels only where the production classifier would accept
      // the file once those labels are removed. Structural roles remain excluded.
      const candidates = new Map(roleCandidates({ ...analysis, fileRoles: [] }).map(file => [file.path, file]));
      for (const label of analysis.fileRoles) {
        const expectedRole = MODEL_ROLES.find(role => role === label.role);
        const file = candidates.get(label.file);
        if (!expectedRole || !file) continue;
        const content = sources.get(file.path);
        if (content === undefined) throw new Error(`Role fixture source is missing: ${project.name}/${file.path}.`);
        examples.push({ path: `${project.name}/${file.path}`, content, contentHash: file.contentHash,
          expectedRole, framework: analysis.framework });
      }
    }
    if (examples.length < 30) {
      throw new Error(`Role evaluation requires at least 30 adapter-labelled source files; found ${examples.length}.`);
    }
    return examples;
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

export async function classifyRoleExample(example: Omit<RoleExample, "expectedRole">, cache: AiCache): Promise<{ role: ModelRole }> {
  const analysis: AnalysisResult = {
    schemaVersion: 1,
    framework: example.framework,
    // Never pass the gold label into the classifier, even as adapter metadata.
    fileRoles: [],
    frameworkEntries: [],
    routes: [],
    files: [{ path: example.path, folder: path.posix.dirname(example.path), module: ".",
      contentHash: example.contentHash,
      lineCount: example.content.split(/\r\n|\r|\n/).length - (!example.content || /[\r\n]$/.test(example.content) ? 1 : 0),
      fanIn: 0, fanOut: 0, exports: [] }],
    edges: [],
    imports: [],
    coverage: { files: { discovered: 1, parsed: 1, skipped: 0, skippedFiles: [], excludedDirectories: [] },
      imports: { discovered: 0, internal: 0, external: 0, excluded: 0, unresolved: 0 } },
  };
  const roles = await classifySnapshot(analysis, new Map([[example.path, example.content]]), cache);
  const result = roles.find(role => role.file === example.path);
  if (!result) throw new Error(`The classifier returned no role for ${example.path}.`);
  return { role: result.role };
}
