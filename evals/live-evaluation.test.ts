import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { Client } from "langsmith";
import { getCurrentRunTree } from "langsmith/traceable";
import type { AnalysisResult, FileNode } from "../lib/parser/contract";
import type { AiCache } from "../lib/ai/cache";
import { flushTraces } from "../lib/ai/client";
import { PINNED_MODEL } from "../lib/ai/config";
import { explainSnapshot } from "../lib/ai/operations";
import { evaluateInventedPaths } from "../lib/ai/path-evaluation";

const ENTRY_SOURCE = 'import { service } from "./service";\nexport const entry = service;';

function graph(): AnalysisResult {
  const sources = new Map([
    ["src/entry.ts", ENTRY_SOURCE],
    ["src/service.ts", "export const service = () => 1;"],
    ["src/unseen.ts", "export const unused = true;"],
  ]);
  const files: FileNode[] = [...sources].map(([path, content]) => ({
    path, folder: "src", module: ".", lineCount: content.split("\n").length,
    contentHash: createHash("sha256").update(content).digest("hex"),
    fanIn: path === "src/service.ts" ? 1 : 0, fanOut: path === "src/entry.ts" ? 1 : 0,
    exports: [],
  }));
  return {
    schemaVersion: 1, framework: "generic", frameworkEntries: [], fileRoles: [], routes: [], files,
    edges: [{ source: "src/entry.ts", target: "src/service.ts", kinds: ["import"] }],
    imports: [{ source: "src/entry.ts", specifier: "./service", kind: "import", line: 1,
      resolution: { status: "internal", target: "src/service.ts" } }],
    coverage: {
      files: { discovered: 3, parsed: 3, skipped: 0, skippedFiles: [], excludedDirectories: [] },
      imports: { discovered: 1, internal: 1, external: 0, unresolved: 0, excluded: 0 },
    },
  };
}

function assertRecord(value: unknown): asserts value is Record<string, unknown> {
  assert.ok(value !== null && typeof value === "object" && !Array.isArray(value));
}

test("real explanation traffic evaluates raw provider answers inside traces and preserves cache hits", async t => {
  const environment = {
    OPENAI_API_KEY: "synthetic-provider-key", OPENAI_BASE_URL: "http://127.0.0.1:34567/v1",
    OPENAI_MODEL: PINNED_MODEL, LANGSMITH_TRACING: "true", LANGSMITH_API_KEY: "synthetic-tracing-key",
    LANGSMITH_PROJECT: "offline-live-evaluation-test", LANGSMITH_ENDPOINT: "http://127.0.0.1:34568",
  };
  const original = new Map(Object.keys(environment).map(name => [name, process.env[name]]));
  for (const [name, value] of Object.entries(environment)) process.env[name] = value;
  t.after(() => {
    for (const [name, value] of original) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });

  type RunStart = Parameters<Client["createRun"]>[0];
  type RunEnd = Parameters<Client["updateRun"]>[1];
  const starts = new Map<string, RunStart>();
  const ends = new Map<string, RunEnd>();
  const feedback: { runId: string; key: string; score: number; comment: string }[] = [];
  const events: string[] = [];
  // Capture SDK boundaries while keeping the application's actual traceable
  // functions and provider wrapper in use. No tracing service is contacted.
  t.mock.method(Client.prototype, "createRun", async (run: RunStart) => {
    assert.ok(run.id);
    starts.set(run.id, run);
    events.push(`trace:start:${run.name}`);
  });
  t.mock.method(Client.prototype, "updateRun", async (id: string, run: RunEnd) => {
    ends.set(id, run);
    events.push(`trace:end:${run.name}`);
  });
  t.mock.method(Client.prototype, "awaitPendingTraceBatches", async () => {});
  t.mock.method(Client.prototype, "readProject", async () => ({ id: "00000000-0000-4000-8000-000000000001" }));
  t.mock.method(Client.prototype, "createFeedback", async (value: typeof feedback[number]) => {
    feedback.push(value);
    events.push("feedback");
    return value;
  });

  let markdown = "";
  let providerCalls = 0;
  const providerInputs: unknown[] = [];
  t.mock.method(globalThis, "fetch", async (input: string | URL | Request, init?: RequestInit) => {
    const request = new Request(input, init);
    assert.equal(request.url, `${environment.OPENAI_BASE_URL}/chat/completions`, "Only the synthetic provider endpoint may be requested.");
    assert.equal(request.method, "POST");
    const body: unknown = await request.json();
    assertRecord(body);
    assert.equal(body.model, PINNED_MODEL);
    assert.deepEqual(body.response_format, { type: "json_object" });
    assert.ok(Array.isArray(body.messages));
    const messages: unknown[] = body.messages;
    const user = messages[1];
    assertRecord(user);
    assert.equal(user.role, "user");
    assert.equal(typeof user.content, "string");
    if (typeof user.content !== "string") assert.fail("The provider input must be serialized context.");
    providerInputs.push(JSON.parse(user.content));
    providerCalls += 1;
    events.push("provider");
    return Response.json({
      id: `synthetic-${providerCalls}`, object: "chat.completion", created: 0, model: PINNED_MODEL,
      choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: JSON.stringify({ markdown }) } }],
      usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 },
    });
  });

  const analysis = graph();
  const target = { kind: "file", path: "src/entry.ts" } as const;
  const sourceReads: string[] = [];
  const readSource = async (path: string, hash: string) => {
    sourceReads.push(path);
    assert.equal(path, "src/entry.ts", "Only the selected member source is read.");
    assert.equal(hash, analysis.files[0].contentHash);
    return ENTRY_SOURCE;
  };
  function memoryCache() {
    const values = new Map<string, Record<string, unknown>>();
    const cache: AiCache = {
      async read(key) {
        assert.equal(getCurrentRunTree(true)?.name, "explain-file", "Every cache read must happen inside the click's trace.");
        events.push("cache:read");
        return values.get(key) ?? null;
      },
      async write(key, operation, value) {
        assert.equal(operation, "file");
        values.set(key, value);
        events.push("cache:write");
      },
    };
    return { cache, values };
  }
  function answerRun() {
    const run = [...starts.values()].findLast(run => run.name === "explanation-answer");
    assert.ok(run?.id, "The raw answer must have its own trace.");
    const end = ends.get(run.id);
    assert.ok(end?.outputs);
    const evaluation: unknown = end.outputs.evaluation;
    assertRecord(evaluation);
    assert.equal(end.outputs.markdown, markdown);
    return { run, evaluation };
  }

  await t.test("valid output is evaluated, rendered, cached, and restored without another provider or source read", async () => {
    markdown = "`src/entry.ts` delegates to `src/service.ts`.";
    const { cache, values } = memoryCache();
    const first = await explainSnapshot(analysis, target, cache, readSource);
    await flushTraces();
    assert.equal(first.cacheHit, false);
    assert.deepEqual(first.value.blocks[0].children.filter(node => node.kind === "file").map(node => node.path), ["src/entry.ts", "src/service.ts"]);
    assert.equal(values.size, 1);
    assert.equal(providerCalls, 1);
    assert.deepEqual(sourceReads, ["src/entry.ts"]);
    const { run, evaluation } = answerRun();
    assert.deepEqual(evaluation, evaluateInventedPaths(markdown, ["src/entry.ts", "src/service.ts"]));
    assert.deepEqual(feedback.map(value => [value.runId, value.key, value.score]), [[run.id, "invented_paths", 1]]);
    assert.deepEqual(JSON.parse(feedback[0].comment), evaluation);
    const supplied: unknown = providerInputs[0];
    assertRecord(supplied);
    assert.ok(Array.isArray(supplied.files));
    const files: unknown[] = supplied.files;
    assert.deepEqual(files.map(file => { assertRecord(file); return file.path; }), ["src/entry.ts", "src/service.ts"]);
    assert.ok(Array.isArray(supplied.sources));
    assert.equal(supplied.sources.length, 1);
    assert.ok(events.indexOf("feedback") < events.indexOf("cache:write"));

    const previousStarts = starts.size;
    const previousFeedback = feedback.length;
    const previousEvents = events.length;
    assert.deepEqual(await explainSnapshot(analysis, target, cache, async () => assert.fail("A cache hit must not read source.")), { ...first, cacheHit: true });
    await flushTraces();
    assert.equal(providerCalls, 1);
    assert.equal(feedback.length, previousFeedback);
    assert.equal(starts.size, previousStarts + 1);
    assert.deepEqual(events.slice(previousEvents), ["trace:start:explain-file", "cache:read", "trace:end:explain-file"]);
  });

  await t.test("an unsupplied real repository file receives a failure score before formatter rejection", async () => {
    markdown = "`src/entry.ts` imports `src/unseen.ts`.";
    const { cache, values } = memoryCache();
    const previousFeedback = feedback.length;
    const previousEvents = events.length;
    await assert.rejects(explainSnapshot(analysis, target, cache, readSource), /not supplied/);
    await flushTraces();
    const { run, evaluation } = answerRun();
    assert.deepEqual(evaluation, evaluateInventedPaths(markdown, ["src/entry.ts", "src/service.ts"]));
    assert.equal(evaluation.score, 0);
    assert.deepEqual(evaluation.inventedPaths, ["src/unseen.ts"]);
    assert.equal(feedback.length, previousFeedback + 1);
    assert.equal(feedback.at(-1)?.runId, run.id);
    assert.equal(feedback.at(-1)?.score, 0);
    assert.equal(values.size, 0, "Rejected prose must not enter the cache.");
    const recentEvents = events.slice(previousEvents);
    assert.ok(recentEvents.indexOf("feedback") < recentEvents.indexOf("trace:end:explain-file"));
  });

  await t.test("a path hidden in a Markdown destination remains visible to raw-answer evaluation", async () => {
    markdown = "`src/entry.ts` calls [the worker](src/invented.ts).";
    const { cache } = memoryCache();
    const result = await explainSnapshot(analysis, target, cache, readSource);
    await flushTraces();
    const { evaluation } = answerRun();
    assert.equal(evaluation.score, 0);
    assert.deepEqual(evaluation.inventedPaths, ["src/invented.ts"]);
    assert.doesNotMatch(JSON.stringify(result.value), /invented/);
    assert.equal(feedback.at(-1)?.score, 0);
  });

  await t.test("completed feedback clears its deadline timer", async check => {
    check.mock.timers.enable({ apis: ["setTimeout"] });
    const errors: string[] = [];
    check.mock.method(console, "error", (message: string) => { errors.push(message); });
    markdown = "`src/entry.ts` delegates to `src/service.ts`.";
    const { cache, values } = memoryCache();
    await explainSnapshot(analysis, target, cache, readSource);
    assert.equal(values.size, 1);
    check.mock.timers.tick(3000);
    assert.deepEqual(errors, [], "Completed feedback must leave no timeout callback behind.");
  });

  for (const delivery of ["success", "failure"] as const) {
    await t.test(`slow feedback releases the answer and cache before background ${delivery}`, async check => {
      check.mock.timers.enable({ apis: ["setTimeout"] });
      const errors: string[] = [];
      check.mock.method(console, "error", (message: string) => { errors.push(message); });
      let releaseFeedback = () => {};
      const blocked = new Promise<void>(resolve => { releaseFeedback = resolve; });
      let signalStarted = () => {};
      const started = new Promise<void>(resolve => { signalStarted = resolve; });
      let signalFinished = () => {};
      const finished = new Promise<void>(resolve => { signalFinished = resolve; });
      check.mock.method(Client.prototype, "createFeedback", async (value: typeof feedback[number]) => {
        signalStarted();
        await blocked;
        try {
          if (delivery === "failure") throw new Error("Synthetic delayed feedback failure");
          feedback.push(value);
          return value;
        } finally {
          signalFinished();
        }
      });
      markdown = "`src/entry.ts` delegates to `src/service.ts`.";
      const { cache, values } = memoryCache();
      let returned = false;
      const explanation = explainSnapshot(analysis, target, cache, readSource).then(result => {
        returned = true;
        return result;
      });
      await started;
      check.mock.timers.tick(2999);
      await Promise.resolve();
      assert.equal(returned, false);
      assert.equal(values.size, 0);
      check.mock.timers.tick(1);
      const result = await explanation;
      assert.equal(result.cacheHit, false);
      assert.equal(returned, true);
      assert.equal(values.size, 1, "A slow feedback upload must not prevent the cache write.");
      const { evaluation } = answerRun();
      assert.equal(evaluation.score, 1, "The raw evaluation is recorded before feedback is uploaded.");
      assert.equal(errors.length, 1);
      assert.match(errors[0], /3-second wait/);
      releaseFeedback();
      await finished;
      await Promise.resolve();
      if (delivery === "failure") {
        assert.equal(errors.length, 2);
        assert.match(errors[1], /feedback upload failed/);
      } else {
        assert.deepEqual(JSON.parse(feedback.at(-1)?.comment ?? "null"), evaluation);
      }
      check.mock.timers.tick(3000);
      assert.equal(errors.filter(message => message.includes("3-second wait")).length, 1);
    });
  }
});
