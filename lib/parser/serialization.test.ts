import assert from "node:assert/strict";
import test from "node:test";
import { FRAMEWORKS, frameworkSupportsEntries } from "../frameworks/taxonomy";
import { prepareAnalysisForStorage, validateAnalysisResult, validateStoredAnalysisResult } from "./serialization";

function snapshot() {
  return {
    schemaVersion: 1,
    framework: "nestjs",
    fileRoles: [{ file: "src/users.controller.ts", role: "controller" }],
    frameworkEntries: [],
    routes: [{ file: "src/users.controller.ts", method: "GET", path: "/api/users/:id", line: 3 }],
    files: [{
      path: "src/users.controller.ts", folder: "src", module: ".", lineCount: 10,
      contentHash: "a".repeat(64), fanIn: 0, fanOut: 0, exports: [],
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

test("CommonJS export names round-trip and old files default to an empty list", () => {
  const fixture = snapshot();
  const current = { ...fixture, files: [{ ...fixture.files[0], exports: ["default", "handler"] }] };
  assert.deepEqual(validateAnalysisResult(JSON.parse(JSON.stringify(current))), current);
  const { exports: names, ...legacyFile } = current.files[0];
  assert.deepEqual(names, ["default", "handler"]);
  assert.deepEqual(validateAnalysisResult({ ...current, files: [legacyFile] }).files[0].exports, []);
  assert.deepEqual(validateAnalysisResult({ ...current, files: [{ ...legacyFile, exports: ["", "\u{10000}"] }] })
    .files[0].exports, ["", "\u{10000}"]);
  assert.throws(() => validateAnalysisResult({ ...current, files: [{ ...legacyFile, exports: ["\u{10000}", ""] }] }), /not stably sorted/);
  for (const exports of [null, "handler", [1], ["x", "x"], ["z", "a"]]) {
    assert.throws(() => validateAnalysisResult({ ...current, files: [{ ...legacyFile, exports }] }), /exports/);
  }
});

test("Express metadata and CommonJS imports round-trip without routes or special entries", () => {
  const fixture = snapshot();
  const fileRoles = [
    { file: "src/controllers/users.js", role: "controller" },
    { file: "src/middleware/auth.js", role: "middleware" },
    { file: "src/models/user.js", role: "model" },
    { file: "src/routes/users.js", role: "route" },
    { file: "src/services/users.js", role: "service" },
  ];
  const current = {
    ...fixture,
    framework: "express",
    fileRoles,
    routes: [],
    files: fileRoles.map(({ file }) => ({
      ...fixture.files[0], path: file, folder: file.slice(0, file.lastIndexOf("/")),
      fanIn: file === "src/controllers/users.js" ? 1 : 0,
      fanOut: file === "src/routes/users.js" ? 1 : 0,
      exports: file === "src/controllers/users.js" ? ["find"] : [],
    })),
    edges: [{ source: "src/routes/users.js", target: "src/controllers/users.js", kinds: ["require"] }],
    imports: [
      { source: "src/routes/users.js", specifier: "express", kind: "require", line: 1,
        resolution: { status: "external", reason: "external-package" } },
      { source: "src/routes/users.js", specifier: "../controllers/users", kind: "require", line: 2,
        resolution: { status: "internal", target: "src/controllers/users.js" } },
    ],
    coverage: {
      files: { ...fixture.coverage.files, discovered: 5, parsed: 5 },
      imports: { discovered: 2, internal: 1, external: 1, excluded: 0, unresolved: 0 },
    },
  };
  assert.deepEqual(validateAnalysisResult(JSON.parse(JSON.stringify(current))), current);
  const file = fileRoles[0].file;
  assert.throws(() => validateAnalysisResult({ ...current,
    routes: [{ file, method: "GET", path: "/users", line: 1 }] }), /cannot have routes/);
  assert.throws(() => validateAnalysisResult({ ...current, frameworkEntries: [file] }), /cannot have special entries/);
  assert.throws(() => validateAnalysisResult({ ...current,
    fileRoles: [{ file: "missing.js", role: "route" }] }), /not parsed/);
  for (const role of ["page", "api", "component", "hook", "module", "entity"]) {
    assert.throws(() => validateAnalysisResult({ ...current, fileRoles: [{ file, role }] }), /does not belong/);
  }
  assert.throws(() => validateAnalysisResult({ ...current,
    fileRoles: [{ file, role: "router" }] }), /unknown file role/);
  assert.throws(() => validateAnalysisResult({ ...current,
    fileRoles: [fileRoles[0], ...fileRoles] }), /duplicate/);
  assert.throws(() => validateAnalysisResult({ ...current,
    fileRoles: [...fileRoles].reverse() }), /not stably sorted/);
});

test("stored Unicode graph rows normalize to the unchanged parser order", () => {
  const fixture = snapshot();
  const astral = "src/\u{10000}.ts";
  const bmp = "src/.ts";
  const paths = ["src/entry.ts", astral, bmp];
  const current = {
    ...fixture,
    files: paths.map((file, index) => ({ ...fixture.files[0], path: file,
      fanIn: index === 0 ? 0 : 1, fanOut: index === 0 ? 2 : 0,
      exports: ["", "\u{10000}"] })),
    edges: [astral, bmp].map(target => ({ source: paths[0], target, kinds: ["import"] })),
    imports: [astral, bmp].map((target, index) => ({ source: paths[0], specifier: `./${target.slice(4, -3)}`,
      kind: "import", line: index + 1, resolution: { status: "internal", target } })),
    fileRoles: [astral, bmp].map(file => ({ file, role: "controller" })),
    routes: [
      { file: astral, method: "GET", path: "/\u{10000}", line: 1 },
      { file: astral, method: "GET", path: "/", line: 2 },
      { file: bmp, method: "GET", path: "/users", line: 3 },
    ],
    coverage: { files: { ...fixture.coverage.files, discovered: 3, parsed: 3 },
      imports: { discovered: 2, internal: 2, external: 0, excluded: 0, unresolved: 0 } },
  };
  assert.deepEqual(validateAnalysisResult(current), current);
  const stored = {
    ...current,
    files: [current.files[0], current.files[2], current.files[1]],
    edges: [...current.edges].reverse(),
    fileRoles: [...current.fileRoles].reverse(),
    routes: [...current.routes].reverse(),
  };
  const before = JSON.stringify(stored);
  assert.throws(() => validateAnalysisResult(stored), /files: entries are not stably sorted/);
  assert.deepEqual(validateStoredAnalysisResult(stored), current);
  assert.equal(JSON.stringify(stored), before);
  for (const field of ["files", "edges", "fileRoles", "routes"] as const) {
    assert.throws(() => validateStoredAnalysisResult({ ...stored, [field]: [...stored[field]].reverse() }), /not stably sorted/);
    assert.throws(() => validateStoredAnalysisResult({ ...stored, [field]: [stored[field][0], ...stored[field]] }), /duplicate|does not match files length/);
  }
  assert.throws(() => validateStoredAnalysisResult({ ...stored, imports: [...stored.imports].reverse() }), /imports: entries are not stably sorted/);
  assert.throws(() => validateStoredAnalysisResult({ ...stored,
    files: stored.files.map(file => ({ ...file, exports: [...file.exports].reverse() })) }), /exports: entries are not stably sorted/);
  assert.throws(() => validateStoredAnalysisResult({ ...stored,
    files: stored.files.map(file => ({ ...file, fanIn: 42 })) }), /fan-in or fan-out/);
  assert.throws(() => validateStoredAnalysisResult({ ...stored, edges: stored.edges.slice(1) }), /does not match internal import records/);
  assert.throws(() => validateStoredAnalysisResult({ ...stored, unknown: true }), /unexpected field/);
});

test("Unicode framework entries use C order only across the database boundary", () => {
  const fixture = snapshot();
  const paths = ["app/\u{10000}/error.tsx", "app//error.tsx"];
  const current = validateAnalysisResult({
    ...fixture, framework: "nextjs", fileRoles: [], routes: [], frameworkEntries: paths,
    files: paths.map(file => ({ ...fixture.files[0], path: file, folder: file.slice(0, file.lastIndexOf("/")) })),
    coverage: { ...fixture.coverage, files: { ...fixture.coverage.files, discovered: 2, parsed: 2 } },
  });
  const before = JSON.stringify(current);
  const prepared = prepareAnalysisForStorage(current);
  assert.deepEqual(prepared.frameworkEntries, [...paths].reverse());
  assert.equal(JSON.stringify(current), before);
  const stored = { ...prepared, files: [...prepared.files].reverse() };
  assert.deepEqual(validateStoredAnalysisResult(stored), current);
  assert.throws(() => validateStoredAnalysisResult({ ...stored, frameworkEntries: paths }), /frameworkEntries: entries are not stably sorted/);
  assert.throws(() => validateStoredAnalysisResult({ ...stored,
    frameworkEntries: [...prepared.frameworkEntries, paths[0]] }), /duplicate/);
  assert.throws(() => prepareAnalysisForStorage({ ...current, frameworkEntries: [...paths].reverse() }), /not stably sorted/);
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
