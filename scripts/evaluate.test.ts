import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { parseArguments } from "./evaluate";
import { validateJudge } from "../evals/experiments";

function command(script: string, args: string[]) {
  const pnpm = process.env.npm_execpath;
  assert.ok(pnpm, "Run this check with pnpm test:evals so documented pnpm invocations are exercised.");
  const executable = /\.exe$/i.test(pnpm) ? pnpm : process.execPath;
  const commandArgs = /\.exe$/i.test(pnpm) ? [script, ...args] : [pnpm, script, ...args];
  return spawnSync(executable, commandArgs, {
    cwd: fileURLToPath(new URL("../", import.meta.url)), encoding: "utf8", timeout: 30000,
  });
}

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
