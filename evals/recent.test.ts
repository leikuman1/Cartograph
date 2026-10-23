import assert from "node:assert/strict";
import test from "node:test";
import { Client } from "langsmith";
import type { Run } from "langsmith/schemas";
import type { ExplanationInput } from "../lib/ai/operations";
import { decodeRecordedExplanation, parseExplanationInput, recentExplanations, type RecordedExplanationRun } from "./recent";

function input(kind: "file" | "folder" = "file"): ExplanationInput {
  const members = kind === "file" ? ["src/entry.ts"] : ["src/entry.ts", "src/helper.ts"];
  return {
    target: { kind, path: kind === "file" ? "src/entry.ts" : "src" }, framework: "express",
    members, folders: ["src"],
    files: ["src/entry.ts", "src/helper.ts", "main.ts"].map(path => ({ path, contentHash: "a".repeat(64),
      lineCount: 1, exports: path === "src/helper.ts" ? ["helper"] : [], role: path === "src/entry.ts" ? "controller" : null })),
    edges: [{ source: "src/entry.ts", target: "src/helper.ts", kinds: ["import"] },
      { source: "main.ts", target: "src/entry.ts", kinds: ["require"] }],
    sources: members.map(path => ({ path, content: path === "src/entry.ts" ? "import { helper } from './helper'; helper();" : "export function helper() {}" })),
  };
}

function answer(id: string, values = input()): RecordedExplanationRun {
  return { id, session_id: "production-project", name: "explanation-answer", run_type: "chain", inputs: { ...values },
    outputs: { markdown: "Uses `src/helper.ts`.", evaluation: { score: 1 } } };
}

function legacy(id: string, values = input(), name = "chat.completions.create"): RecordedExplanationRun {
  return { id, session_id: "production-project", name, run_type: "llm", inputs: {
    messages: [{ role: "system", content: "You explain a parsed repository to a developer. Previous prompt wording." },
      { role: "user", content: JSON.stringify(values) }], model: "recorded-model",
  }, outputs: { choices: [{ finish_reason: "stop", message: { content: JSON.stringify({ markdown: "Uses `src/helper.ts`." }) } }] } };
}

function listed(run: RecordedExplanationRun): Run {
  return { ...run, inputs: run.inputs };
}

function offlineClient() {
  return new Client({ apiKey: "offline-test-key", apiUrl: "https://langsmith.invalid",
    fetchImplementation: async () => { throw new Error("Recent explanation tests must not call external services."); } });
}

test("recorded file and folder inputs preserve supplied parser facts and complete source content", () => {
  for (const kind of ["file", "folder"] as const) {
    assert.deepEqual(parseExplanationInput(input(kind)), input(kind));
    const values = input(kind);
    values.sources[0].content = "";
    values.files[0].lineCount = 0;
    assert.deepEqual(parseExplanationInput(values), values);
  }
  const root = input("folder");
  root.target.path = ".";
  assert.deepEqual(parseExplanationInput(root), root);
});

test("recorded input rejects malformed fields instead of treating absent file sets as a perfect score", () => {
  const invalid: unknown[] = [
    null, [], {}, { ...input(), target: { kind: "package", path: "src" } },
    { ...input(), target: { kind: "file", path: "../entry.ts" } },
    { ...input(), target: { kind: "folder", path: "/src" } },
    { ...input(), target: { kind: "file", path: "C:/src/entry.ts" } },
    { ...input(), framework: "invented-framework" }, { ...input(), members: [] },
    { ...input(), files: [] }, { ...input(), folders: null },
    { ...input(), members: ["src/entry.ts", "src/entry.ts"] },
    { ...input(), files: [input().files[0], input().files[0]] },
    { ...input(), files: [{ ...input().files[0], contentHash: "not-a-hash" }] },
    { ...input(), files: [{ ...input().files[0], lineCount: -1 }] },
    { ...input(), files: [{ ...input().files[0], role: "invented-role" }] },
    { ...input(), files: [{ ...input().files[0], exports: [null] }] },
    { ...input(), files: [{ ...input().files[0], path: "src\\entry.ts" }] },
    { ...input(), edges: [{ source: "src/entry.ts", target: "absent.ts", kinds: ["import"] }] },
    { ...input(), edges: [{ source: "main.ts", target: "src/helper.ts", kinds: ["import"] }] },
    { ...input(), edges: [{ source: "src/entry.ts", target: "src/helper.ts", kinds: ["guessed"] }] },
    { ...input(), edges: [{ source: "src/entry.ts", target: "src/helper.ts", kinds: [] }] },
    { ...input(), sources: [] }, { ...input(), sources: [{ path: "absent.ts", content: "" }] },
    { ...input(), sources: [{ path: "src/entry.ts", content: null }] },
    { ...input(), target: { kind: "file", path: "src/helper.ts" } },
    { ...input("folder"), target: { kind: "folder", path: "unrelated" } },
  ];
  for (const value of invalid) assert.throws(() => parseExplanationInput(value), Error);
});

test("new answer traces and historical OpenAI traces decode both target kinds", () => {
  for (const kind of ["file", "folder"] as const) {
    for (const run of [answer("new", input(kind)), legacy("old", input(kind)),
      legacy("wrapped", input(kind), "ChatOpenAI"), legacy("azure", input(kind), "AzureChatOpenAI")]) {
      assert.deepEqual(decodeRecordedExplanation(run), {
        id: run.id, sessionId: "production-project", input: input(kind), markdown: "Uses `src/helper.ts`.",
      });
    }
  }
  // An actual invented path must survive decoding so the evaluator can flag it.
  const hallucinated = answer("invented");
  hallucinated.outputs = { markdown: "Calls `fiction.ts`." };
  assert.equal(decodeRecordedExplanation(hallucinated).markdown, "Calls `fiction.ts`.");
});

test("cache wrappers, classifications, judges, eval traffic, and incomplete outputs are excluded", () => {
  const invalid = [
    { ...answer("cache"), name: "explain-file", outputs: { value: { blocks: [] }, cacheHit: true } },
    { ...answer("folder-cache"), name: "explain-folder", outputs: { markdown: "Cached text", cacheHit: true } },
    { ...legacy("classification"), inputs: { messages: [
      { role: "system", content: "Classify source files whose framework adapter assigned no role." },
      { role: "user", content: JSON.stringify(input()) },
    ] } },
    { ...legacy("judge"), inputs: { messages: [
      { role: "system", content: "Judge usefulness. You explain a parsed repository" },
      { role: "user", content: JSON.stringify(input()) },
    ] } },
    { ...answer("eval"), extra: { metadata: { origin: "eval" } } },
    { ...legacy("legacy-eval"), extra: { metadata: { origin: "eval" } } },
    { ...answer("failed"), error: "Provider failed" },
    { ...answer("missing"), outputs: undefined },
    { ...answer("blank"), outputs: { markdown: "  " } },
    { ...answer("document"), outputs: { blocks: [] } },
    { ...answer("no-project"), session_id: undefined },
    { ...legacy("no-completion"), outputs: { choices: [] } },
    { ...legacy("unfinished"), outputs: { choices: [{ finish_reason: "length", message: { content: '{"markdown":"Partial"}' } }] } },
    { ...legacy("bad-json"), outputs: { choices: [{ message: { content: "invalid json" } }] } },
    { ...legacy("empty-markdown"), outputs: { choices: [{ message: { content: '{"markdown":""}' } }] } },
    { ...legacy("no-input"), inputs: { messages: [] } },
    { ...legacy("invalid-input-json"), inputs: { messages: [
      { role: "system", content: "You explain a parsed repository" }, { role: "user", content: "invalid json" },
    ] } },
  ];
  for (const run of invalid) assert.throws(() => decodeRecordedExplanation(run), Error, run.id);
});

test("recent reader uses a bounded descending list with full I/O and prefers new answer spans to legacy children", async t => {
  const client = offlineClient();
  const calls: Parameters<Client["listRuns"]>[0][] = [];
  const messages: string[] = [];
  t.mock.method(console, "error", (message: string) => { messages.push(message); });
  t.mock.method(client, "readRun", async () => { assert.fail("Listing explanations must not fetch each run individually."); });
  const rows = [legacy("child", input(), "ChatOpenAI"), answer("parent"),
    { ...answer("evaluation"), extra: { metadata: { origin: "eval" } } },
    { ...answer("missing-output"), outputs: undefined }, legacy("historical-folder", input("folder")),
    { ...answer("cache"), name: "explain-file" }, answer("older"), answer("older")];
  rows[0].parent_run_id = "parent";
  t.mock.method(client, "listRuns", async function* (options: Parameters<Client["listRuns"]>[0]) {
    calls.push(options);
    for (const row of rows) yield listed(row);
  });
  const results = await recentExplanations(client, "real-project", 3);
  assert.deepEqual(results.map(result => result.id), ["parent", "historical-folder", "older"]);
  assert.equal(results[1].input.target.kind, "folder");
  assert.equal(calls.length, 1);
  const options = calls[0];
  assert.equal(options.projectName, "real-project");
  assert.equal(options.order, "desc");
  assert.equal(options.limit, 15);
  for (const name of ["explanation-answer", "chat.completions.create", "ChatOpenAI", "You explain a parsed repository"]) {
    assert.ok(options.filter?.includes(name));
  }
  for (const field of ["inputs", "outputs", "session_id", "extra", "parent_run_id"]) assert.ok(options.select?.includes(field));
  assert.deepEqual(messages, ["Recent explanations: selected 3 of 3 usable; skipped 5 of 8 inspected runs (excluded, malformed, or duplicate)."]);
});

test("recent reader reports missing data and fails when no generated explanation is usable", async t => {
  const client = offlineClient();
  const messages: string[] = [];
  t.mock.method(console, "error", (message: string) => { messages.push(message); });
  t.mock.method(client, "listRuns", async function* () {
    yield listed({ ...answer("missing"), outputs: {} });
    yield listed({ ...answer("cache"), name: "explain-folder" });
  });
  await assert.rejects(recentExplanations(client, "empty-project"), /No usable generated explanations.*skipped 2 of 2/);
  assert.match(messages[0], /selected 0 of 0 usable; skipped 2 of 2/);
});

test("recent reader limits scans, applies the default count, and propagates API failures", async t => {
  const client = offlineClient();
  const calls: Parameters<Client["listRuns"]>[0][] = [];
  let inspected = 0;
  t.mock.method(console, "error", () => {});
  t.mock.method(client, "listRuns", async function* (options: Parameters<Client["listRuns"]>[0]) {
    calls.push(options);
    for (let index = 0; index < 101; index += 1) {
      inspected += 1;
      yield listed(answer(`answer-${index}`));
    }
  });
  const results = await recentExplanations(client, "real-project");
  assert.equal(results.length, 20);
  assert.equal(inspected, 100);
  assert.equal(calls[0].limit, 100);
  await assert.rejects(recentExplanations(client, "real-project", 0), /positive integer/);
  await assert.rejects(recentExplanations(client, "real-project", 1.5), /positive integer/);
  await assert.rejects(recentExplanations(client, " "), /must not be empty/);
  assert.equal(calls.length, 1);

  t.mock.method(client, "listRuns", () => { throw new Error("LangSmith unavailable"); });
  await assert.rejects(recentExplanations(client, "real-project"), /LangSmith unavailable/);
});
