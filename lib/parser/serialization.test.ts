import assert from "node:assert/strict";
import test from "node:test";
import { validateAnalysisResult } from "./serialization";

function snapshot() {
  return {
    schemaVersion: 1,
    framework: "nestjs",
    fileRoles: [{ file: "src/users.controller.ts", role: "controller" }],
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

test("framework facts survive serialization and old snapshots normalize to the generic adapter", () => {
  const current = snapshot();
  assert.deepEqual(validateAnalysisResult(JSON.parse(JSON.stringify(current))), current);
  const legacy = { ...current };
  const { framework, fileRoles, routes, ...oldSnapshot } = legacy;
  assert.equal(framework, "nestjs");
  assert.equal(fileRoles.length, 1);
  assert.equal(routes.length, 1);
  assert.deepEqual(validateAnalysisResult(oldSnapshot), {
    ...oldSnapshot, framework: "generic", fileRoles: [], routes: [],
  });
  assert.throws(() => validateAnalysisResult({ ...oldSnapshot, framework: "nestjs" }), /missing field fileRoles/);
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
