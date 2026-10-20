import { createReadStream, createWriteStream } from "node:fs";
import { lstat, mkdir, mkdtemp, open, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable, Transform, Writable } from "node:stream";
import { pipeline as streamPipeline } from "node:stream/promises";
import { createGunzip } from "node:zlib";

const GITHUB_API = "https://api.github.com";
const ARCHIVE_HOST = "codeload.github.com";
const API_TIMEOUT_MS = 20_000;
const ARCHIVE_TIMEOUT_MS = 120_000;
const MAX_ARCHIVE_BYTES = 50 * 1024 * 1024;
const MAX_EXTRACTED_BYTES = 200 * 1024 * 1024;
const MAX_DECOMPRESSED_BYTES = 220 * 1024 * 1024;
const MAX_METADATA_BYTES = 1024 * 1024;
const MAX_TOTAL_METADATA_BYTES = 8 * 1024 * 1024;
const MAX_ENTRIES = 20_000;

export interface RepositoryReference {
  url: string;
  owner: string;
  name: string;
  fullName: string;
}

export interface FetchedRepository {
  directory: string;
  commitSha: string;
  cleanup: () => Promise<void>;
}

const OWNER = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const NAME = /^[A-Za-z0-9._-]{1,100}$/;
const SHA = /^[0-9a-f]{40}$/;

// Only a plain public repository URL is accepted. No credentials, query, hash,
// subdirectory or trailing path: those would change which archive is fetched.
export function normalizeRepositoryUrl(input: string): RepositoryReference {
  const value = input.trim();
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error("Enter a repository URL such as https://github.com/owner/repository.");
  }
  if (parsed.protocol !== "https:" || parsed.hostname.toLowerCase() !== "github.com"
    || parsed.port || parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error("Only a public https://github.com/owner/repository URL is accepted.");
  }
  const segments = parsed.pathname.replace(/\/$/, "").slice(1).split("/");
  if (segments.length !== 2) {
    throw new Error("The URL must point at a repository, not a page inside one.");
  }
  const [owner, rawName] = segments;
  const name = rawName.toLowerCase().endsWith(".git") ? rawName.slice(0, -4) : rawName;
  if (!OWNER.test(owner) || !NAME.test(name) || name === "." || name === "..") {
    throw new Error("The repository owner or name is not valid.");
  }
  const fullName = `${owner}/${name}`;
  return { url: `https://github.com/${fullName}`, owner, name, fullName };
}

async function githubJson(pathname: string, signal: AbortSignal) {
  const response = await fetch(`${GITHUB_API}${pathname}`, {
    headers: {
      Accept: "application/vnd.github+json",
      "User-Agent": "cartograph-local",
      "X-GitHub-Api-Version": "2022-11-28",
    },
    redirect: "error",
    signal,
  });
  if (response.status === 404) {
    throw new Error("That repository does not exist or is not public.");
  }
  if (response.status === 403 || response.status === 429) {
    throw new Error("GitHub rate-limited the request. Wait a few minutes and try again.");
  }
  if (!response.ok) {
    throw new Error(`GitHub metadata request failed (HTTP ${response.status}).`);
  }
  return response.json() as Promise<unknown>;
}

function readRecord(value: unknown) {
  return typeof value === "object" && value !== null ? value as Record<string, unknown> : null;
}

async function defaultBranch(repository: RepositoryReference, signal: AbortSignal) {
  const metadata = readRecord(await githubJson(`/repos/${repository.fullName}`, signal));
  const branch = metadata?.default_branch;
  if (typeof branch !== "string" || branch.length === 0) {
    throw new Error("GitHub did not report a default branch for this repository.");
  }
  const commit = readRecord(await githubJson(
    `/repos/${repository.fullName}/commits/${encodeURIComponent(branch)}`,
    signal,
  ));
  const sha = commit?.sha;
  if (typeof sha !== "string" || !SHA.test(sha)) {
    throw new Error("GitHub did not report a commit for the default branch.");
  }
  return sha;
}

async function downloadArchive(repository: RepositoryReference, commitSha: string, filePath: string) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), ARCHIVE_TIMEOUT_MS);
  let response: Response | undefined;
  try {
    response = await fetch(
      `https://${ARCHIVE_HOST}/${repository.fullName}/tar.gz/${commitSha}`,
      { headers: { "User-Agent": "cartograph-local" }, redirect: "error", signal: controller.signal },
    );
    if (!response.ok || !response.body) {
      throw new Error(`The repository archive could not be downloaded (HTTP ${response.status}).`);
    }
    const declared = Number(response.headers.get("content-length"));
    if (Number.isFinite(declared) && declared > MAX_ARCHIVE_BYTES) {
      throw new Error("The repository archive is larger than the 50 MiB limit.");
    }
    let written = 0;
    const limit = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        written += chunk.length;
        callback(written > MAX_ARCHIVE_BYTES
          ? new Error("The repository archive is larger than the 50 MiB limit.")
          : null, chunk);
      },
    });
    const source = Readable.fromWeb(response.body as import("node:stream/web").ReadableStream);
    await streamPipeline(source, limit, createWriteStream(filePath, { flags: "wx" }));
  } catch (error) {
    if (controller.signal.aborted) throw new Error("The repository archive download timed out.");
    throw error;
  } finally {
    clearTimeout(timeout);
    // A rejected response never enters pipeline, so its body still needs closing.
    if (response?.body && !response.body.locked) await response.body.cancel().catch(() => {});
  }
}

function readString(block: Buffer, offset: number, length: number) {
  const end = block.indexOf(0, offset);
  return new TextDecoder("utf-8", { fatal: true }).decode(
    block.subarray(offset, end >= 0 && end < offset + length ? end : offset + length),
  );
}

function readOctal(block: Buffer, offset: number, length: number) {
  const match = /^ *([0-7]+)?[ \0]*$/.exec(block.subarray(offset, offset + length).toString("latin1"));
  const value = match ? Number.parseInt(match[1] ?? "0", 8) : NaN;
  if (!Number.isSafeInteger(value)) throw new Error("The repository archive contains an invalid numeric field.");
  return value;
}

function safeArchivePath(raw: string, directory: boolean) {
  const value = directory && raw.endsWith("/") ? raw.slice(0, -1) : raw;
  const segments = value.split("/");
  // The same archive must stay safe on Windows as well as POSIX. In particular,
  // a colon can open a Windows alternate data stream instead of a source file.
  if (segments.some(segment => !segment || segment === "." || segment === ".."
    || /[\x00-\x1f\x7f\\<>:"|?*]/.test(segment) || /[. ]$/.test(segment)
    || /^(?:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i.test(segment))) {
    throw new Error("The repository archive contains an unsafe path.");
  }
  return value;
}

interface PaxAttributes {
  path?: string;
  size?: number;
}

function readPax(body: Buffer): PaxAttributes {
  const attributes: PaxAttributes = {};
  let offset = 0;
  while (offset < body.length) {
    const space = body.indexOf(32, offset);
    const textLength = body.subarray(offset, space < 0 ? offset : space).toString("latin1");
    const length = /^[1-9][0-9]*$/.test(textLength) ? Number(textLength) : NaN;
    const end = offset + length;
    if (!Number.isSafeInteger(length) || end > body.length || end <= space + 2 || body[end - 1] !== 10) {
      throw new Error("The repository archive contains invalid PAX metadata.");
    }
    const record = new TextDecoder("utf-8", { fatal: true }).decode(body.subarray(space + 1, end - 1));
    const equals = record.indexOf("=");
    if (equals <= 0) throw new Error("The repository archive contains invalid PAX metadata.");
    const key = record.slice(0, equals);
    const value = record.slice(equals + 1);
    if (key === "path") attributes.path = value;
    if (key === "size") {
      if (!/^[0-9]+$/.test(value) || !Number.isSafeInteger(Number(value))) {
        throw new Error("The repository archive contains an invalid PAX size.");
      }
      attributes.size = Number(value);
    }
    if (key.startsWith("GNU.sparse.") || (key === "SCHILY.filetype" && value === "sparse")) {
      throw new Error("The repository archive contains an unsupported sparse file.");
    }
    offset = end;
  }
  return attributes;
}

// Only regular files and directories are extracted. All limits include metadata
// and padding so a tiny compressed input cannot create unbounded work or memory.
export async function extractArchive(archivePath: string, destination: string) {
  const destinationInfo = await lstat(destination);
  if (!destinationInfo.isDirectory() || destinationInfo.isSymbolicLink() || (await readdir(destination)).length) {
    throw new Error("Archive extraction requires a new empty directory.");
  }
  let extractedBytes = 0;
  let decompressedBytes = 0;
  let metadataBytes = 0;
  let entries = 0;
  let rootName: string | null = null;
  let pending: PaxAttributes | null = null;
  let buffer = Buffer.alloc(0);
  let remaining = 0;
  let padding = 0;
  let zeroBlocks = 0;
  let file: Awaited<ReturnType<typeof open>> | null = null;
  let metadata: { type: string; size: number; chunks: Buffer[]; read: number } | null = null;

  async function closeFile() {
    const handle = file;
    file = null;
    await handle?.close();
  }

  function finishMetadata() {
    if (!metadata) return;
    const body = Buffer.concat(metadata.chunks, metadata.size);
    if (metadata.type === "L") {
      pending = { ...pending, path: new TextDecoder("utf-8", { fatal: true }).decode(body).replace(/\0+$/, "") };
    } else {
      const attributes = readPax(body);
      if (metadata.type === "x") pending = { ...pending, ...attributes };
      // GitHub's global PAX header records a commit comment. Global path/size
      // overrides are not emitted by codeload; refusing them avoids guessing.
      else if (attributes.path !== undefined || attributes.size !== undefined) {
        throw new Error("The repository archive contains unsupported global PAX path or size metadata.");
      }
    }
    padding = (512 - (metadata.size % 512)) % 512;
    metadata = null;
  }

  async function consume(chunk: Buffer) {
    decompressedBytes += chunk.length;
    if (decompressedBytes > MAX_DECOMPRESSED_BYTES) {
      throw new Error("The repository archive exceeds the 220 MiB decompressed limit.");
    }
    let offset = 0;
    while (offset < chunk.length) {
      if (zeroBlocks >= 2) {
        if (chunk.subarray(offset).some(byte => byte !== 0)) throw new Error("The repository archive contains data after its end.");
        return;
      }
      if (metadata) {
        const take = Math.min(metadata.size - metadata.read, chunk.length - offset);
        metadata.chunks.push(Buffer.from(chunk.subarray(offset, offset + take)));
        metadata.read += take;
        offset += take;
        if (metadata.read === metadata.size) finishMetadata();
        continue;
      }
      if (remaining > 0) {
        const take = Math.min(remaining, chunk.length - offset);
        if (!file) throw new Error("The repository archive stream was interrupted.");
        let written = 0;
        while (written < take) {
          const result = await file.write(chunk, offset + written, take - written, null);
          if (result.bytesWritten <= 0) throw new Error("The repository archive file could not be written completely.");
          written += result.bytesWritten;
        }
        remaining -= take;
        offset += take;
        if (remaining === 0) await closeFile();
        continue;
      }
      if (padding > 0) {
        const skip = Math.min(padding, chunk.length - offset);
        padding -= skip;
        offset += skip;
        continue;
      }
      const take = Math.min(512 - buffer.length, chunk.length - offset);
      buffer = Buffer.concat([buffer, chunk.subarray(offset, offset + take)]);
      offset += take;
      if (buffer.length < 512) continue;

      const block = buffer;
      buffer = Buffer.alloc(0);
      if (block.every(byte => byte === 0)) {
        zeroBlocks += 1;
        continue;
      }
      if (zeroBlocks > 0) throw new Error("The repository archive contains an incomplete end marker.");
      entries += 1;
      if (entries > MAX_ENTRIES) throw new Error("The repository archive contains more than 20,000 entries.");
      const storedChecksum = readOctal(block, 148, 8);
      let checksum = 0;
      for (let index = 0; index < 512; index += 1) checksum += index >= 148 && index < 156 ? 32 : block[index];
      if (checksum !== storedChecksum) throw new Error("The repository archive is corrupt.");

      const type = readString(block, 156, 1) || "0";
      const headerSize = readOctal(block, 124, 12);
      if (type === "x" || type === "g" || type === "L") {
        metadataBytes += headerSize;
        if (headerSize > MAX_METADATA_BYTES || metadataBytes > MAX_TOTAL_METADATA_BYTES) {
          throw new Error("The repository archive exceeds the PAX/long-name metadata limit (1 MiB per entry, 8 MiB total).");
        }
        metadata = { type, size: headerSize, chunks: [], read: 0 };
        if (headerSize === 0) finishMetadata();
        continue;
      }
      const attributes = pending;
      pending = null; // A local PAX header applies to the next entry, including a directory.
      if (type !== "0" && type !== "5") {
        throw new Error("The repository archive contains a link or special file, which is not extracted.");
      }
      const size = attributes?.size ?? headerSize;
      const prefix = readString(block, 345, 155);
      const name = readString(block, 0, 100);
      const entryPath = safeArchivePath(attributes?.path ?? (prefix ? `${prefix}/${name}` : name), type === "5");
      const [archiveRoot, ...rest] = entryPath.split("/");
      if (rootName === null) rootName = archiveRoot;
      else if (rootName !== archiveRoot) throw new Error("The repository archive has more than one root.");
      const targetPath = path.join(destination, ...entryPath.split("/"));
      if (type === "5") {
        if (size !== 0) throw new Error("The repository archive contains a directory with a nonzero size.");
        await mkdir(targetPath, { recursive: true });
        continue;
      }
      if (rest.length === 0) throw new Error("The repository archive has a file instead of a root directory.");
      extractedBytes += size;
      if (extractedBytes > MAX_EXTRACTED_BYTES) {
        throw new Error("The extracted repository is larger than the 200 MiB limit.");
      }
      await mkdir(path.dirname(targetPath), { recursive: true });
      // Never overwrite an earlier archive member, including case aliases on Windows.
      file = await open(targetPath, "wx");
      remaining = size;
      padding = (512 - (size % 512)) % 512;
      if (size === 0) await closeFile();
    }
  }

  try {
    // pipeline forwards both input and gzip errors and destroys every stream
    // before we close a partially written file or the caller removes its tree.
    let writing = Promise.resolve();
    const sink = new Writable({
      write(chunk: Buffer, _encoding, callback) {
        writing = consume(chunk);
        writing.then(() => callback(), error => callback(error));
      },
      destroy(error, callback) {
        // An input error can arrive while a file write is pending. Wait for it
        // before pipeline settles so finally cannot close the handle too soon.
        writing.then(() => callback(error), writeError => callback(error ?? writeError));
      },
    });
    await streamPipeline(createReadStream(archivePath), createGunzip(), sink);
    if (remaining > 0 || metadata || padding > 0 || buffer.length || pending) {
      throw new Error("The repository archive ended inside an entry.");
    }
    if (zeroBlocks < 2) throw new Error("The repository archive is missing its end marker.");
    if (rootName === null) throw new Error("The repository archive is empty.");
    const roots = await readdir(destination);
    if (roots.length !== 1 || roots[0] !== rootName || !(await lstat(path.join(destination, rootName))).isDirectory()) {
      throw new Error("The repository archive did not extract to one directory.");
    }
    return path.join(destination, rootName);
  } finally {
    await closeFile();
  }
}

// Downloads and extracts an untrusted public archive. Each archive and each
// extracted tree gets its own new temporary directory; nothing runs from it.
export async function fetchRepository(repository: RepositoryReference): Promise<FetchedRepository> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), API_TIMEOUT_MS);
  let commitSha: string;
  try {
    commitSha = await defaultBranch(repository, controller.signal);
  } catch (error) {
    if (controller.signal.aborted) throw new Error("GitHub metadata request timed out.");
    throw error;
  } finally {
    clearTimeout(timeout);
  }

  const archiveDirectory = await mkdtemp(path.join(tmpdir(), "cartograph-archive-"));
  let extractionDirectory: string | undefined;
  const cleanup = async () => {
    await Promise.all([
      rm(archiveDirectory, { recursive: true, force: true }),
      ...(extractionDirectory ? [rm(extractionDirectory, { recursive: true, force: true })] : []),
    ]);
  };
  try {
    extractionDirectory = await mkdtemp(path.join(tmpdir(), "cartograph-source-"));
    const archivePath = path.join(archiveDirectory, "repository.tar.gz");
    await downloadArchive(repository, commitSha, archivePath);
    const directory = await extractArchive(archivePath, extractionDirectory);
    return { directory, commitSha, cleanup };
  } catch (error) {
    await cleanup();
    throw error;
  }
}
