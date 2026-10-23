import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import type { AiCache } from "../lib/ai/cache";
import { MAX_INPUT_BYTES } from "../lib/ai/classification";
import { PINNED_MODEL } from "../lib/ai/config";
import { inputKey } from "../lib/ai/context";
import { MODEL_ROLES } from "../lib/ai/types";
import { genericCategoryForPath } from "../lib/frameworks/taxonomy";
import { analyzeRepository } from "../lib/parser";
import fixtures from "./fixtures/roles.json";
import { classifyRoleExample, loadRoleDataset } from "./roles";

const dataset = loadRoleDataset();

test("role dataset contains at least 30 distinct meaningful sources with parser-derived gold labels", async () => {
  const examples = await dataset;
  assert.ok(examples.length >= 30);
  assert.equal(new Set(examples.map(example => example.path)).size, examples.length);
  assert.equal(new Set(examples.map(example => example.contentHash)).size, examples.length);
  assert.deepEqual([...new Set(examples.map(example => example.framework))].sort(), ["express", "nestjs", "react"]);
  assert.deepEqual([...new Set(examples.map(example => example.expectedRole))].sort(), ["component", "hook", "model", "service"]);
  for (const example of examples) {
    assert.ok(example.content.trim().length > 100, example.path);
    assert.equal(example.contentHash, createHash("sha256").update(example.content).digest("hex"));
    assert.equal(genericCategoryForPath(example.path).id, "source");
    assert.ok(MODEL_ROLES.some(role => role === example.expectedRole));
  }

  const root = await mkdtemp(path.join(tmpdir(), "cartograph-role-gold-test-"));
  try {
    const gold = [];
    const excludedStructuralRoles = new Set<string>();
    for (const project of fixtures.projects) {
      assert.ok(Object.hasOwn(project.files, "package.json"));
      const directory = path.join(root, project.name);
      for (const [file, content] of Object.entries(project.files)) {
        const destination = path.join(directory, file);
        await mkdir(path.dirname(destination), { recursive: true });
        await writeFile(destination, content, "utf8");
      }
      const analysis = await analyzeRepository(directory);
      const byPath = new Map(analysis.files.map(file => [file.path, file]));
      const fixtureSources = new Map<string, string>(Object.entries(project.files));
      for (const label of analysis.fileRoles) {
        const expectedRole = MODEL_ROLES.find(role => role === label.role);
        const file = byPath.get(label.file);
        assert.ok(file, label.file);
        if (!expectedRole) {
          excludedStructuralRoles.add(label.role);
          assert.ok(!examples.some(example => example.path === `${project.name}/${label.file}`));
          continue;
        }
        if (genericCategoryForPath(label.file).id !== "source") {
          assert.ok(!examples.some(example => example.path === `${project.name}/${label.file}`));
          continue;
        }
        gold.push({ path: `${project.name}/${label.file}`, content: fixtureSources.get(label.file),
          contentHash: file.contentHash, expectedRole, framework: analysis.framework });
      }
      if (project.name === "react-workspace") {
        assert.ok(analysis.fileRoles.some(label => label.file === "runtime-tests/usePreview.ts" && label.role === "hook"));
        assert.equal(genericCategoryForPath("runtime-tests/usePreview.ts").id, "test");
      }
    }
    assert.deepEqual(examples, gold);
    assert.deepEqual([...excludedStructuralRoles].sort(), ["controller", "entity", "middleware", "module", "route"]);
    for (const example of examples) {
      assert.doesNotMatch(example.path, /\.(test|spec)\.|\.d\.ts$|runtime-tests\//);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("single-file classification hides every gold label and uses the production classifier without model calls", async t => {
  const environment = { OPENAI_API_KEY: "", OPENAI_BASE_URL: "", OPENAI_MODEL: PINNED_MODEL, LANGSMITH_TRACING: "false" };
  const original = new Map(Object.keys(environment).map(name => [name, process.env[name]]));
  for (const [name, value] of Object.entries(environment)) process.env[name] = value;
  t.after(() => {
    for (const [name, value] of original) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });
  t.mock.method(globalThis, "fetch", async () => { throw new Error("Role unit tests must never call an external service."); });

  for (const example of await dataset) {
    let reads = 0;
    const cache: AiCache = {
      async read(key) {
        reads += 1;
        assert.equal(key, inputKey(PINNED_MODEL, "", "classify", [{
          path: example.path, contentHash: example.contentHash, content: example.content,
        }]));
        // Return a different permitted label to prove the wrapper returns the
        // classifier output rather than recovering the hidden expectedRole.
        return { roles: [{ file: example.path, role: "util", contentHash: example.contentHash }] };
      },
      async write() { assert.fail("A cache hit must not generate or write a role."); },
    };
    assert.deepEqual(await classifyRoleExample(example, cache), { role: "util" });
    const relabelled = { ...example, expectedRole: "config" as const };
    assert.deepEqual(await classifyRoleExample(relabelled, cache), { role: "util" });
    assert.equal(reads, 2, example.path);
  }

  const example = (await dataset)[0];
  assert.ok(example);
  const oversized = { ...example, content: "x".repeat(MAX_INPUT_BYTES) };
  oversized.contentHash = createHash("sha256").update(oversized.content).digest("hex");
  const reports: unknown[][] = [];
  t.mock.method(console, "error", (...args: unknown[]) => { reports.push(args); });
  await assert.rejects(classifyRoleExample(oversized, {
    async read() { assert.fail("An oversized example must not enter a classification batch."); },
    async write() { assert.fail("An oversized example must not generate or write a role."); },
  }), /classifier returned no role/);
  assert.equal(reports.length, 1);
});
