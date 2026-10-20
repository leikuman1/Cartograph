import path from "node:path";
import { Project, ts, type SourceFile } from "ts-morph";
import type { ImportResolution, SkippedFile } from "./contract";
import type { DiscoveredSourceFile } from "./discovery";
import { toRepositoryPath } from "./discovery";
import { createRepositoryFileSystem, type RepositoryFileSystem } from "./filesystem";

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
  fileSystem: RepositoryFileSystem;
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

function nearestConfig(
  directory: string,
  rootPath: string,
  cache: Map<string, string | null>,
  host: ts.ModuleResolutionHost,
): string | null {
  const cached = cache.get(directory);
  if (cached !== undefined) return cached;

  for (const name of ["tsconfig.json", "jsconfig.json"]) {
    const candidate = path.join(directory, name);
    if (host.fileExists(candidate)) {
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
    : nearestConfig(parent, rootPath, cache, host);
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

function loadCompilerOptions(configPath: string | null, rootPath: string, fileSystem: RepositoryFileSystem) {
  if (!configPath) {
    return {
      compilerOptions: DEFAULT_COMPILER_OPTIONS,
      configDirectory: rootPath,
    };
  }

  const unrecoverable: ts.Diagnostic[] = [];
  fileSystem.blocked.clear();
  const parsed = ts.getParsedCommandLineOfConfigFile(configPath, undefined, {
    ...fileSystem.host,
    readFile: filePath => fileSystem.host.readFile(filePath),
    // Discovery already selected every input. Config globs must not enumerate
    // the filesystem again or escape the repository through include patterns.
    readDirectory: () => [],
    useCaseSensitiveFileNames: ts.sys.useCaseSensitiveFileNames,
    getCurrentDirectory: () => rootPath,
    onUnRecoverableConfigFileDiagnostic: diagnostic => unrecoverable.push(diagnostic),
  });
  if (fileSystem.blocked.has("symlink-not-followed") || fileSystem.blocked.has("unsupported-file-type")) {
    throw new Error(`Cannot load TypeScript configuration ${configPath}: links and special files are not followed.`);
  }
  // TypeScript probes parent node_modules folders for package-based extends.
  // Outside probes see no entries; an unavailable extends remains a TS error.
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
  omittedFiles: readonly SkippedFile[] = [],
): Promise<ParsedRepository> {
  const configCache = new Map<string, string | null>();
  const fileSystem = createRepositoryFileSystem(rootPath, omittedFiles);
  const groups = new Map<string, DiscoveredSourceFile[]>();

  for (const file of discoveredFiles) {
    fileSystem.blocked.clear();
    const configPath = nearestConfig(path.dirname(file.absolutePath), rootPath, configCache, fileSystem.host);
    if (fileSystem.blocked.has("symlink-not-followed") || fileSystem.blocked.has("unsupported-file-type")) {
      throw new Error("Cannot load TypeScript configuration: links and special files are not followed.");
    }
    const key = configPath ?? "\0default";
    const files = groups.get(key) ?? [];
    files.push(file);
    groups.set(key, files);
  }

  const sourceFiles: ParsedSourceFile[] = [];
  const parseFailures: SkippedFile[] = [];
  for (const [key, files] of [...groups.entries()].sort(([left], [right]) => compareText(left, right))) {
    const configPath = key === "\0default" ? null : key;
    const { compilerOptions, configDirectory } = loadCompilerOptions(configPath, rootPath, fileSystem);
    const project = new Project({
      compilerOptions,
      useInMemoryFileSystem: true,
      skipFileDependencyResolution: true,
      skipLoadingLibFiles: true,
    });
    const context: ResolutionContext = {
      compilerOptions,
      configDirectory,
      fileSystem,
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
  return specifier.length >= prefix.length + suffix.length
    && specifier.startsWith(prefix) && specifier.endsWith(suffix)
    ? specifier.slice(prefix.length, specifier.length - suffix.length)
    : null;
}

function matchingPathEntries(specifier: string, context: ResolutionContext) {
  let selected: { substitutions: string[]; wildcard: string; prefixLength: number } | undefined;
  for (const [pattern, substitutions] of Object.entries(context.compilerOptions.paths ?? {})) {
    if (pattern === specifier) return substitutions;
    const wildcard = matchesPathPattern(specifier, pattern);
    const prefixLength = pattern.indexOf("*");
    // TypeScript selects one pattern: exact first, then the longest prefix.
    if (wildcard !== null && (!selected || prefixLength > selected.prefixLength)) {
      selected = { substitutions, wildcard, prefixLength };
    }
  }
  return selected?.substitutions.map(substitution => selected.wildcard
    ? substitution.replace("*", selected.wildcard) : substitution) ?? [];
}

function localCandidates(specifier: string, source: ParsedSourceFile) {
  if (specifier.startsWith(".")) {
    return [path.resolve(path.dirname(source.discovered.absolutePath), specifier)];
  }
  if (path.isAbsolute(specifier)) return [path.resolve(specifier)];

  const { compilerOptions, configDirectory } = source.resolutionContext;
  const substitutions = matchingPathEntries(specifier, source.resolutionContext);
  if (substitutions.length > 0) {
    // Inherited paths are relative to the configuration that declared them.
    const pathsBasePath = compilerOptions.pathsBasePath;
    const base = compilerOptions.baseUrl
      ?? (typeof pathsBasePath === "string" ? pathsBasePath : configDirectory);
    return substitutions.map(substitution => path.resolve(base, substitution));
  }
  return compilerOptions.baseUrl ? [path.resolve(compilerOptions.baseUrl, specifier)] : [];
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

function classifyResolvedPath(
  resolvedPath: string,
  index: ResolutionIndex,
  externalLibraryImport: boolean,
): ImportResolution {
  const resolvedRealPath = path.resolve(resolvedPath);
  const internalTarget = index.parsedPaths.get(canonicalPath(resolvedRealPath));
  if (internalTarget) return { status: "internal", target: internalTarget };

  const repositoryTarget = pathInside(index.rootPath, resolvedRealPath);
  if (!repositoryTarget) return { status: "unresolved", reason: "outside-repository-root" };
  if (externalLibraryImport || hasNodeModulesSegment(resolvedRealPath)) {
    return { status: "external", reason: "resolved-external-library" };
  }

  return {
    status: "excluded",
    target: repositoryTarget,
    reason: excludedReason(index, repositoryTarget),
  };
}

function exactLocalCandidates(
  specifier: string,
  source: ParsedSourceFile,
) {
  if (specifier.includes("?") || specifier.includes("#")) return [];
  if (!path.extname(specifier)) return [];

  const existing: string[] = [];
  for (const candidate of localCandidates(specifier, source)) {
    if (source.resolutionContext.fileSystem.host.fileExists(candidate)) existing.push(candidate);
  }
  return existing;
}

function localFailureReason(specifier: string, source: ParsedSourceFile) {
  const { compilerOptions, fileSystem } = source.resolutionContext;
  // Shared cache hits skip host callbacks; package searches probe unrelated
  // ancestors. Collect fresh evidence only from this import's local candidates.
  fileSystem.blocked.clear();
  const diagnosticOptions: ts.CompilerOptions = {
    ...compilerOptions,
    paths: undefined,
    baseUrl: undefined,
    rootDirs: specifier.startsWith(".") ? compilerOptions.rootDirs : undefined,
  };
  for (const candidate of localCandidates(specifier, source)) {
    fileSystem.host.fileExists(candidate);
    ts.resolveModuleName(candidate, source.discovered.absolutePath, diagnosticOptions, fileSystem.host);
  }
  if (fileSystem.blocked.has("symlink-not-followed")) return "symlink-not-followed";
  if (fileSystem.blocked.has("unsupported-file-type")) return "target-unsupported-file-type";
  return fileSystem.blocked.has("outside-repository-root")
    ? "outside-repository-root" : "typescript-could-not-resolve-local-specifier";
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
  const { fileSystem } = source.resolutionContext;
  fileSystem.blocked.clear();
  const result = ts.resolveModuleName(
    specifier,
    source.discovered.absolutePath,
    source.resolutionContext.compilerOptions,
    fileSystem.host,
    source.resolutionContext.cache,
  );
  if (result.resolvedModule) {
    return classifyResolvedPath(
      result.resolvedModule.resolvedFileName,
      index,
      result.resolvedModule.isExternalLibraryImport === true,
    );
  }

  for (const candidate of exactLocalCandidates(specifier, source)) {
    return classifyResolvedPath(candidate, index, false);
  }

  const pathsMatch = matchingPathEntries(specifier, source.resolutionContext).length > 0;
  if (isBareSpecifier(specifier)
    && !specifier.startsWith("#")
    && !pathsMatch
    && source.resolutionContext.compilerOptions.baseUrl === undefined) {
    return { status: "external", reason: "package-specifier" };
  }

  return { status: "unresolved", reason: localFailureReason(specifier, source) };
}
