import assert from "node:assert/strict";
import { createWriteStream } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import test, { type TestContext } from "node:test";
import { createGzip, gzipSync } from "node:zlib";
import { extractArchive } from "./repository";

interface Entry {
  path: string;
  type?: string;
  link?: string;
  content?: string | Buffer;
  size?: number;
  sizeField?: string;
}

// A deterministic USTAR writer keeps malformed-input tests independent of tar.
function octal(value: number, length: number) {
  return `${value.toString(8).padStart(length - 1, "0")}\0`;
}

function header(entry: Entry) {
  const block = Buffer.alloc(512);
  block.write(entry.path, 0, 100, "utf8");
  block.write(octal(0o644, 8), 100, 8, "ascii");
  block.write(octal(0, 8), 108, 8, "ascii");
  block.write(octal(0, 8), 116, 8, "ascii");
  block.write(entry.sizeField ?? octal(entry.size ?? Buffer.byteLength(entry.content ?? ""), 12), 124, 12, "latin1");
  block.write(octal(0, 12), 136, 12, "ascii");
  block.fill(32, 148, 156);
  block.write(entry.type ?? "0", 156, 1, "ascii");
  block.write(entry.link ?? "", 157, 100, "utf8");
  block.write("ustar\0", 257, 6, "ascii");
  block.write("00", 263, 2, "ascii");
  let checksum = 0;
  for (const byte of block) checksum += byte;
  block.write(`${checksum.toString(8).padStart(6, "0")}\0 `, 148, 8, "ascii");
  return block;
}

function tar(entries: Entry[]) {
  const parts: Buffer[] = [];
  for (const entry of entries) {
    const content = Buffer.from(entry.content ?? "");
    parts.push(header(entry), content, Buffer.alloc((512 - (content.length % 512)) % 512));
  }
  parts.push(Buffer.alloc(1024));
  return Buffer.concat(parts);
}

function pax(key: string, value: string) {
  const record = ` ${key}=${value}\n`;
  let length = Buffer.byteLength(record) + 1;
  while (String(length).length + Buffer.byteLength(record) !== length) {
    length = String(length).length + Buffer.byteLength(record);
  }
  return `${length}${record}`;
}

async function fixture(t: TestContext, content: Buffer = gzipSync(tar([]))) {
  const directory = await mkdtemp(path.join(tmpdir(), "cartograph-archive-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const archiveDirectory = path.join(directory, "archive");
  const output = path.join(directory, "output");
  await mkdir(archiveDirectory);
  await mkdir(output);
  const archivePath = path.join(archiveDirectory, "repository.tar.gz");
  await writeFile(archivePath, content);
  return { directory, output, archivePath };
}

test("extracts regular files, empty files and explicit directories", async t => {
  const { archivePath, output } = await fixture(t, gzipSync(tar([
    { path: "repo-abc123/", type: "5" },
    { path: "repo-abc123/empty/", type: "5" },
    { path: "repo-abc123/empty.ts" },
    { path: "repo-abc123/src/index.ts", content: "export const value = 1;\n" },
  ])));
  const root = await extractArchive(archivePath, output);
  assert.equal(path.basename(root), "repo-abc123");
  assert.equal(await readFile(path.join(root, "src", "index.ts"), "utf8"), "export const value = 1;\n");
  assert.equal(await readFile(path.join(root, "empty.ts"), "utf8"), "");
  assert.deepEqual(await readdir(path.join(root, "empty")), []);
});

test("consumes a directory's local PAX path before the next file", async t => {
  const directoryName = `repo-abc123/${"目录".repeat(40)}/`;
  const { archivePath, output } = await fixture(t, gzipSync(tar([
    { path: "pax_global_header", type: "g", content: pax("comment", "a".repeat(40)) },
    { path: "PaxHeader", type: "x", content: pax("path", directoryName) },
    { path: "placeholder/", type: "5" },
    { path: "repo-abc123/index.ts", content: "unchanged path" },
  ])));
  const root = await extractArchive(archivePath, output);
  assert.equal(await readFile(path.join(root, "index.ts"), "utf8"), "unchanged path");
  assert.deepEqual(await readdir(path.join(output, directoryName)), []);
});

test("honors PAX byte lengths, last path and size overrides", async t => {
  const longName = `repo-abc123/${"文件".repeat(25)}.ts`;
  const { archivePath, output } = await fixture(t, gzipSync(tar([
    { path: "PaxHeader", type: "x", content: pax("comment", "ignored\n999 path=../../escape\n")
      + pax("path", "repo-abc123/old.ts") + pax("path", longName) + pax("size", "3") },
    { path: "placeholder", size: 0, content: "abc" },
  ])));
  await extractArchive(archivePath, output);
  assert.equal(await readFile(path.join(output, longName), "utf8"), "abc");
});

test("honors GNU long names", async t => {
  const longName = `repo-abc123/${"long".repeat(35)}.ts`;
  const { archivePath, output } = await fixture(t, gzipSync(tar([
    { path: "././@LongLink", type: "L", content: `${longName}\0` },
    { path: "placeholder", content: "long name" },
  ])));
  await extractArchive(archivePath, output);
  assert.equal(await readFile(path.join(output, longName), "utf8"), "long name");
});

test("rejects links and special files explicitly", async t => {
  for (const type of ["1", "2", "3", "4", "6", "S"]) {
    const { archivePath, output } = await fixture(t, gzipSync(tar([
      { path: "repo-abc123/link.ts", type, link: "/etc/passwd" },
    ])));
    await assert.rejects(extractArchive(archivePath, output), /link or special file/);
  }
});

test("rejects unsafe paths in regular files, directories and PAX metadata", async t => {
  for (const unsafe of ["repo-abc123/../../escape.ts", "/absolute/file", "C:/file", "repo-abc123/./file",
    "repo-abc123//file", "repo-abc123/file:stream", "repo-abc123/file.", "repo-abc123/CON.ts",
    "repo-abc123/a\\file", "repo-abc123/a\nfile"]) {
    for (const entries of [
      [{ path: unsafe }],
      [{ path: `${unsafe}/`, type: "5" }],
      [{ path: "PaxHeader", type: "x", content: pax("path", unsafe) }, { path: "repo-abc123/file" }],
    ]) {
      const { archivePath, output } = await fixture(t, gzipSync(tar(entries)));
      await assert.rejects(extractArchive(archivePath, output), /unsafe path/);
    }
  }
});

test("rejects malformed tar numeric fields without parsing a valid prefix", async t => {
  for (const sizeField of ["00000000008\0", "00000000001x", "-0000000001\0", "\x800000000001\0", "1\0ignored"]) {
    const { archivePath, output } = await fixture(t, gzipSync(tar([{ path: "repo-abc123/file", sizeField }])));
    await assert.rejects(extractArchive(archivePath, output), /invalid numeric field/);
  }
});

test("rejects malformed, unsupported and dangling PAX metadata", async t => {
  for (const content of ["99 path=repo-abc123/file\n", "0 path=x\n", "14 path=x", pax("size", "-1"),
    pax("size", "1x"), pax("size", "9007199254740992"), pax("GNU.sparse.map", "0,1")]) {
    const { archivePath, output } = await fixture(t, gzipSync(tar([
      { path: "PaxHeader", type: "x", content }, { path: "repo-abc123/file" },
    ])));
    await assert.rejects(extractArchive(archivePath, output), /PAX|sparse/);
  }
  for (const type of ["x", "g"]) {
    const { archivePath, output } = await fixture(t, gzipSync(tar([
      { path: "PaxHeader", type, content: pax("path", "repo-abc123/file") },
    ])));
    await assert.rejects(extractArchive(archivePath, output), /inside an entry|global PAX/);
  }
});

test("bounds individual and total metadata before buffering it", async t => {
  for (const type of ["x", "g", "L"]) {
    const { archivePath, output } = await fixture(t, gzipSync(tar([
      { path: "PaxHeader", type, size: 1024 * 1024 + 1 },
    ])));
    await assert.rejects(extractArchive(archivePath, output), /metadata limit/);
  }
  const content = pax("comment", "x".repeat(1024 * 1024 - 64));
  const { archivePath, output } = await fixture(t, gzipSync(tar(
    Array.from({ length: 9 }, () => ({ path: "PaxHeader", type: "g", content })),
  )));
  await assert.rejects(extractArchive(archivePath, output), /metadata limit/);
});

test("bounds all decompressed bytes, including trailing zero padding", async t => {
  const { archivePath, output } = await fixture(t);
  const zeroMiB = Buffer.alloc(1024 * 1024);
  async function* chunks() {
    yield tar([{ path: "repo-abc123/file" }]);
    for (let index = 0; index < 221; index += 1) yield zeroMiB;
  }
  await pipeline(Readable.from(chunks()), createGzip(), createWriteStream(archivePath));
  await assert.rejects(extractArchive(archivePath, output), /220 MiB decompressed limit/);
});

test("bounds directories and metadata in the entry count", async t => {
  for (const entry of [{ path: "repo-abc123/", type: "5" }, { path: "PaxHeader", type: "g" }]) {
    const { archivePath, output } = await fixture(t, gzipSync(tar(Array.from({ length: 20_001 }, () => entry))));
    await assert.rejects(extractArchive(archivePath, output), /20,000 entries/);
  }
});

test("rejects oversized declared content before opening a file", async t => {
  const { archivePath, output } = await fixture(t, gzipSync(tar([
    { path: "repo-abc123/file", size: 200 * 1024 * 1024 + 1 },
  ])));
  await assert.rejects(extractArchive(archivePath, output), /200 MiB limit/);
  assert.deepEqual(await readdir(output), []);
});

test("rejects multiple roots, root files, directory bodies and duplicate files", async t => {
  for (const [entries, message] of [
    [[{ path: "repo-one/", type: "5" }, { path: "repo-two/file" }], /more than one root/],
    [[{ path: "repo-file", content: "x" }], /root directory/],
    [[{ path: "repo/", type: "5", content: "x" }], /nonzero size/],
    [[{ path: "repo/file" }, { path: "repo/file", content: "overwrite" }], /EEXIST/],
  ] satisfies [Entry[], RegExp][]) {
    const { archivePath, output } = await fixture(t, gzipSync(tar(entries)));
    await assert.rejects(extractArchive(archivePath, output), message);
  }
});

test("rejects corrupt checksums, partial entries, headers, padding and missing end markers", async t => {
  const fileHeader = header({ path: "repo/file", size: 4 });
  const corrupt = Buffer.from(fileHeader);
  corrupt[0] ^= 1;
  for (const [body, message] of [
    [corrupt, /corrupt/],
    [Buffer.concat([fileHeader, Buffer.from("a")]), /inside an entry/],
    [Buffer.concat([fileHeader, Buffer.from("abcd")]), /inside an entry/],
    [Buffer.concat([header({ path: "repo/file" }), Buffer.alloc(5)]), /inside an entry/],
    [header({ path: "repo/file" }), /missing its end marker/],
    [Buffer.concat([tar([{ path: "repo/file" }]), header({ path: "repo/extra" })]), /after its end/],
  ] satisfies [Buffer, RegExp][]) {
    const { archivePath, output } = await fixture(t, gzipSync(body));
    await assert.rejects(extractArchive(archivePath, output), message);
    // On Windows this also verifies no source stream or partial file stays open.
    await rm(archivePath);
    await rm(output, { recursive: true });
  }
});

test("forwards missing-input and gzip errors and closes partial files", async t => {
  for (const content of [null, Buffer.from("not gzip"), gzipSync(tar([
    { path: "repo/file", content: "x".repeat(64 * 1024) },
  ])).subarray(0, -8)]) {
    const { archivePath, output } = await fixture(t, content ?? undefined);
    if (content === null) await rm(archivePath);
    await assert.rejects(extractArchive(archivePath, output), /ENOENT|header|unexpected end/i);
    await rm(output, { recursive: true });
    if (content !== null) await rm(archivePath);
  }
});

test("requires an empty destination and preserves existing contents", async t => {
  const { archivePath, output } = await fixture(t, gzipSync(tar([{ path: "repo/file", content: "archive" }])));
  await writeFile(path.join(output, "existing"), "keep");
  await assert.rejects(extractArchive(archivePath, output), /new empty directory/);
  assert.equal(await readFile(path.join(output, "existing"), "utf8"), "keep");
});
