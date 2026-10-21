import assert from "node:assert/strict";
import test from "node:test";
import { FRAMEWORKS, frameworkSupportsEntries } from "../frameworks/taxonomy";
import { validateAnalysisResult } from "./serialization";

function snapshot() {
  return {
    schemaVersion: 1,
    framework: "nestjs",
    fileRoles: [{ file: "src/users.controller.ts", role: "controller" }],
    frameworkEntries: [],
    routes: [{ file: "src/users.controller.ts", method: "GET", path: "/api/users/:id", line: 3 }],
    files: [{
      path: "src/users.controller.ts", folder: "src", module: ".", lineCount: 10,
      contentHash: "a".repeat(64), fanIn: 0, fanOut: 0,
    }],
    edges: [], imports: [],
    coverage: {
      files: { discovered: 1, parsed: 1, skipped: 0, skippedFiles: [], excludedDirectories: [] },
      imports: { discovered: 0, internal: 0, external: 0, excluded: 0, unresolved: 0 },
    },
  };
}

test("framework facts survive serialization and both older snapshot shapes normalize entries", () => {
  const current = snapshot();
  assert.deepEqual(validateAnalysisResult(JSON.parse(JSON.stringify(current))), current);
  const { frameworkEntries, ...phase8 } = current;
  assert.deepEqual(frameworkEntries, []);
  assert.deepEqual(validateAnalysisResult(phase8), current);
  const { framework, fileRoles, routes, ...oldSnapshot } = phase8;
  assert.equal(framework, "nestjs");
  assert.equal(fileRoles.length, 1);
  assert.equal(routes.length, 1);
  assert.deepEqual(validateAnalysisResult(oldSnapshot), {
    ...oldSnapshot, framework: "generic", fileRoles: [], frameworkEntries: [], routes: [],
  });
  assert.throws(() => validateAnalysisResult({ ...oldSnapshot, framework: "nestjs" }), /missing field fileRoles/);
  assert.throws(() => validateAnalysisResult({ ...oldSnapshot, frameworkEntries: [] }), /missing field framework/);
  for (const key of ["framework", "fileRoles", "routes"]) {
    const partial = Object.fromEntries(Object.entries(current).filter(([name]) => name !== key));
    assert.throws(() => validateAnalysisResult(partial), new RegExp(`missing field ${key}`));
  }
});

test("special-entry metadata round-trips and rejects malformed or inconsistent facts", () => {
  const paths = ["packages/web/app/error.tsx", "packages/web/app/icon2.tsx"];
  const current = {
    ...snapshot(), framework: FRAMEWORKS.find(frameworkSupportsEntries), fileRoles: [], routes: [], frameworkEntries: paths,
    files: paths.map(file => ({ ...snapshot().files[0], path: file, folder: "packages/web/app", module: "packages/web" })),
    coverage: { ...snapshot().coverage,
      files: { ...snapshot().coverage.files, discovered: 2, parsed: 2 } },
  };
  assert.deepEqual(validateAnalysisResult(JSON.parse(JSON.stringify(current))), current);
  const { frameworkEntries, ...phase8 } = current;
  assert.equal(frameworkEntries.length, 2);
  assert.deepEqual(validateAnalysisResult(phase8), { ...phase8, frameworkEntries: [] });
  for (const framework of ["generic", "react", "nestjs"]) {
    assert.throws(() => validateAnalysisResult({ ...current, framework }), /cannot have special entries/);
  }
  for (const frameworkEntries of [null, "app/error.tsx", [null], [42], [""], ["../error.tsx"], ["app\\error.tsx"]]) {
    assert.throws(() => validateAnalysisResult({ ...current, frameworkEntries }), /frameworkEntries/);
  }
  assert.throws(() => validateAnalysisResult({ ...current, frameworkEntries: ["missing.ts"] }), /not parsed/);
  assert.throws(() => validateAnalysisResult({ ...current, frameworkEntries: [...paths, paths[1]] }), /duplicate/);
  assert.throws(() => validateAnalysisResult({ ...current, frameworkEntries: [...paths].reverse() }), /not stably sorted/);
});

test("framework metadata rejects missing files, unsupported roles, and fabricated source locations", () => {
  const current = snapshot();
  assert.throws(() => validateAnalysisResult({ ...current, fileRoles: [{ file: "missing.ts", role: "controller" }] }), /not parsed/);
  assert.throws(() => validateAnalysisResult({ ...current, fileRoles: [{ file: current.files[0].path, role: "page" }] }), /does not belong/);
  assert.throws(() => validateAnalysisResult({ ...current, fileRoles: [...current.fileRoles, ...current.fileRoles] }), /duplicate/);
  assert.throws(() => validateAnalysisResult({ ...current, routes: [{ ...current.routes[0], file: "missing.ts" }] }), /not parsed/);
  assert.throws(() => validateAnalysisResult({ ...current, routes: [{ ...current.routes[0], line: 11 }] }), /exceeds/);
  assert.throws(() => validateAnalysisResult({ ...current, routes: [{ ...current.routes[0], method: "ALL" }] }), /unknown HTTP method/);
  assert.throws(() => validateAnalysisResult({ ...current, routes: [{ ...current.routes[0], path: "users" }] }), /absolute route pattern/);
  assert.throws(() => validateAnalysisResult({ ...current, routes: [...current.routes, ...current.routes] }), /duplicate/);
  assert.throws(() => validateAnalysisResult({ ...current, framework: "generic", fileRoles: [] }), /cannot have routes/);
  assert.throws(() => validateAnalysisResult({ ...current, framework: "react", fileRoles: [] }), /cannot have routes/);
});
