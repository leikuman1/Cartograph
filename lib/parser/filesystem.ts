import { lstatSync, readdirSync, type Stats } from "node:fs";
import path from "node:path";
import { ts } from "ts-morph";

// Repository configuration and imports are untrusted. Check every path segment
// before TypeScript can read it; a lexical prefix alone would follow symlinks.
export function createRepositoryFileSystem(rootPath: string) {
  const blocked = new Set<"outside-repository-root" | "symlink-not-followed">();
  const entries = new Map<string, Stats | undefined>();

  function entry(filePath: string): Stats | undefined {
    const absolute = path.resolve(rootPath, filePath);
    const relative = path.relative(rootPath, absolute);
    if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      blocked.add("outside-repository-root");
      return undefined;
    }
    let current = rootPath;
    const segments = relative ? relative.split(path.sep) : [];
    for (let index = -1; index < segments.length; index += 1) {
      if (index >= 0) current = path.join(current, segments[index]);
      if (!entries.has(current)) {
        try {
          entries.set(current, lstatSync(current, { throwIfNoEntry: false }));
        } catch {
          entries.set(current, undefined);
        }
      }
      const info = entries.get(current);
      if (!info) return undefined;
      if (info.isSymbolicLink()) {
        blocked.add("symlink-not-followed");
        return undefined;
      }
      if (index < segments.length - 1 && !info.isDirectory()) return undefined;
      if (index === segments.length - 1) return info;
    }
    return undefined;
  }

  const host: ts.ModuleResolutionHost = {
    fileExists: filePath => entry(filePath)?.isFile() ?? false,
    directoryExists: directory => entry(directory)?.isDirectory() ?? false,
    readFile: filePath => entry(filePath)?.isFile()
      ? ts.sys.readFile(path.resolve(rootPath, filePath)) : undefined,
    getDirectories: directory => {
      if (!entry(directory)?.isDirectory()) return [];
      return readdirSync(path.resolve(rootPath, directory))
        .filter(name => entry(path.resolve(rootPath, directory, name))?.isDirectory());
    },
    // All accepted paths have already been checked for symlink segments.
    realpath: filePath => path.resolve(rootPath, filePath),
    getCurrentDirectory: () => rootPath,
    useCaseSensitiveFileNames: ts.sys.useCaseSensitiveFileNames,
  };
  return { host, blocked };
}

export type RepositoryFileSystem = ReturnType<typeof createRepositoryFileSystem>;
