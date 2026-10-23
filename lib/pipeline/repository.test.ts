import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { access, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { gzipSync } from "node:zlib";
import { fetchRepository, normalizeRepositoryUrl, readRepositorySource, resolveRepositoryHead } from "./repository";

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

function mockSource(t: TestContext, sourceResponse: (signal: AbortSignal) => Response | Promise<Response>) {
  const requests: string[] = [];
  t.mock.method(globalThis, "fetch", async (input: string | URL | Request, init?: RequestInit) => {
    requests.push(String(input));
    const headers = new Headers(init?.headers);
    assert.equal(headers.has("authorization"), false);
    assert.equal(headers.has("cookie"), false);
    assert.equal(init?.cache, "no-store");
    assert.equal(init?.credentials, "omit");
    assert.equal(init?.redirect, "error");
    assert.ok(init?.signal);
    return sourceResponse(init.signal);
  });
  return requests;
}

function streamedSource(chunks: Uint8Array[], headers?: HeadersInit) {
  return new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  }), { headers });
}

function neverRespond(signal: AbortSignal): Promise<Response> {
  return new Promise((_resolve, reject) => {
    signal.addEventListener("abort", () => reject(signal.reason), { once: true });
  });
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

test("resolves the current default-branch commit with uncached public metadata", async t => {
  const requests: string[] = [];
  const signals: AbortSignal[] = [];
  t.mock.method(globalThis, "fetch", async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    requests.push(url);
    assert.equal(init?.cache, "no-store");
    assert.equal(init?.credentials, "omit");
    assert.equal(init?.redirect, "error");
    assert.equal(new Headers(init?.headers).has("authorization"), false);
    assert.equal(new Headers(init?.headers).has("cookie"), false);
    assert.ok(init?.signal);
    signals.push(init.signal);
    if (url === "https://api.github.com/repos/owner/repo") {
      return Response.json({ default_branch: "release/next" });
    }
    assert.equal(url, "https://api.github.com/repos/owner/repo/commits/release%2Fnext");
    return Response.json({ sha: requests.length === 2 ? commitSha : "b".repeat(40) });
  });
  assert.equal(await resolveRepositoryHead(repository), commitSha);
  assert.equal(await resolveRepositoryHead(repository), "b".repeat(40));
  assert.equal(requests.length, 4);
  assert.equal(signals[0], signals[1]);
  assert.equal(signals[2], signals[3]);
  assert.notEqual(signals[0], signals[2]);
});

test("rejects missing or malformed commit metadata", async t => {
  for (const sha of [undefined, "main", "a".repeat(39), "a".repeat(41), "g".repeat(40), `${commitSha}\n`]) {
    const scope = t.mock.method(globalThis, "fetch", async (input: string | URL | Request) => {
      return String(input).endsWith("/commits/main")
        ? Response.json({ sha }) : Response.json({ default_branch: "main" });
    });
    try {
      await assert.rejects(resolveRepositoryHead(repository), /did not report a commit/);
    } finally {
      scope.mock.restore();
    }
  }
});

test("applies one metadata timeout across both head requests", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  t.mock.method(globalThis, "fetch", async (input: string | URL | Request, init?: RequestInit) => {
    assert.ok(init?.signal);
    if (String(input) === "https://api.github.com/repos/owner/repo") {
      t.mock.timers.tick(15_000);
      return Response.json({ default_branch: "main" });
    }
    const pending = neverRespond(init.signal);
    t.mock.timers.tick(5_000);
    return pending;
  });
  await assert.rejects(resolveRepositoryHead(repository), /metadata request timed out/);
});

test("reads source from only the requested immutable commit without credentials", async t => {
  const content = "export const value = 1;\n";
  const requests = mockSource(t, () => new Response(content));
  assert.deepEqual(await readRepositorySource(repository, commitSha, "src/value.ts"), {
    content,
    contentHash: createHash("sha256").update(content).digest("hex"),
  });
  assert.deepEqual(requests, [`https://raw.githubusercontent.com/owner/repo/${commitSha}/src/value.ts`]);
});

test("encodes each raw-source path segment without changing the repository path", async t => {
  const requests = mockSource(t, () => new Response("source"));
  const paths = [
    ["src/hello world/中文#%[id].tsx", "src/hello%20world/%E4%B8%AD%E6%96%87%23%25%5Bid%5D.tsx"],
    ["src/%2e%2e/%2F.ts", "src/%252e%252e/%252F.ts"],
    ["app/(group)/[slug]/page.tsx", "app/(group)/%5Bslug%5D/page.tsx"],
  ];
  for (const [filePath] of paths) await readRepositorySource(repository, commitSha, filePath);
  assert.deepEqual(requests, paths.map(([, encoded]) =>
    `https://raw.githubusercontent.com/owner/repo/${commitSha}/${encoded}`));
});

test("hashes original UTF-8 bytes including a BOM and decodes split Unicode sequences", async t => {
  const content = "export const greeting = '你好 🌏';\r\n";
  const bytes = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(content)]);
  mockSource(t, () => streamedSource(Array.from(bytes, byte => Uint8Array.of(byte))));
  const source = await readRepositorySource(repository, commitSha, "src/unicode.ts");
  assert.ok(source);
  assert.equal(source.content, content);
  assert.equal(source.contentHash, createHash("sha256").update(bytes).digest("hex"));
  assert.notEqual(source.contentHash, createHash("sha256").update(source.content).digest("hex"));
});

test("accepts an empty source file", async t => {
  mockSource(t, () => new Response(""));
  assert.deepEqual(await readRepositorySource(repository, commitSha, "empty.ts"), {
    content: "",
    contentHash: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
  });
});

test("accepts source exactly at the 1 MiB byte limit", async t => {
  const bytes = Buffer.alloc(1024 * 1024, 97);
  mockSource(t, () => streamedSource([bytes.subarray(0, 600_000), bytes.subarray(600_000)], {
    "content-length": String(bytes.length),
  }));
  const source = await readRepositorySource(repository, commitSha, "src/limit.ts");
  assert.ok(source);
  assert.equal(source.content.length, bytes.length);
  assert.equal(source.contentHash, createHash("sha256").update(bytes).digest("hex"));
});

test("rejects and cancels source declared above the 1 MiB limit", async t => {
  let cancelled = false;
  mockSource(t, () => new Response(new ReadableStream<Uint8Array>({
    cancel() { cancelled = true; },
  }), { headers: { "content-length": String(1024 * 1024 + 1) } }));
  await assert.rejects(readRepositorySource(repository, commitSha, "src/large.ts"), /1 MiB limit/);
  assert.equal(cancelled, true);
});

test("caps and cancels streamed source even with absent or understated content length", async t => {
  for (const declared of [null, "1"]) {
    let cancelled = false;
    const scope = t.mock.method(globalThis, "fetch", async () => new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(1024 * 1024));
        controller.enqueue(new Uint8Array(1));
      },
      cancel() { cancelled = true; },
    }), { headers: declared === null ? {} : { "content-length": declared } }));
    try {
      await assert.rejects(readRepositorySource(repository, commitSha, "src/large.ts"), /1 MiB limit/);
      assert.equal(cancelled, true);
    } finally {
      scope.mock.restore();
    }
  }
});

test("rejects malformed and truncated UTF-8 rather than replacing bytes", async t => {
  for (const bytes of [Uint8Array.of(0xff), Uint8Array.of(0xc3, 0x28), Uint8Array.of(0xe2, 0x82)]) {
    const scope = t.mock.method(globalThis, "fetch", async () => streamedSource([bytes]));
    try {
      await assert.rejects(readRepositorySource(repository, commitSha, "src/invalid.ts"), /encoded data|encoding|utf-8/i);
    } finally {
      scope.mock.restore();
    }
  }
});

test("returns null only for deleted source and cancels the 404 response", async t => {
  let cancelled = false;
  mockSource(t, () => new Response(new ReadableStream<Uint8Array>({
    cancel() { cancelled = true; },
  }), { status: 404 }));
  assert.equal(await readRepositorySource(repository, commitSha, "src/deleted.ts"), null);
  assert.equal(cancelled, true);
});

test("throws on source HTTP errors and redirects", async t => {
  for (const status of [301, 302, 403, 410, 429, 500]) {
    let cancelled = false;
    const scope = t.mock.method(globalThis, "fetch", async () => new Response(new ReadableStream<Uint8Array>({
      cancel() { cancelled = true; },
    }), { status }));
    try {
      await assert.rejects(readRepositorySource(repository, commitSha, "src/file.ts"), new RegExp(`HTTP ${status}`));
      assert.equal(cancelled, true);
    } finally {
      scope.mock.restore();
    }
  }
});

test("throws when a successful source response has no body", async t => {
  mockSource(t, () => new Response(null, { status: 204 }));
  await assert.rejects(readRepositorySource(repository, commitSha, "src/file.ts"), /source body/);
});

test("propagates source network and body-stream failures", async t => {
  for (const failure of ["network", "stream"]) {
    const scope = t.mock.method(globalThis, "fetch", async () => {
      if (failure === "network") throw new Error("source connection lost");
      return new Response(new ReadableStream<Uint8Array>({
        start(controller) { controller.error(new Error("source connection lost")); },
      }));
    });
    try {
      await assert.rejects(readRepositorySource(repository, commitSha, "src/file.ts"), /source connection lost/);
    } finally {
      scope.mock.restore();
    }
  }
});

test("times out a source request", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  mockSource(t, signal => {
    const pending = neverRespond(signal);
    t.mock.timers.tick(20_000);
    return pending;
  });
  await assert.rejects(readRepositorySource(repository, commitSha, "src/file.ts"), /source request timed out/);
});

test("keeps the source timeout active through the response body", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  mockSource(t, signal => new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      signal.addEventListener("abort", () => controller.error(signal.reason), { once: true });
    },
    pull() { t.mock.timers.tick(20_000); },
  })));
  await assert.rejects(readRepositorySource(repository, commitSha, "src/file.ts"), /source request timed out/);
});

test("rejects non-immutable commit references before fetching source", async t => {
  const fetch = t.mock.method(globalThis, "fetch", async () => new Response("unexpected"));
  for (const sha of ["", "main", "HEAD", "a".repeat(39), "a".repeat(41), "g".repeat(40), `${commitSha}\n`, `../${commitSha}`]) {
    await assert.rejects(readRepositorySource(repository, sha, "src/file.ts"), /commit SHA/);
  }
  assert.equal(fetch.mock.callCount(), 0);
});

test("rejects unsafe repository-relative source paths before fetching", async t => {
  const fetch = t.mock.method(globalThis, "fetch", async () => new Response("unexpected"));
  for (const filePath of [
    "", ".", "..", "/src/file.ts", "//host/file.ts", "src/", "src//file.ts",
    "./src/file.ts", "src/../file.ts", "src/./file.ts", "../file.ts", "src\\file.ts",
    "C:/file.ts", "src/file.ts:stream", "src/\0file.ts", "src/\nfile.ts", "src/\x7ffile.ts",
    "src/file.ts?raw", "src/file*.ts", "src/<file>.ts", "src/file|name.ts", "src/file\".ts",
    "src/file.ts.", "src/file.ts ", "src/con.ts", "src/LPT1/file.ts",
  ]) {
    await assert.rejects(readRepositorySource(repository, commitSha, filePath), /unsafe path/, filePath);
  }
  assert.equal(fetch.mock.callCount(), 0);
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
