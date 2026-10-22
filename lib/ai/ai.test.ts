import assert from "node:assert/strict";
import test from "node:test";
import type { AnalysisResult, FileNode } from "../parser/contract";
import { cachedOperation, type AiCache } from "./cache";
import { classificationBatches, MAX_INPUT_BYTES } from "./classification";
import { explanationContext, inputKey, validateRoles } from "./context";
import { renderableDocument, validateDocument } from "./document";
import { roleCandidates } from "./candidates";
import { classifySnapshot } from "./operations";
import { PINNED_MODEL } from "./config";
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

test("explanations accept supplied folders and framework prose without admitting unknown paths", () => {
  const paths = ["a/nested/page.tsx", "a/nested/Node.js", "a/nested/util.ts", "src/index.ts"];
  const document = renderableDocument({ markdown: "**Next.js** and Node.js use `a/nested` for client/server request/response handling and/or GET/POST routes. Reads src/index.ts." }, paths);
  assert.deepEqual(validateDocument(document, paths), document);
  assert.ok(document.blocks[0].children.some(node => node.kind === "strong" && node.text === "Next.js"));
  assert.ok(document.blocks[0].children.some(node => node.kind === "code" && node.text === "a/nested"));
  assert.deepEqual(explanationContext(graph(paths), { kind: "file", path: "a/nested/page.tsx" }).folders, ["a", "a/nested"]);
  for (const text of ["fiction.ts", "src/fiction.ts", "unknown/folder", "src/Next.js", "unknown/a/nested", "a/nested/fiction.ts", "src/index.tsx"]) {
    assert.throws(() => renderableDocument({ markdown: text }, paths), /not supplied/);
  }
  const namedFile = renderableDocument({ markdown: "`Node.js` runs here." }, ["Node.js"]);
  assert.equal(namedFile.blocks[0].children[0].kind, "file");
});

test("explanation punctuation preserves allowed references and rejects unknown paths", () => {
  const paths = ["a/nested/page.tsx", "a/trailing./value.ts", "src/value.ts."];
  for (const markdown of ["Uses read/write.", "Handles GET/POST.", "Uses a/nested.", "Uses a/trailing.."]) {
    const document = renderableDocument({ markdown }, paths);
    assert.deepEqual(validateDocument(document, paths), document);
    assert.equal(document.blocks[0].children.map(node => node.kind === "file" ? node.path : node.text).join(""), markdown);
  }
  const document = renderableDocument({ markdown: "Reads `src/value.ts.`." }, paths);
  assert.deepEqual(document.blocks[0].children[1], { kind: "file", path: "src/value.ts." });
  assert.deepEqual(validateDocument(document, paths), document);
  for (const markdown of ["Uses a/nested-.", "Uses a/nested..", "Uses unknown/folder.", "Uses GET/POST-."]) {
    assert.throws(() => renderableDocument({ markdown }, paths), /not supplied/);
  }
});

test("classification batches fit serialized UTF-8 input and report oversized files", () => {
  const files = ["one.ts", "large.ts", "two.ts", "three.ts"].map(path => ({ path, contentHash: "a".repeat(64) }));
  const sources = new Map([
    ["one.ts", "界".repeat(40000)],
    ["large.ts", "x".repeat(MAX_INPUT_BYTES)],
    ["two.ts", "界".repeat(40000)],
    ["three.ts", "small"],
  ]);
  const { batches, oversized } = classificationBatches(files, sources);
  assert.deepEqual(oversized, ["large.ts"]);
  assert.deepEqual(batches.map(batch => batch.map(file => file.path)), [["one.ts"], ["two.ts", "three.ts"]]);
  for (const batch of batches) assert.ok(Buffer.byteLength(JSON.stringify(batch), "utf8") <= MAX_INPUT_BYTES);
  assert.throws(() => classificationBatches(files, new Map()), /Source is unavailable/);
});

test("classification keeps completed batches after model failure and propagates cache failures", async t => {
  const environment = {
    OPENAI_API_KEY: "fixture-key", OPENAI_BASE_URL: "http://127.0.0.1:34567/v1",
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
  const analysis = graph(Array.from({ length: 17 }, (_, index) => `file-${index}.ts`));
  const sources = new Map(analysis.files.map(file => [file.path, "export const value = 1;"]));
  const expected = analysis.files.slice(0, 8).map(file => ({ file: file.path, role: "util", contentHash: file.contentHash }));
  let failure = "provider";
  let modelCalls = 0;
  t.mock.method(globalThis, "fetch", async () => {
    modelCalls += 1;
    return failure.endsWith("provider") ? new Response("Unavailable", { status: 503 }) : Response.json({
      id: "fixture", object: "chat.completion", created: 0, model: PINNED_MODEL,
      choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: JSON.stringify({ roles: failure === "cache write" ? expected : [] }) } }],
    });
  });
  const reports: unknown[][] = [];
  t.mock.method(console, "error", (...args: unknown[]) => { reports.push(args); });
  for (const scenario of ["provider", "invalid output", "first provider", "cache read", "cache write", "invalid cache", "missing source"]) {
    await t.test(scenario, async () => {
      failure = scenario;
      modelCalls = 0;
      reports.length = 0;
      let reads = 0;
      const cache: AiCache = {
        async read() {
          reads += 1;
          if (scenario === "cache write" || scenario === "first provider") return null;
          if (reads === 1) return { roles: expected };
          if (scenario === "cache read") throw new Error("cache read failed");
          if (scenario === "invalid cache") return { roles: [] };
          return null;
        },
        async write() { throw new Error("cache write failed"); },
      };
      if (scenario === "missing source") {
        await assert.rejects(classifySnapshot(analysis, new Map(), cache), /Source is unavailable/);
        assert.equal(reads, 0);
        assert.equal(modelCalls, 0);
        assert.equal(reports.length, 0);
      } else if (["provider", "invalid output", "first provider"].includes(scenario)) {
        assert.deepEqual(await classifySnapshot(analysis, sources, cache), scenario === "first provider" ? [] : expected);
        assert.equal(reads, scenario === "first provider" ? 1 : 2, "classification must stop at the failed batch");
        assert.equal(modelCalls, 1);
        assert.equal(reports.length, 1);
      } else {
        await assert.rejects(classifySnapshot(analysis, sources, cache), scenario === "invalid cache" ? /every supplied file/ : /cache .* failed/);
        assert.equal(reports.length, 0);
      }
    });
  }
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
