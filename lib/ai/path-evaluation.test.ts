import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import test from "node:test";
import { evaluateInventedPaths, PATH_EVALUATOR_VERSION } from "./path-evaluation";

function check(text: string, suppliedPaths: readonly string[], inventedPaths: string[]) {
  const evaluation = evaluateInventedPaths(text, suppliedPaths);
  assert.equal(evaluation.key, "invented_paths");
  assert.equal(evaluation.evaluator, PATH_EVALUATOR_VERSION);
  assert.equal(evaluation.score, inventedPaths.length ? 0 : 1);
  assert.deepEqual(evaluation.inventedPaths, [...inventedPaths].sort());
  assert.deepEqual(evaluation.failures.map(failure => failure.path), evaluation.inventedPaths);
  for (const failure of evaluation.failures) {
    assert.ok(failure.excerpt.includes(failure.path), JSON.stringify(failure));
    assert.ok(text.includes(failure.excerpt), JSON.stringify(failure));
  }
  return evaluation;
}

test("invented-path evaluation uses exact supplied membership and deduplicates references", () => {
  const text = "`src/known.ts` calls src/missing.ts, then `src/missing.ts` and `root.json`.";
  const evaluation = check(text, ["src/known.ts", "src/unmentioned.ts"], ["root.json", "src/missing.ts"]);
  assert.deepEqual(evaluation.mentionedPaths, ["root.json", "src/known.ts", "src/missing.ts"]);
  assert.deepEqual(evaluateInventedPaths(text, ["src/known.ts", "src/unmentioned.ts"]), evaluation);
  check("`src/Known.ts` and `src/known.tsx` differ from `src/known.ts`.", ["src/known.ts"], ["src/Known.ts", "src/known.tsx"]);
  assert.deepEqual(check("No file references here.", [], []).mentionedPaths, []);
});

test("an existing repository file is invented when the model was not supplied that path", () => {
  assert.ok(existsSync(new URL("./operations.ts", import.meta.url)));
  check("The implementation is in `lib/ai/operations.ts`.", ["lib/ai/client.ts"], ["lib/ai/operations.ts"]);
  check("The implementation is in `lib/ai/operations.ts`.", ["lib/ai/operations.ts"], []);
});

test("raw Markdown link labels and destinations are evaluated before rendering can discard them", () => {
  check("Read [implementation](src/invented.ts).", ["src/known.ts"], ["src/invented.ts"]);
  check("Read [implementation](src/known.ts).", ["src/known.ts"], []);
  check("[src/label.ts](src/destination.ts)", [], ["src/destination.ts", "src/label.ts"]);
  check("![diagram](docs/invented.svg)", ["src/known.ts"], ["docs/invented.svg"]);
});

test("Windows separators remain literal and cannot stand in for a supplied POSIX path", () => {
  const windows = String.raw`src\nested\value.ts`;
  check(`Reads \`${windows}\`.`, ["src/nested/value.ts"], [windows]);
  assert.deepEqual(check(`Reads \`${windows}\`.`, [windows], []).mentionedPaths, [windows]);
  const absolute = String.raw`C:\repo\invented.ts`;
  check(`Reads \`${absolute}\`.`, ["src/value.ts"], [absolute]);
});

test("Unicode paths and emoji prefixes preserve the exact failing path and excerpt offsets", () => {
  const supplied = "源代码/处理.ts";
  const invented = "源代码/不存在.ts";
  const prefix = `${"before ".repeat(15)}😀🚀 读取 `;
  const suffix = ` after ${"context ".repeat(15)}`;
  const text = `${prefix}\`${supplied}\` then \`${invented}\`${suffix}`;
  const evaluation = check(text, [supplied], [invented]);
  const index = text.indexOf(invented);
  assert.equal(evaluation.failures[0].excerpt, text.slice(index - 60, index + invented.length + 60));
  assert.deepEqual(evaluation.mentionedPaths, [invented, supplied].sort());
});

test("literal brackets, route groups and spaces are preserved in exact supplied file paths", () => {
  const paths = ["app/(admin)/[id]/page.tsx", "src/my feature/[detail].ts", "src/emoji-😀.ts"];
  const evaluation = check(paths.map(path => `Reads \`${path}\`.`).join("\n"), paths, []);
  assert.deepEqual(evaluation.mentionedPaths, [...paths].sort());
  check("Reads `app/(admin)/[id]/missing.ts`.", paths, ["app/(admin)/[id]/missing.ts"]);
  check("Reads `src/my feature/[missing].ts`.", paths, ["src/my feature/[missing].ts"]);
});

test("sentence punctuation is removed without changing literal terminal filename characters", () => {
  for (const punctuation of [".", ",", ";", ":", "!", "?"]) {
    check(`Reads src/value.ts${punctuation}`, ["src/value.ts"], []);
    check(`Reads src/missing.ts${punctuation}`, ["src/value.ts"], ["src/missing.ts"]);
  }
  for (const path of ["src/value.ts.", "src/value.ts-", "src/value.ts..", "src/trailing./value.ts"]) {
    assert.deepEqual(check(`Reads \`${path}\`.`, [path], []).mentionedPaths, [path]);
    check(`Reads \`${path}\`.`, [], [path]);
  }
});

test("framework names, familiar slash prose and supplied folders do not become invented files", () => {
  const paths = ["src/nested/value.ts", "src/trailing./value.ts"];
  const text = "Next.js, Node.js, Nest.js, Nuxt.js, Vue.js, Express.js, React.js and Svelte.js support " +
    "client/server request/response read/write input/output and/or GET/POST/DELETE workflows in `src/nested` and src/trailing..";
  assert.deepEqual(check(text, paths, []).mentionedPaths, []);
  check("Reads `Node.js`.", ["Node.js"], []);
  for (const path of ["unknown/folder", "src/nested-", "src/Next.js", "src/nested/missing.ts"]) {
    check(`Reads \`${path}\`.`, paths, [path]);
  }
});
