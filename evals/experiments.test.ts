import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import test from "node:test";
import { Client, type Example } from "langsmith";
import type { ExampleCreate } from "langsmith/schemas";
import { PINNED_MODEL, PROMPT_VERSION } from "../lib/ai/config";
import { EXPLAIN_PROMPT } from "../lib/ai/operations";
import { comparePrompts, evaluateRoles, validateJudge } from "./experiments";
import { PREVIOUS_EXPLAIN_PROMPT, PREVIOUS_PROMPT_VERSION, USEFULNESS_JUDGE_PROMPT } from "./prompts";

function assertRecord(value: unknown): asserts value is Record<string, unknown> {
  assert.ok(value !== null && typeof value === "object" && !Array.isArray(value));
}

function explanationInput(path: string) {
  const content = "export const value = 1;";
  return {
    target: { kind: "file", path }, framework: "generic", members: [path], folders: ["src"],
    files: [{ path, contentHash: createHash("sha256").update(content).digest("hex"),
      exports: ["value"], lineCount: 1, role: null }],
    edges: [], sources: [{ path, content }],
  };
}

test("judge validation rejects malformed scores rather than producing misleading aggregates", () => {
  for (const score of [-1, 5, 1.5, NaN, Infinity, "4", null, undefined]) {
    assert.throws(() => validateJudge({ score, reason: "Evidence" }), /invalid score or reason/);
  }
  for (const reason of ["", "  ", null, undefined, 4]) {
    assert.throws(() => validateJudge({ score: 4, reason }), /invalid score or reason/);
  }
  for (const score of [0, 1, 2, 3, 4]) {
    assert.deepEqual(validateJudge({ score, reason: "Grounded evidence" }), { score, reason: "Grounded evidence" });
  }
});

test("experiment orchestration uses frozen inputs, blind judging, and complete aggregates", async t => {
  const environment = {
    OPENAI_API_KEY: "synthetic-experiment-key", OPENAI_BASE_URL: "http://127.0.0.1:34567/v1",
    OPENAI_MODEL: PINNED_MODEL, LANGSMITH_TRACING: "false",
  };
  const original = new Map(Object.keys(environment).map(name => [name, process.env[name]]));
  for (const [name, value] of Object.entries(environment)) process.env[name] = value;
  t.after(() => {
    for (const [name, value] of original) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });

  type Arguments = { inputs: Record<string, unknown>; outputs: Record<string, unknown>; referenceOutputs?: Record<string, unknown> };
  type Options = { data: Example[]; evaluators: ((args: Arguments) => unknown)[]; experimentPrefix: string; metadata: Record<string, unknown> };
  type Target = (input: Record<string, unknown>) => Promise<Record<string, unknown>>;
  type Score = { key: string; score?: unknown };
  const experiments: Options[] = [];
  let failure: "none" | "partial" | "run" | "missing score" = "none";
  const runner = async (target: Target, options: Options) => {
    experiments.push(options);
    return {
      experimentName: `${options.experimentPrefix}-synthetic`,
      async *[Symbol.asyncIterator]() {
        const data = failure === "partial" ? options.data.slice(0, -1) : options.data;
        for (const example of data) {
          const outputs = await target(example.inputs);
          const results: Score[] = [];
          for (const evaluator of options.evaluators) {
            const result: unknown = await evaluator({ inputs: example.inputs, outputs, referenceOutputs: example.outputs });
            assertRecord(result);
            assert.equal(typeof result.key, "string");
            if (typeof result.key !== "string") assert.fail("An evaluation must have a key.");
            results.push({ key: result.key, score: result.score });
          }
          yield { example, run: { error: failure === "run" ? "Synthetic target failure" : null },
            evaluationResults: { results: failure === "missing score" ? [] : results } };
        }
      },
    };
  };
  // The installed CJS SDK exposes evaluate as a configurable getter. Replace
  // that boundary in this isolated test process; app targets/evaluators stay real.
  const require = createRequire(import.meta.url);
  const sdk: { evaluate: unknown } = require("langsmith/evaluation");
  t.mock.getter(sdk, "evaluate", () => runner);

  const inputs = [explanationInput("src/one.ts"), explanationInput("src/two.ts")];
  const logs: string[] = [];
  const tables: unknown[] = [];
  t.mock.method(console, "log", (...values: unknown[]) => { logs.push(values.map(String).join(" ")); });
  t.mock.method(console, "error", () => {});
  t.mock.method(console, "table", (value: unknown) => { tables.push(value); });
  const client = new Client({ apiKey: "synthetic-client-key", apiUrl: "http://127.0.0.1:34568" });
  let datasetReads = 0;
  t.mock.method(client, "listRuns", async function* () {
    datasetReads += 1;
    for (const [index, input] of inputs.entries()) {
      yield { id: `record-${index}`, session_id: "source-project", name: "explanation-answer", run_type: "chain",
        inputs: input, outputs: { markdown: `Recorded \`${input.target.path}\`.` }, extra: {}, error: null, parent_run_id: null };
    }
  });
  t.mock.method(client, "createDataset", async () => ({ id: "synthetic-dataset" }));
  t.mock.method(client, "createExamples", async (values: ExampleCreate[]): Promise<Example[]> => values.map((value, index) => ({
    id: `example-${index}`, dataset_id: "synthetic-dataset", inputs: value.inputs, outputs: value.outputs,
    source_run_id: value.source_run_id, created_at: "2026-01-01T00:00:00Z", runs: [],
  })));

  const explanationCalls: { prompt: string; input: unknown }[] = [];
  const judgeCalls: Record<string, unknown>[] = [];
  const roleCalls: Record<string, unknown>[][] = [];
  t.mock.method(globalThis, "fetch", async (input: string | URL | Request, init?: RequestInit) => {
    const request = new Request(input, init);
    assert.equal(request.url, `${environment.OPENAI_BASE_URL}/chat/completions`, "No external service may be contacted.");
    const body: unknown = await request.json();
    assertRecord(body);
    assert.equal(body.model, PINNED_MODEL);
    assert.ok(Array.isArray(body.messages));
    const messages: unknown[] = body.messages;
    const system = messages[0];
    const user = messages[1];
    assertRecord(system);
    assertRecord(user);
    assert.equal(typeof user.content, "string");
    if (typeof user.content !== "string") assert.fail("Expected serialized provider input.");
    const payload: unknown = JSON.parse(user.content);
    let output: unknown;
    if (system.content === USEFULNESS_JUDGE_PROMPT) {
      assertRecord(payload);
      assert.deepEqual(Object.keys(payload).sort(), ["context", "explanation"]);
      judgeCalls.push(payload);
      output = { score: String(payload.explanation).startsWith("Specific") ? 4 : 2, reason: "Synthetic grounded evidence" };
    } else if (system.content === EXPLAIN_PROMPT || system.content === PREVIOUS_EXPLAIN_PROMPT) {
      assertRecord(payload);
      explanationCalls.push({ prompt: String(system.content), input: payload });
      const selected = payload.target;
      assertRecord(selected);
      output = { markdown: `${system.content === EXPLAIN_PROMPT ? "Specific" : "Generic"} explanation of \`${String(selected.path)}\`.` };
    } else {
      assert.ok(Array.isArray(payload));
      const files: Record<string, unknown>[] = payload.map((file: unknown) => {
        assertRecord(file);
        assert.deepEqual(Object.keys(file).sort(), ["content", "contentHash", "path"]);
        return file;
      });
      roleCalls.push(files);
      output = { roles: files.map(file => ({ file: file.path, role: "util" })) };
    }
    return Response.json({ id: "synthetic", object: "chat.completion", created: 0, model: PINNED_MODEL,
      choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: JSON.stringify(output) } }] });
  });

  await t.test("two independent prompt experiments replay the same frozen examples and hide versions from the judge", async () => {
    await comparePrompts(client, "source-project", 2);
    assert.equal(datasetReads, 1);
    assert.equal(experiments.length, 2);
    assert.strictEqual(experiments[0].data, experiments[1].data);
    assert.deepEqual(experiments.map(experiment => experiment.metadata.prompt_version), [PREVIOUS_PROMPT_VERSION, PROMPT_VERSION]);
    assert.deepEqual(explanationCalls.map(call => call.prompt), [PREVIOUS_EXPLAIN_PROMPT, PREVIOUS_EXPLAIN_PROMPT, EXPLAIN_PROMPT, EXPLAIN_PROMPT]);
    assert.deepEqual(explanationCalls.slice(0, 2).map(call => call.input), inputs);
    assert.deepEqual(explanationCalls.slice(2).map(call => call.input), inputs);
    assert.equal(judgeCalls.length, 4);
    for (const [index, call] of judgeCalls.entries()) assert.deepEqual(call.context, inputs[index % inputs.length]);
    assert.equal(tables.length, 1);
    assert.ok(logs.some(log => log.includes("50.0 percentage points higher on subjective usefulness")));
  });

  for (const scenario of ["partial", "run", "missing score"] as const) {
    await t.test(`${scenario} experiment output cannot produce an aggregate comparison`, async () => {
      failure = scenario;
      const previousTables = tables.length;
      const previousExperiments = experiments.length;
      await assert.rejects(comparePrompts(client, "source-project", 2), scenario === "partial" ? /no partial aggregate/ : scenario === "run" ? /Synthetic target failure/ : /no valid invented_paths score/);
      assert.equal(tables.length, previousTables);
      assert.equal(experiments.length, previousExperiments + 1, "A failed first experiment must stop the comparison.");
    });
  }

  await t.test("role accuracy uses the production classifier with hidden gold labels and reports every example", async () => {
    failure = "none";
    await evaluateRoles(client);
    const experiment = experiments.at(-1);
    assert.ok(experiment);
    assert.ok(experiment.data.length >= 30);
    assert.equal(experiment.experimentPrefix, "cartograph-role-accuracy");
    assert.equal(roleCalls.flat().length, experiment.data.length);
    assert.ok(experiment.data.every(example => !Object.hasOwn(example.inputs, "expectedRole") && example.outputs?.role));
    assert.ok(logs.some(log => log.includes(`Role accuracy: 0.0% (${experiment.data.length} files)`)));
  });
});
