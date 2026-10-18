import { realpath, stat } from "node:fs/promises";
import path from "node:path";
import { Project, ts, type SourceFile } from "ts-morph";
import type { ImportResolution, SkippedFile } from "./contract";
import type { DiscoveredSourceFile } from "./discovery";
import { toRepositoryPath } from "./discovery";

const EMPTY_INPUT_DIAGNOSTICS = new Set([18002, 18003]);

const DEFAULT_COMPILER_OPTIONS: ts.CompilerOptions = {
  allowJs: true,
  jsx: ts.JsxEmit.Preserve,
  module: ts.ModuleKind.ESNext,
  moduleResolution: ts.ModuleResolutionKind.Bundler,
  resolveJsonModule: true,
  target: ts.ScriptTarget.ESNext,
};

interface ResolutionContext {
  compilerOptions: ts.CompilerOptions;
  configDirectory: string;
  cache: ts.ModuleResolutionCache;
}

export interface ParsedSourceFile {
  discovered: DiscoveredSourceFile;
  sourceFile: SourceFile;
  resolutionContext: ResolutionContext;
}

export interface ParsedRepository {
  sourceFiles: ParsedSourceFile[];
  parseFailures: SkippedFile[];
}

export interface ResolutionIndex {
  rootPath: string;
  parsedPaths: Map<string, string>;
  skippedFiles: Map<string, SkippedFile>;
  excludedDirectories: Array<{ path: string; reason: string }>;
}

function compareText(left: string, right: string) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function canonicalPath(value: string) {
  const normalized = path.normalize(value);
  return ts.sys.useCaseSensitiveFileNames ? normalized : normalized.toLowerCase();
}

function pathInside(rootPath: string, targetPath: string) {
  const relativePath = path.relative(rootPath, targetPath);
  if (!relativePath || relativePath === ".." || relativePath.startsWith(`..${path.sep}`) || path.isAbsolute(relativePath)) {
    return null;
  }
  return toRepositoryPath(relativePath);
}

async function isFile(filePath: string) {
  try {
    return (await stat(filePath)).isFile();
  } catch {
    return false;
  }
}

async function nearestConfig(
  directory: string,
  rootPath: string,
  cache: Map<string, string | null>,
): Promise<string | null> {
  const cached = cache.get(directory);
  if (cached !== undefined) return cached;

  for (const name of ["tsconfig.json", "jsconfig.json"]) {
    const candidate = path.join(directory, name);
    if (await isFile(candidate)) {
      cache.set(directory, candidate);
      return candidate;
    }
  }

  if (directory === rootPath) {
    cache.set(directory, null);
    return null;
  }

  const parent = path.dirname(directory);
  const parentOutsideRoot = parent !== rootPath && pathInside(rootPath, parent) === null;
  const result = parent === directory || parentOutsideRoot
    ? null
    : await nearestConfig(parent, rootPath, cache);
  cache.set(directory, result);
  return result;
}

function formatDiagnostics(diagnostics: readonly ts.Diagnostic[]) {
  return ts.formatDiagnostics(diagnostics, {
    getCanonicalFileName: fileName => canonicalPath(fileName),
    getCurrentDirectory: () => process.cwd(),
    getNewLine: () => "\n",
  }).trim();
}

function loadCompilerOptions(configPath: string | null, rootPath: string) {
  if (!configPath) {
    return {
      compilerOptions: DEFAULT_COMPILER_OPTIONS,
      configDirectory: rootPath,
    };
  }

  const unrecoverable: ts.Diagnostic[] = [];
  const parsed = ts.getParsedCommandLineOfConfigFile(configPath, undefined, {
    fileExists: ts.sys.fileExists,
    readDirectory: ts.sys.readDirectory,
    readFile: ts.sys.readFile,
    useCaseSensitiveFileNames: ts.sys.useCaseSensitiveFileNames,
    getCurrentDirectory: () => rootPath,
    onUnRecoverableConfigFileDiagnostic: diagnostic => unrecoverable.push(diagnostic),
  });
  // Discovery selects the source files; an empty config input list does not invalidate its options.
  const errors = [
    ...unrecoverable,
    ...(parsed?.errors ?? []),
  ].filter(diagnostic => diagnostic.category === ts.DiagnosticCategory.Error
    && !EMPTY_INPUT_DIAGNOSTICS.has(diagnostic.code));
  if (!parsed || errors.length > 0) {
    const details = errors.length > 0 ? `\n${formatDiagnostics(errors)}` : "";
    throw new Error(`Cannot load TypeScript configuration ${configPath}.${details}`);
  }

  return {
    compilerOptions: { ...parsed.options, allowJs: true },
    configDirectory: path.dirname(configPath),
  };
}

function syntacticFailure(project: Project, sourceFile: SourceFile) {
  const diagnostics = project.getProgram().getSyntacticDiagnostics(sourceFile);
  if (diagnostics.length === 0) return null;
  return diagnostics
    .slice(0, 3)
    .map(diagnostic => {
      const line = diagnostic.getLineNumber();
      const message = ts.flattenDiagnosticMessageText(diagnostic.compilerObject.messageText, "\n");
      return line === undefined ? message : `line ${line}: ${message}`;
    })
    .join("; ");
}

export async function parseSourceFiles(
  rootPath: string,
  discoveredFiles: readonly DiscoveredSourceFile[],
): Promise<ParsedRepository> {
  const configCache = new Map<string, string | null>();
  const groups = new Map<string, DiscoveredSourceFile[]>();

  for (const file of discoveredFiles) {
    const configPath = await nearestConfig(path.dirname(file.absolutePath), rootPath, configCache);
    const key = configPath ?? "\0default";
    const files = groups.get(key) ?? [];
    files.push(file);
    groups.set(key, files);
  }

  const sourceFiles: ParsedSourceFile[] = [];
  const parseFailures: SkippedFile[] = [];
  for (const [key, files] of [...groups.entries()].sort(([left], [right]) => compareText(left, right))) {
    const configPath = key === "\0default" ? null : key;
    const { compilerOptions, configDirectory } = loadCompilerOptions(configPath, rootPath);
    const project = new Project({
      compilerOptions,
      skipFileDependencyResolution: true,
      skipLoadingLibFiles: true,
    });
    const context: ResolutionContext = {
      compilerOptions,
      configDirectory,
      cache: ts.createModuleResolutionCache(
        configDirectory,
        canonicalPath,
        compilerOptions,
      ),
    };
    const created = new Map<string, SourceFile>();

    for (const file of files) {
      try {
        created.set(
          file.path,
          project.createSourceFile(file.absolutePath, file.content, { overwrite: true }),
        );
      } catch (error) {
        parseFailures.push({
          path: file.path,
          reason: "parse-failed",
          detail: error instanceof Error ? error.message : String(error),
        });
      }
    }

    for (const file of files) {
      const sourceFile = created.get(file.path);
      if (!sourceFile) continue;
      const failure = syntacticFailure(project, sourceFile);
      if (failure) {
        parseFailures.push({ path: file.path, reason: "parse-failed", detail: failure });
        continue;
      }
      sourceFiles.push({ discovered: file, sourceFile, resolutionContext: context });
    }
  }

  sourceFiles.sort((left, right) => compareText(left.discovered.path, right.discovered.path));
  parseFailures.sort((left, right) => compareText(left.path, right.path));
  return { sourceFiles, parseFailures };
}

function matchesPathPattern(specifier: string, pattern: string) {
  const star = pattern.indexOf("*");
  if (star === -1) return specifier === pattern ? "" : null;
  const prefix = pattern.slice(0, star);
  const suffix = pattern.slice(star + 1);
  return specifier.startsWith(prefix) && specifier.endsWith(suffix)
    ? specifier.slice(prefix.length, specifier.length - suffix.length)
    : null;
}

function matchingPathEntries(specifier: string, context: ResolutionContext) {
  const matches: string[] = [];
  for (const [pattern, substitutions] of Object.entries(context.compilerOptions.paths ?? {})) {
    const wildcard = matchesPathPattern(specifier, pattern);
    if (wildcard === null) continue;
    for (const substitution of substitutions) {
      matches.push(substitution.replace("*", wildcard));
    }
  }
  return matches;
}

function isBareSpecifier(specifier: string) {
  return !specifier.startsWith(".") && !specifier.startsWith("/") && !path.isAbsolute(specifier);
}

function hasNodeModulesSegment(value: string) {
  return path.normalize(value).split(path.sep).includes("node_modules");
}

function excludedReason(index: ResolutionIndex, repositoryTarget: string) {
  const skipped = index.skippedFiles.get(repositoryTarget);
  if (skipped) return `target-${skipped.reason}`;

  const directory = index.excludedDirectories.find(candidate =>
    repositoryTarget === candidate.path || repositoryTarget.startsWith(`${candidate.path}/`),
  );
  return directory ? `target-in-${directory.reason}-directory` : "resolved-target-not-parsed";
}

async function classifyResolvedPath(
  resolvedPath: string,
  index: ResolutionIndex,
  externalLibraryImport: boolean,
): Promise<ImportResolution> {
  let resolvedRealPath: string;
  try {
    resolvedRealPath = await realpath(resolvedPath);
  } catch {
    return externalLibraryImport
      ? { status: "external", reason: "resolved-external-library" }
      : { status: "unresolved", reason: "resolved-file-no-longer-exists" };
  }

  const internalTarget = index.parsedPaths.get(canonicalPath(resolvedRealPath));
  if (internalTarget) return { status: "internal", target: internalTarget };

  const repositoryTarget = pathInside(index.rootPath, resolvedRealPath);
  if (!repositoryTarget) return { status: "external", reason: "resolved-outside-root" };
  if (externalLibraryImport || hasNodeModulesSegment(resolvedRealPath)) {
    return { status: "external", reason: "resolved-external-library" };
  }

  return {
    status: "excluded",
    target: repositoryTarget,
    reason: excludedReason(index, repositoryTarget),
  };
}

async function exactLocalCandidates(
  specifier: string,
  source: ParsedSourceFile,
) {
  if (specifier.includes("?") || specifier.includes("#")) return [];
  if (!path.extname(specifier)) return [];

  const candidates: string[] = [];
  if (specifier.startsWith(".")) {
    candidates.push(path.resolve(path.dirname(source.discovered.absolutePath), specifier));
  } else if (path.isAbsolute(specifier)) {
    candidates.push(path.resolve(specifier));
  } else {
    for (const substitution of matchingPathEntries(specifier, source.resolutionContext)) {
      candidates.push(path.resolve(
        source.resolutionContext.compilerOptions.baseUrl ?? source.resolutionContext.configDirectory,
        substitution,
      ));
    }
    if (source.resolutionContext.compilerOptions.baseUrl) {
      candidates.push(path.resolve(source.resolutionContext.compilerOptions.baseUrl, specifier));
    }
  }

  const existing: string[] = [];
  for (const candidate of candidates) {
    if (await isFile(candidate)) existing.push(candidate);
  }
  return existing;
}

export function createResolutionIndex(
  rootPath: string,
  sourceFiles: readonly ParsedSourceFile[],
  skippedFiles: readonly SkippedFile[],
  excludedDirectories: readonly { path: string; reason: string }[],
): ResolutionIndex {
  return {
    rootPath,
    parsedPaths: new Map(sourceFiles.map(file => [
      canonicalPath(file.discovered.absolutePath),
      file.discovered.path,
    ])),
    skippedFiles: new Map(skippedFiles.map(file => [file.path, file])),
    excludedDirectories: [...excludedDirectories]
      .sort((left, right) => right.path.length - left.path.length),
  };
}

export async function resolveImport(
  source: ParsedSourceFile,
  specifier: string,
  index: ResolutionIndex,
): Promise<ImportResolution> {
  const result = ts.resolveModuleName(
    specifier,
    source.discovered.absolutePath,
    source.resolutionContext.compilerOptions,
    ts.sys,
    source.resolutionContext.cache,
  );
  if (result.resolvedModule) {
    return classifyResolvedPath(
      result.resolvedModule.resolvedFileName,
      index,
      result.resolvedModule.isExternalLibraryImport === true,
    );
  }

  for (const candidate of await exactLocalCandidates(specifier, source)) {
    return classifyResolvedPath(candidate, index, false);
  }

  const pathsMatch = matchingPathEntries(specifier, source.resolutionContext).length > 0;
  if (isBareSpecifier(specifier)
    && !specifier.startsWith("#")
    && !pathsMatch
    && source.resolutionContext.compilerOptions.baseUrl === undefined) {
    return { status: "external", reason: "package-specifier" };
  }

  return { status: "unresolved", reason: "typescript-could-not-resolve-local-specifier" };
}
