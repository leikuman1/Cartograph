import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { Client } from "langsmith";
import type { Run } from "langsmith/schemas";
import { Completions } from "openai/resources/chat/completions";
import { parseArguments, run } from "./evaluate";
import { validateJudge } from "../evals/experiments";
import { PINNED_MODEL } from "../lib/ai/config";
import type { ExplanationInput } from "../lib/ai/operations";

const environmentNames = [
  "OPENAI_API_KEY", "OPENAI_BASE_URL", "OPENAI_MODEL", "LANGSMITH_TRACING",
  "LANGSMITH_API_KEY", "LANGSMITH_PROJECT", "LANGSMITH_ENDPOINT",
] as const;
type Environment = Partial<Record<(typeof environmentNames)[number], string>>;

async function withEnvironment(values: Environment, check: () => Promise<void>) {
  const original = new Map(environmentNames.map(name => [name, process.env[name]]));
  const exitCode = process.exitCode;
  try {
    for (const name of environmentNames) {
      const value = values[name];
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    process.exitCode = undefined;
    await check();
  } finally {
    for (const [name, value] of original) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    process.exitCode = exitCode;
  }
}

const tracingEnvironment = {
  LANGSMITH_TRACING: "true", LANGSMITH_API_KEY: "synthetic-tracing-key",
  LANGSMITH_PROJECT: " offline-recorded-paths ", LANGSMITH_ENDPOINT: "https://langsmith.invalid",
};
const invalidProviderConfigurations = [
  { values: {}, error: /Set OPENAI_API_KEY and OPENAI_BASE_URL/ },
  { values: { OPENAI_API_KEY: "synthetic-provider-key" }, error: /Set OPENAI_BASE_URL/ },
  { values: { OPENAI_API_KEY: "synthetic-provider-key", OPENAI_BASE_URL: "https://provider.invalid/v1", OPENAI_MODEL: "another-model" },
    error: /OPENAI_MODEL must match PINNED_MODEL/ },
  { values: { OPENAI_API_KEY: "synthetic-provider-key", OPENAI_BASE_URL: "not-a-url" },
    error: /OPENAI_BASE_URL must be an absolute HTTPS API URL/ },
] satisfies { values: Environment; error: RegExp }[];

const recordedInput: ExplanationInput = {
  target: { kind: "file", path: "src/entry.ts" }, framework: "generic",
  members: ["src/entry.ts"], folders: ["src"],
  files: [{ path: "src/entry.ts", contentHash: "a".repeat(64), lineCount: 1, role: null, exports: ["entry"] }],
  edges: [], sources: [{ path: "src/entry.ts", content: "export const entry = 1;" }],
};

const recordedRuns: Run[] = [
  { id: "synthetic-valid-run", session_id: "synthetic-project", name: "explanation-answer", run_type: "chain",
    inputs: { ...recordedInput }, outputs: { markdown: "Defines `src/entry.ts`." } },
  { id: "synthetic-invented-run", session_id: "synthetic-project", name: "explanation-answer", run_type: "chain",
    inputs: { ...recordedInput }, outputs: { markdown: "Uses `src/fictional.ts`." } },
];

function command(script: string, args: string[]) {
  const pnpm = process.env.npm_execpath;
  assert.ok(pnpm, "Run this check with pnpm test:evals so documented pnpm invocations are exercised.");
  const executable = /\.exe$/i.test(pnpm) ? pnpm : process.execPath;
  const commandArgs = /\.exe$/i.test(pnpm) ? [script, ...args] : [pnpm, script, ...args];
  return spawnSync(executable, commandArgs, {
    cwd: fileURLToPath(new URL("../", import.meta.url)), encoding: "utf8", timeout: 30000,
  });
}

test("recorded path checks read and score explanations without provider configuration", async t => {
  const logs: string[] = [];
  t.mock.method(console, "log", (...values: unknown[]) => { logs.push(values.map(String).join(" ")); });
  t.mock.method(console, "error", () => {});
  const list = t.mock.method(Client.prototype, "listRuns", async function* (options: Parameters<Client["listRuns"]>[0]) {
    assert.equal(options?.projectName, "offline-recorded-paths");
    assert.equal(options?.limit, 100);
    yield* recordedRuns;
  });
  const feedback: { runId: string; sessionId: string; key: string; score: number; feedbackSourceType: string; comment: string }[] = [];
  t.mock.method(Client.prototype, "createFeedback", async (value: typeof feedback[number]) => {
    feedback.push(value);
    return value;
  });
  const flush = t.mock.method(Client.prototype, "awaitPendingTraceBatches", async () => {});
  const provider = t.mock.method(Completions.prototype, "create", () => {
    assert.fail("Recorded path evaluation must not call the provider.");
  });
  const fetch = t.mock.method(globalThis, "fetch", async () => {
    assert.fail("Recorded path evaluation tests must not call external services.");
  });

  for (const { values } of invalidProviderConfigurations) {
    const before = feedback.length;
    logs.length = 0;
    await withEnvironment({ ...tracingEnvironment, ...values }, async () => {
      await run(["paths"]);
      assert.equal(process.exitCode, 1, "An invented path must make the command fail.");
    });
    assert.deepEqual(feedback.slice(before).map(value => ({
      runId: value.runId, sessionId: value.sessionId, key: value.key,
      score: value.score, feedbackSourceType: value.feedbackSourceType,
    })), [
      { runId: "synthetic-valid-run", sessionId: "synthetic-project", key: "invented_paths", score: 1, feedbackSourceType: "api" },
      { runId: "synthetic-invented-run", sessionId: "synthetic-project", key: "invented_paths", score: 0, feedbackSourceType: "api" },
    ]);
    assert.match(feedback[before + 1].comment ?? "", /"inventedPaths":\["src\/fictional\.ts"\]/);
    assert.ok(logs.some(line => line.includes("PASS run=synthetic-valid-run")));
    assert.ok(logs.some(line => line.includes("FAIL run=synthetic-invented-run")));
    assert.ok(logs.some(line => line.includes("src/fictional.ts")));
    assert.ok(logs.some(line => line.includes("50.0% (1/2 recent generated explanations)")));
  }
  assert.equal(list.mock.callCount(), invalidProviderConfigurations.length);
  assert.equal(flush.mock.callCount(), invalidProviderConfigurations.length);
  assert.equal(provider.mock.callCount(), 0);
  assert.equal(fetch.mock.callCount(), 0);
});

test("role and prompt commands still validate provider keys, pinned model and endpoint", async t => {
  const dataset = t.mock.method(Client.prototype, "createDataset", async () => {
    assert.fail("Invalid provider configuration must fail before dataset creation.");
  });
  const list = t.mock.method(Client.prototype, "listRuns", () => {
    assert.fail("Invalid provider configuration must fail before reading runs.");
  });
  const provider = t.mock.method(Completions.prototype, "create", () => {
    assert.fail("Invalid provider configuration must fail before a model call.");
  });
  const fetch = t.mock.method(globalThis, "fetch", async () => {
    assert.fail("Configuration tests must not call external services.");
  });
  for (const { values, error } of invalidProviderConfigurations) {
    await withEnvironment({ ...tracingEnvironment, ...values }, async () => {
      for (const command of ["roles", "prompts"]) await assert.rejects(run([command]), error);
    });
  }
  assert.equal(dataset.mock.callCount(), 0);
  assert.equal(list.mock.callCount(), 0);
  assert.equal(provider.mock.callCount(), 0);
  assert.equal(fetch.mock.callCount(), 0);
});

test("every recorded command requires enabled LangSmith tracing and its API key", async t => {
  const list = t.mock.method(Client.prototype, "listRuns", () => {
    assert.fail("Missing tracing configuration must fail before reading runs.");
  });
  const fetch = t.mock.method(globalThis, "fetch", async () => {
    assert.fail("Missing tracing configuration must fail before any external call.");
  });
  for (const tracing of [
    { LANGSMITH_TRACING: undefined }, { LANGSMITH_TRACING: "false" },
    { LANGSMITH_API_KEY: undefined }, { LANGSMITH_API_KEY: " \t " },
  ]) {
    await withEnvironment({ ...tracingEnvironment, ...tracing, OPENAI_API_KEY: "synthetic-provider-key",
      OPENAI_BASE_URL: "https://provider.invalid/v1", OPENAI_MODEL: PINNED_MODEL }, async () => {
      for (const command of ["paths", "roles", "prompts"]) {
        await assert.rejects(run([command]), /Set LANGSMITH_TRACING=true and LANGSMITH_API_KEY/);
      }
    });
  }
  assert.equal(list.mock.callCount(), 0);
  assert.equal(fetch.mock.callCount(), 0);
});

test("documented path-check commands work with pnpm argument forwarding and return failure for fiction", () => {
  for (const separator of [[], ["--"]]) {
    const result = command("eval:paths", [...separator, "--text", "Reads `src/fictional.ts`.", "--paths", "src/real.ts"]);
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stdout, /"score": 0/);
    assert.match(result.stdout, /"path": "src\/fictional.ts"/);
  }
  const pass = command("eval:paths", ["--text", "Reads `src/real.ts`.", "--paths", "src/real.ts"]);
  assert.equal(pass.status, 0, pass.stderr);
  assert.match(pass.stdout, /"score": 1/);
  for (const script of ["eval:roles", "eval:prompts"]) {
    const help = command(script, ["--help"]);
    assert.equal(help.status, 0, help.stderr);
    assert.match(help.stdout, /Usage:/);
  }
  const bad = command("eval:paths", ["--unknown", "value"]);
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /Unknown option/);
});

test("dataset inspection is a complete offline documented command", () => {
  const result = command("eval:dataset", []);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /36 adapter-labelled source files/);
  assert.match(result.stdout, /No model calls/);
});

test("CLI options and judge outputs fail loudly instead of producing misleading scores", () => {
  for (const args of [[], ["paths", "--limit", "0"], ["paths", "--limit", "101"], ["paths", "--text", "value"],
    ["roles", "--limit", "2"], ["paths", "--limit", "1", "--limit", "2"], ["paths", "--text", "x", "--paths", "a.ts", "--limit", "1"]]) {
    assert.throws(() => parseArguments(args));
  }
  assert.equal(parseArguments(["prompts", "--limit", "2"]).limit, 2);
  for (const value of [null, {}, { score: 5, reason: "wrong scale" }, { score: 1.5, reason: "fraction" }, { score: 4, reason: "" }]) {
    assert.throws(() => validateJudge(value), /invalid score/);
  }
  assert.deepEqual(validateJudge({ score: 3, reason: "Concrete supplied dependency coverage." }), { score: 3, reason: "Concrete supplied dependency coverage." });
});
