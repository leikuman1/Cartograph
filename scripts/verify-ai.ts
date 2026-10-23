import "./load-env";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Client } from "langsmith";
import { getCurrentRunTree } from "langsmith/traceable";
import { aiConfiguration } from "../lib/ai/config";
import { flushTraces, tracedOperation } from "../lib/ai/client";
import { cachedOperation, type AiCache } from "../lib/ai/cache";
import { classifySnapshot, explainSnapshot } from "../lib/ai/operations";
import type { AnalysisResult } from "../lib/parser/contract";

// Explicit live check: sends only this synthetic fixture to the configured API.
// No database fixture or repository content is read or written.
const fixture: AnalysisResult = {
  schemaVersion: 1, framework: "generic", frameworkEntries: [], fileRoles: [], routes: [],
  files: [{ path: "sum.ts", folder: ".", module: ".", lineCount: 1, contentHash: "a".repeat(64), exports: ["sum"], fanIn: 0, fanOut: 0 }],
  edges: [], imports: [], coverage: { files: { discovered: 1, parsed: 1, skipped: 0, skippedFiles: [], excludedDirectories: [] },
    imports: { discovered: 0, internal: 0, external: 0, excluded: 0, unresolved: 0 } },
};
const source = "export function sum(a: number, b: number) { return a + b; }";
const values = new Map<string, Record<string, unknown>>();
const cache: AiCache = {
  async read(key) { return values.get(key) ?? null; },
  async write(key, _operation, value) { values.set(key, value); },
};

async function main() {
  const first = await explainSnapshot(fixture, { kind: "file", path: "sum.ts" }, cache, async () => source);
  assert.equal(first.cacheHit, false);
  assert.ok(first.value.blocks.length);
  const second = await explainSnapshot(fixture, { kind: "file", path: "sum.ts" }, cache, async () => { throw new Error("Cache hit fetched source."); });
  assert.equal(second.cacheHit, true);
  assert.deepEqual(first.value, second.value);
  const roles = await classifySnapshot(fixture, new Map([["sum.ts", source]]), cache);
  assert.equal(roles.length, 1);
  console.log("Magpie explanation, classification and repeated cache hit passed.");

  const config = aiConfiguration();
  if (config.tracing) {
    // Read the known run ID through the current API rather than polling a list.
    const name = `cartograph-cache-check-${randomUUID()}`;
    let recordedId: string | undefined;
    await cachedOperation(cache, [...values.keys()][0], "file",
      work => tracedOperation(name, { model: config.model }, async () => {
        recordedId = getCurrentRunTree().id;
        return work();
      }),
      value => { assert.ok(value); return { checked: true }; },
      async () => { throw new Error("The hit called a model."); });
    await flushTraces();
    assert.ok(recordedId, "The cache read did not enter a trace.");
    const client = new Client({ timeout_ms: 15000 });
    const project = await client.readProject({ projectName: config.tracingProject });
    const run = await client.runs.retrieve(recordedId, { project_id: project.id, selects: ["ID", "NAME", "TOTAL_TOKENS"] });
    assert.equal(run.name, name);
    assert.equal(run.total_tokens ?? 0, 0);
    console.log("LangSmith returned the recorded cache-hit run with zero tokens.");
  } else {
    console.log("Tracing not configured; live trace verification skipped.");
  }
}

main().catch(error => {
  // Provider errors may carry request headers; print only a redacted message.
  let message = error instanceof Error ? error.message : "Live AI verification failed.";
  for (const key of ["OPENAI_API_KEY", "LANGSMITH_API_KEY"]) {
    if (process.env[key]) message = message.replaceAll(process.env[key], "[redacted]");
  }
  console.error(message);
  process.exitCode = 1;
});
