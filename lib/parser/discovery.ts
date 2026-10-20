import { createHash } from "node:crypto";
import { readFile, readdir, realpath, stat } from "node:fs/promises";
import path from "node:path";
import createIgnore from "ignore";
import type { ExcludedDirectory, SkippedFile } from "./contract";

const SOURCE_EXTENSIONS = new Set([
  ".ts",
  ".tsx",
  ".mts",
  ".cts",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
]);
const STRUCTURAL_DIRECTORIES = new Set([".git", "node_modules"]);
const utf8Decoder = new TextDecoder("utf-8", { fatal: true });

type IgnoreManager = ReturnType<typeof createIgnore>;

interface IgnoreScope {
  directory: string;
  source: string;
  manager: IgnoreManager;
}

export interface DiscoveredSourceFile {
  absolutePath: string;
  path: string;
  folder: string;
  content: string;
  contentHash: string;
  lineCount: number;
}

export interface DiscoveryResult {
  rootPath: string;
  sourceFiles: DiscoveredSourceFile[];
  skippedFiles: SkippedFile[];
  excludedDirectories: ExcludedDirectory[];
  packageDirectories: Set<string>;
}

function compareText(left: string, right: string) {
  return left < right ? -1 : left > right ? 1 : 0;
}

export function toRepositoryPath(value: string) {
  return value.split(path.sep).join("/");
}

function repositoryPath(rootPath: string, absolutePath: string) {
  const relativePath = path.relative(rootPath, absolutePath);
  if (!relativePath || relativePath === ".." || relativePath.startsWith(`..${path.sep}`) || path.isAbsolute(relativePath)) {
    throw new Error(`Path is outside the repository root: ${absolutePath}.`);
  }
  return toRepositoryPath(relativePath);
}

function folderFor(repositoryFilePath: string) {
  const folder = path.posix.dirname(repositoryFilePath);
  return folder === "" ? "." : folder;
}

function countLines(content: string) {
  if (content.length === 0) return 0;
  let count = 0;
  for (let index = 0; index < content.length; index += 1) {
    if (content[index] === "\n") count += 1;
    else if (content[index] === "\r" && content[index + 1] !== "\n") count += 1;
  }
  const lastCharacter = content[content.length - 1];
  return lastCharacter === "\n" || lastCharacter === "\r" ? count : count + 1;
}

function pathWithinScope(scope: IgnoreScope, repositoryFilePath: string) {
  if (scope.directory === ".") return repositoryFilePath;
  if (repositoryFilePath === scope.directory) return "";
  const prefix = `${scope.directory}/`;
  return repositoryFilePath.startsWith(prefix)
    ? repositoryFilePath.slice(prefix.length)
    : null;
}

function ignoredBy(
  scopes: readonly IgnoreScope[],
  repositoryFilePath: string,
  directory: boolean,
) {
  let ignored = false;
  let source: string | null = null;

  for (const scope of scopes) {
    const localPath = pathWithinScope(scope, repositoryFilePath);
    if (!localPath) continue;
    const result = scope.manager.test(directory ? `${localPath}/` : localPath);
    if (result.ignored) {
      ignored = true;
      source = scope.source;
    } else if (result.unignored) {
      ignored = false;
      source = scope.source;
    }
  }

  return ignored ? source : null;
}

async function localIgnoreScope(
  directoryPath: string,
  repositoryDirectory: string,
  entries: readonly { name: string; isFile(): boolean }[],
): Promise<IgnoreScope | null> {
  const ignoreEntry = entries.find(entry => entry.name === ".gitignore" && entry.isFile());
  if (!ignoreEntry) return null;

  const ignorePath = path.join(directoryPath, ignoreEntry.name);
  let content: string;
  try {
    content = utf8Decoder.decode(await readFile(ignorePath));
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Cannot read ${toRepositoryPath(path.join(repositoryDirectory, ".gitignore"))}: ${detail}`);
  }

  const source = repositoryDirectory === "."
    ? ".gitignore"
    : `${repositoryDirectory}/.gitignore`;
  const manager = createIgnore();
  for (const [index, pattern] of content.split(/\r\n|\r|\n/).entries()) {
    manager.add({ pattern, mark: `${source}:${index + 1}` });
  }
  return {
    directory: repositoryDirectory,
    source,
    manager,
  };
}

function detailFor(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

export async function discoverRepository(
  directory: string,
  omittedFiles: readonly SkippedFile[] = [],
): Promise<DiscoveryResult> {
  const rootPath = await realpath(directory);
  const rootStats = await stat(rootPath);
  if (!rootStats.isDirectory()) throw new Error(`Repository path is not a directory: ${directory}.`);

  const sourceFiles: DiscoveredSourceFile[] = [];
  const skippedFiles: SkippedFile[] = [...omittedFiles];
  const excludedDirectories: ExcludedDirectory[] = [];
  const packageDirectories = new Set<string>();

  async function walk(
    directoryPath: string,
    repositoryDirectory: string,
    inheritedScopes: readonly IgnoreScope[],
  ): Promise<void> {
    const entries = (await readdir(directoryPath, { withFileTypes: true }))
      .sort((left, right) => compareText(left.name, right.name));
    const scope = await localIgnoreScope(directoryPath, repositoryDirectory, entries);
    const scopes = scope ? [...inheritedScopes, scope] : inheritedScopes;

    if (entries.some(entry => entry.name === "package.json" && entry.isFile())) {
      packageDirectories.add(repositoryDirectory);
    }

    for (const entry of entries) {
      const absolutePath = path.join(directoryPath, entry.name);
      const relativePath = repositoryPath(rootPath, absolutePath);

      if (entry.isSymbolicLink()) {
        let targetIsDirectory = false;
        try {
          targetIsDirectory = (await stat(absolutePath)).isDirectory();
        } catch {
          targetIsDirectory = false;
        }
        if (targetIsDirectory) {
          excludedDirectories.push({ path: relativePath, reason: "symlink" });
        } else {
          skippedFiles.push({ path: relativePath, reason: "symlink" });
        }
        continue;
      }

      if (entry.isDirectory()) {
        if (STRUCTURAL_DIRECTORIES.has(entry.name)) {
          excludedDirectories.push({
            path: relativePath,
            reason: "structural-exclusion",
            detail: entry.name,
          });
          continue;
        }
        const ignoreSource = ignoredBy(scopes, relativePath, true);
        if (ignoreSource) {
          excludedDirectories.push({
            path: relativePath,
            reason: "ignored",
            detail: ignoreSource,
          });
          continue;
        }
        await walk(absolutePath, relativePath, scopes);
        continue;
      }

      if (!entry.isFile()) {
        skippedFiles.push({ path: relativePath, reason: "unsupported-file-type" });
        continue;
      }

      const ignoreSource = ignoredBy(scopes, relativePath, false);
      if (ignoreSource) {
        skippedFiles.push({ path: relativePath, reason: "ignored", detail: ignoreSource });
        continue;
      }

      if (!SOURCE_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) {
        skippedFiles.push({ path: relativePath, reason: "unsupported-extension" });
        continue;
      }

      let bytes: Buffer;
      try {
        bytes = await readFile(absolutePath);
      } catch (error) {
        skippedFiles.push({ path: relativePath, reason: "read-failed", detail: detailFor(error) });
        continue;
      }

      let content: string;
      try {
        content = utf8Decoder.decode(bytes);
      } catch (error) {
        skippedFiles.push({ path: relativePath, reason: "invalid-utf8", detail: detailFor(error) });
        continue;
      }

      sourceFiles.push({
        absolutePath,
        path: relativePath,
        folder: folderFor(relativePath),
        content,
        contentHash: createHash("sha256").update(bytes).digest("hex"),
        lineCount: countLines(content),
      });
    }
  }

  await walk(rootPath, ".", []);
  sourceFiles.sort((left, right) => compareText(left.path, right.path));
  skippedFiles.sort((left, right) => compareText(left.path, right.path));
  excludedDirectories.sort((left, right) => compareText(left.path, right.path));

  return {
    rootPath,
    sourceFiles,
    skippedFiles,
    excludedDirectories,
    packageDirectories,
  };
}
