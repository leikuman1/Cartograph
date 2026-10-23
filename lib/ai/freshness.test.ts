import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import type { FileNode } from "../parser/contract";
import { repositoryFreshness } from "./freshness";

const analyzed = "a".repeat(40);
const head = "b".repeat(40);
const content = "export const value = 1;\n";
const file: FileNode = { path: "src/value.ts", folder: "src", module: ".", lineCount: 1, fanIn: 0, fanOut: 0,
  contentHash: createHash("sha256").update(content).digest("hex"), exports: ["value"] };

test("freshness compares exact HEAD bytes with stored hashes and distinguishes unknown failures", async t => {
  let currentHead = analyzed;
  let currentContent: string | null = content;
  let fail = false;
  const urls: string[] = [];
  t.mock.method(globalThis, "fetch", async (input: string | URL | Request) => {
    const url = String(input);
    urls.push(url);
    if (fail) return new Response("", { status: 429 });
    if (url.endsWith("/repos/owner/repo")) return Response.json({ default_branch: "main" });
    if (url.includes("/commits/")) return Response.json({ sha: currentHead });
    return new Response(currentContent, { status: currentContent === null ? 404 : 200 });
  });
  assert.equal((await repositoryFreshness("https://github.com/owner/repo", analyzed, [file])).status, "fresh");
  assert.ok(urls.includes(`https://raw.githubusercontent.com/owner/repo/${analyzed}/src/value.ts`));
  currentHead = head;
  const changedCommit = await repositoryFreshness("https://github.com/owner/repo", analyzed, [file]);
  assert.equal(changedCommit.status, "stale");
  assert.deepEqual(changedCommit.changedFiles, []);
  currentContent = "changed";
  assert.deepEqual((await repositoryFreshness("https://github.com/owner/repo", analyzed, [file])).changedFiles, [file.path]);
  currentContent = null;
  assert.deepEqual((await repositoryFreshness("https://github.com/owner/repo", analyzed, [file])).changedFiles, [file.path]);
  fail = true;
  const unknown = await repositoryFreshness("https://github.com/owner/repo", analyzed, [file]);
  assert.equal(unknown.status, "unknown");
  assert.match(unknown.message, /rate-limited/);
});

test("freshness bounds source reads at four and preserves every file's input order", { timeout: 5_000 }, async t => {
  const files = Array.from({ length: 10 }, (_, index) => ({ ...file, path: `src/value-${9 - index}.ts` }));
  const changed = new Set([0, 2, 3, 5, 8, 9]);
  const releases = files.map(() => Promise.withResolvers<Response>());
  const batches = Array.from({ length: 3 }, () => Promise.withResolvers<void>());
  const metadataUrls: string[] = [];
  const sourceUrls: string[] = [];
  const completed: number[] = [];
  let active = 0;
  let maximum = 0;
  t.mock.method(globalThis, "fetch", async (input: string | URL | Request) => {
    const url = String(input);
    if (!url.startsWith("https://raw.githubusercontent.com/")) {
      metadataUrls.push(url);
      return url.includes("/commits/")
        ? Response.json({ sha: analyzed })
        : Response.json({ default_branch: "main" });
    }
    const index = sourceUrls.length;
    sourceUrls.push(url);
    active += 1;
    maximum = Math.max(maximum, active);
    if (active === 4 || sourceUrls.length === files.length) {
      batches[Math.floor(index / 4)].resolve();
    }
    try {
      const response = await releases[index].promise;
      completed.push(index);
      return response;
    } finally {
      active -= 1;
    }
  });

  const checking = repositoryFreshness("https://github.com/owner/repo", analyzed, files);
  for (let offset = 0; offset < files.length; offset += 4) {
    await batches[offset / 4].promise;
    const end = Math.min(offset + 4, files.length);
    assert.equal(active, end - offset);
    assert.equal(sourceUrls.length, end);
    // Complete each batch backwards so completion order cannot dictate file order.
    for (let index = end - 1; index >= offset; index -= 1) {
      releases[index].resolve(index === 5
        ? new Response(null, { status: 404 })
        : new Response(changed.has(index) ? "changed" : content));
      await new Promise<void>(resolve => setImmediate(resolve));
    }
  }
  const result = await checking;
  assert.equal(result.status, "stale");
  assert.equal(result.head, analyzed);
  assert.deepEqual(result.changedFiles, files.filter((_, index) => changed.has(index)).map(entry => entry.path));
  assert.deepEqual(sourceUrls, files.map(entry => `https://raw.githubusercontent.com/owner/repo/${analyzed}/${entry.path}`));
  assert.deepEqual(metadataUrls, ["https://api.github.com/repos/owner/repo", "https://api.github.com/repos/owner/repo/commits/main"]);
  assert.deepEqual(completed, [3, 2, 1, 0, 7, 6, 5, 4, 9, 8]);
  assert.equal(maximum, 4);
  assert.equal(active, 0);
});

test("freshness settles a failed batch and returns unknown without partial changes", { timeout: 5_000 }, async t => {
  const files = Array.from({ length: 9 }, (_, index) => ({ ...file, path: `src/value-${index}.ts` }));
  const releases = Array.from({ length: 4 }, () => Promise.withResolvers<Response>());
  const batchStarted = Promise.withResolvers<void>();
  let reads = 0;
  let active = 0;
  let settled = false;
  t.mock.method(globalThis, "fetch", async (input: string | URL | Request) => {
    const url = String(input);
    if (url.endsWith("/repos/owner/repo")) return Response.json({ default_branch: "main" });
    if (url.includes("/commits/")) return Response.json({ sha: head });
    const index = reads++;
    if (index < 4) return new Response("changed");
    assert.ok(index < 8, "a failed batch must not start later reads");
    active += 1;
    if (active === 4) batchStarted.resolve();
    try {
      return await releases[index - 4].promise;
    } finally {
      active -= 1;
    }
  });

  const checking = repositoryFreshness("https://github.com/owner/repo", analyzed, files).then(result => {
    settled = true;
    return result;
  });
  await batchStarted.promise;
  releases[0].resolve(new Response(null, { status: 503 }));
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(settled, false);
  assert.equal(active, 3);
  releases[1].reject(new Error("Network connection failed"));
  releases[2].resolve(new Response(content));
  releases[3].resolve(new Response("changed"));

  const result = await checking;
  assert.equal(result.status, "unknown");
  assert.equal(result.head, null);
  assert.deepEqual(result.changedFiles, []);
  assert.match(result.message, /HTTP 503/);
  assert.equal(reads, 8);
  assert.equal(active, 0);
});
