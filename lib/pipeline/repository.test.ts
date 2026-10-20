import assert from "node:assert/strict";
import { access, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { gzipSync } from "node:zlib";
import { fetchRepository, normalizeRepositoryUrl } from "./repository";

const commitSha = "a".repeat(40);
const repository = normalizeRepositoryUrl("https://github.com/owner/repo");

// A real tar member makes the fetch test cover the recorded SHA through to disk.
function publicArchive(includeLink = false) {
  const entries = [
    { name: "README.md", type: "0", body: Buffer.from("public source\n") },
    ...(includeLink ? [{ name: "linked.ts", type: "2", body: Buffer.alloc(0) }] : []),
  ];
  const parts: Buffer[] = [];
  for (const entry of entries) {
    const header = Buffer.alloc(512);
    header.write(`repo-${commitSha}/${entry.name}`);
    header.write(`${entry.body.length.toString(8).padStart(11, "0")}\0`, 124, 12);
    header.fill(32, 148, 156);
    header.write(entry.type, 156);
    if (entry.type === "2") header.write("../outside", 157);
    header.write("ustar\0", 257);
    let checksum = 0;
    for (const byte of header) checksum += byte;
    header.write(`${checksum.toString(8).padStart(6, "0")}\0 `, 148, 8);
    parts.push(header, entry.body, Buffer.alloc((512 - entry.body.length % 512) % 512));
  }
  return gzipSync(Buffer.concat([...parts, Buffer.alloc(1024)]));
}

async function temporaryDirectories() {
  return (await readdir(tmpdir())).filter(name => /^cartograph-(?:archive|source)-[a-zA-Z0-9]+$/.test(name));
}

function mockGithub(t: TestContext, archiveResponse: () => Response | Promise<Response>) {
  const requests: string[] = [];
  t.mock.method(globalThis, "fetch", async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    requests.push(url);
    assert.equal(new Headers(init?.headers).has("authorization"), false);
    assert.equal(new Headers(init?.headers).has("cookie"), false);
    assert.equal(init?.redirect, "error");
    assert.ok(init?.signal);
    if (url === "https://api.github.com/repos/owner/repo") return Response.json({ default_branch: "release/next" });
    if (url === "https://api.github.com/repos/owner/repo/commits/release%2Fnext") return Response.json({ sha: commitSha });
    assert.equal(url, `https://codeload.github.com/owner/repo/tar.gz/${commitSha}`);
    return archiveResponse();
  });
  return requests;
}

test("normalizes a plain GitHub repository URL", () => {
  assert.deepEqual(normalizeRepositoryUrl("https://github.com/HonoJS/Hono.git"), {
    url: "https://github.com/HonoJS/Hono", owner: "HonoJS", name: "Hono", fullName: "HonoJS/Hono",
  });
  assert.deepEqual(normalizeRepositoryUrl(" https://github.com/vercel/next.js/ "), {
    url: "https://github.com/vercel/next.js", owner: "vercel", name: "next.js", fullName: "vercel/next.js",
  });
});

test("rejects URLs that do not identify exactly one public repository", () => {
  for (const input of [
    "https://github.com/owner", "https://github.com/owner/repo/tree/main",
    "https://github.com/owner/repo?tab=readme", "https://github.com/owner/repo#readme",
    "http://github.com/owner/repo", "https://gitlab.com/owner/repo", "https://github.com:8443/owner/repo",
    "https://user:token@github.com/owner/repo", "https://github.com/owner//repo", "not a url",
  ]) {
    assert.throws(() => normalizeRepositoryUrl(input), Error, input);
  }
});

test("path traversal in a repository URL is rejected", () => {
  assert.throws(() => normalizeRepositoryUrl("https://github.com/../repo"));
});

test("fetches public metadata and the exact recorded commit archive without credentials", async t => {
  const requests = mockGithub(t, () => new Response(publicArchive()));
  const fetched = await fetchRepository(repository);
  const extractionDirectory = path.dirname(fetched.directory);
  try {
    assert.equal(fetched.commitSha, commitSha);
    assert.equal(path.basename(fetched.directory), `repo-${commitSha}`);
    assert.equal(await readFile(path.join(fetched.directory, "README.md"), "utf8"), "public source\n");
    assert.equal(requests.length, 3);
  } finally {
    await fetched.cleanup();
  }
  await assert.rejects(access(extractionDirectory), /ENOENT/);
  await fetched.cleanup();
});

test("fetch returns skipped archive links without creating them", async t => {
  mockGithub(t, () => new Response(publicArchive(true)));
  const fetched = await fetchRepository(repository);
  try {
    assert.equal(fetched.commitSha, commitSha);
    assert.deepEqual(fetched.skippedFiles.map(({ path, reason }) => ({ path, reason })), [
      { path: "linked.ts", reason: "symlink" },
    ]);
    assert.deepEqual(await readdir(fetched.directory), ["README.md"]);
  } finally {
    await fetched.cleanup();
  }
});

test("removes temporary archive and source directories on download or extraction failure", async t => {
  for (const failure of ["http", "declared-size", "stream-size", "stream-error", "extraction"]) {
    const before = new Set(await temporaryDirectories());
    let created: string[] = [];
    let cancelled = false;
    const scope = t.mock.method(globalThis, "fetch", async (input: string | URL | Request) => {
      const url = String(input);
      if (url.startsWith("https://api.github.com/repos/owner/repo/commits/")) return Response.json({ sha: commitSha });
      if (url === "https://api.github.com/repos/owner/repo") return Response.json({ default_branch: "main" });
      created = (await temporaryDirectories()).filter(name => !before.has(name));
      assert.equal(created.length, 2);
      if (failure === "extraction") return new Response(gzipSync(Buffer.from("broken tar")));
      const body = new ReadableStream<Uint8Array>({
        pull(controller) {
          if (failure === "stream-error") controller.error(new Error("download connection lost"));
          else if (failure === "stream-size") controller.enqueue(new Uint8Array(1024 * 1024));
          else controller.enqueue(new Uint8Array([0]));
        },
        cancel() { cancelled = true; },
      });
      return new Response(body, {
        status: failure === "http" ? 500 : 200,
        headers: failure === "declared-size" ? { "content-length": String(50 * 1024 * 1024 + 1) } : {},
      });
    });
    try {
      const expected = failure === "http" ? /HTTP 500/ : failure === "stream-error" ? /download connection lost/
        : failure === "extraction" ? /inside an entry/ : /50 MiB limit/;
      await assert.rejects(fetchRepository(repository), expected);
      for (const directory of created) await assert.rejects(access(path.join(tmpdir(), directory)), /ENOENT/);
      if (failure !== "stream-error" && failure !== "extraction") assert.equal(cancelled, true);
    } finally {
      scope.mock.restore();
    }
  }
});

test("reports public metadata failures before attempting an archive download", async t => {
  for (const [response, message] of [
    [new Response(null, { status: 404 }), /does not exist or is not public/],
    [new Response(null, { status: 403 }), /rate-limited/],
    [Response.json({ default_branch: "" }), /default branch/],
  ] satisfies [Response, RegExp][]) {
    let requests = 0;
    const scope = t.mock.method(globalThis, "fetch", async () => {
      requests += 1;
      return response;
    });
    try {
      await assert.rejects(fetchRepository(repository), message);
      assert.equal(requests, 1);
    } finally {
      scope.mock.restore();
    }
  }
});
