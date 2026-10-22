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
