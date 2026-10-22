import assert from "node:assert/strict";
import test from "node:test";
import type { AnalysisResult, FileNode } from "../parser/contract";
import { cachedOperation, type AiCache } from "./cache";
import { explanationContext, inputKey, validateRoles } from "./context";
import { renderableDocument, validateDocument } from "./document";
import { roleCandidates } from "./candidates";
import { categoryForFile, categoriesForDisplay, displayRoles } from "../frameworks/taxonomy";

function file(path: string, hash = "a"): FileNode {
  const separator = path.lastIndexOf("/");
  return { path, folder: separator < 0 ? "." : path.slice(0, separator), module: ".", lineCount: 1,
    contentHash: hash.repeat(64), fanIn: 0, fanOut: 0, exports: [] };
}
function graph(paths: string[]): AnalysisResult {
  return { schemaVersion: 1, framework: "generic", frameworkEntries: [], fileRoles: [], routes: [],
    files: paths.map(path => file(path)), edges: [], imports: [],
    coverage: { files: { discovered: paths.length, parsed: paths.length, skipped: 0, skippedFiles: [], excludedDirectories: [] },
      imports: { discovered: 0, internal: 0, external: 0, unresolved: 0, excluded: 0 } } };
}

test("each click enters the trace before cache read; hit has no generation", async () => {
  const events: string[] = [];
  const values = new Map<string, Record<string, unknown>>();
  const cache: AiCache = { async read(key) { events.push("read"); return values.get(key) ?? null; },
    async write(key, _operation, value) { events.push("write"); values.set(key, value); } };
  const trace = async <T>(work: () => Promise<T>) => { events.push("trace:start"); const result = await work(); events.push("trace:end"); return result; };
  const generate = async () => { events.push("model"); return { markdown: "value" }; };
  const validate = (value: unknown) => { assert.deepEqual(value, { markdown: "value" }); return { markdown: "value" }; };
  assert.equal((await cachedOperation(cache, "key", "file", trace, validate, generate)).cacheHit, false);
  assert.equal((await cachedOperation(cache, "key", "file", trace, validate, generate)).cacheHit, true);
  assert.deepEqual(events, ["trace:start", "read", "model", "write", "trace:end", "trace:start", "read", "trace:end"]);
});

test("file context includes every direct neighbor and no second-hop inference", () => {
  const analysis = graph(["self.ts", "in.ts", "out.ts", "far.ts"]);
  analysis.edges = [ { source: "in.ts", target: "self.ts", kinds: ["import"] },
    { source: "self.ts", target: "out.ts", kinds: ["require"] }, { source: "out.ts", target: "far.ts", kinds: ["import"] },
    { source: "self.ts", target: "self.ts", kinds: ["dynamic-import"] } ];
  const context = explanationContext(analysis, { kind: "file", path: "self.ts" });
  assert.deepEqual(context.files.map(file => file.path), ["in.ts", "out.ts", "self.ts"]);
  assert.equal(context.edges.length, 3);
  assert.throws(() => explanationContext(analysis, { kind: "file", path: "absent.ts" }), /absent/);
});

test("folder context uses actual folded members, not a prefix subtree", () => {
  const analysis = graph(["a/one.ts", "a/two.ts", "a/three.ts", "a/nested/one.ts", "a/nested/two.ts", "a/nested/three.ts"]);
  analysis.edges = [{ source: "a/nested/one.ts", target: "a/one.ts", kinds: ["import"] }];
  const context = explanationContext(analysis, { kind: "folder", path: "a" });
  assert.deepEqual(context.members, ["a/one.ts", "a/three.ts", "a/two.ts"]);
  assert.equal(context.files.length, 4);
  assert.equal(context.edges.length, 1);
});

test("model, endpoint, operation and all context facts participate in cache identity", () => {
  const analysis = graph(["a.ts", "b.ts"]);
  analysis.edges = [{ source: "b.ts", target: "a.ts", kinds: ["import"] }];
  const input = explanationContext(analysis, { kind: "file", path: "a.ts" });
  const key = inputKey("model-1", "endpoint", "file", input);
  assert.notEqual(inputKey("model-2", "endpoint", "file", input), key);
  assert.notEqual(inputKey("model-1", "other-endpoint", "file", input), key);
  assert.notEqual(inputKey("model-1", "endpoint", "folder", input), key);
  analysis.files[1].contentHash = "b".repeat(64);
  assert.notEqual(inputKey("model-1", "endpoint", "file", explanationContext(analysis, { kind: "file", path: "a.ts" })), key);
});

test("limited formatting becomes typed nodes and every provided path becomes a file link", () => {
  const document = renderableDocument({ markdown: "### Purpose\n**Reads** `src/a.ts`.\n- Uses src/b.ts.\n```text\n`value`\n```\n*broken*" }, ["src/a.ts", "src/b.ts"]);
  assert.equal(document.blocks[0].kind, "paragraph");
  assert.equal(document.blocks[2].kind, "bullet");
  assert.ok(document.blocks[1].children.some(node => node.kind === "strong"));
  assert.deepEqual(document.blocks.flatMap(block => block.children).filter(node => node.kind === "file").map(node => node.path), ["src/a.ts", "src/b.ts"]);
  assert.doesNotMatch(JSON.stringify(document), /[`*#]/);
  assert.deepEqual(validateDocument(document, ["src/a.ts", "src/b.ts"]), document);
  assert.throws(() => renderableDocument({ markdown: "Uses `fiction.ts`." }, ["real.ts"]), /not supplied/);
  assert.throws(() => renderableDocument({ markdown: "Uses src/fiction.ts." }, ["fiction.ts"]), /not supplied/);
  assert.throws(() => validateDocument(document, ["src/a.ts"]), /reference/);
});

test("model roles cannot introduce structural roles or override adapter facts", () => {
  const analysis = graph(["a.ts", "b.ts", "a.test.ts", "types.d.ts"]);
  analysis.fileRoles = [{ file: "a.ts", role: "controller" }];
  const candidates = roleCandidates(analysis);
  assert.deepEqual(candidates.map(file => file.path), ["b.ts"]);
  for (const role of ["page", "route", "controller", "api", "layout", "middleware"]) {
    assert.throws(() => validateRoles([{ file: "b.ts", role }], candidates), /structural/);
  }
  assert.throws(() => validateRoles([], candidates), /every/);
  assert.deepEqual(validateRoles([], candidates, false), []);
  assert.throws(() => validateRoles([{ file: "b.ts", role: "util", contentHash: "b".repeat(64) }], candidates, false), /different file/);
  assert.throws(() => validateRoles([{ file: "fiction.ts", role: "util" }], candidates), /unprovided/);
  const roles = validateRoles([{ file: "b.ts", role: "util" }], candidates);
  const display = displayRoles(analysis.fileRoles, [...roles, { file: "a.ts", role: "util", contentHash: "a".repeat(64) }]);
  assert.equal(categoryForFile("a.ts", display).id, "controller");
  assert.equal(categoryForFile("b.ts", display).id, "util");
  assert.ok(categoriesForDisplay("generic", roles).some(category => category.id === "util"));
  assert.deepEqual(analysis.fileRoles, [{ file: "a.ts", role: "controller" }]);
});
