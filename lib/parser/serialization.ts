import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { categoriesForFramework, FILE_ROLES, FRAMEWORKS, frameworkSupportsEntries, frameworkSupportsRoutes, type FileRole, type Framework } from "../frameworks/taxonomy";
import type {
  AnalysisCoverage,
  AnalysisResult,
  ExcludedDirectory,
  ExcludedDirectoryReason,
  FileCoverage,
  FileNode,
  FileRoleRecord,
  HttpRoute,
  GraphEdge,
  ImportCoverage,
  ImportKind,
  ImportRecord,
  ImportResolution,
  SkippedFile,
  SkippedFileReason,
} from "./contract";
import { buildGraph } from "./graph";
import { compareExportNames } from "./export-names";

type UnknownRecord = Record<string, unknown>;

function fail(context: string, message: string): never {
  throw new Error(`Invalid analysis result at ${context}: ${message}.`);
}

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readRecord(value: unknown, context: string): UnknownRecord {
  if (!isRecord(value)) {
    fail(context, "expected an object");
  }
  return value;
}

function readArray(value: unknown, context: string): readonly unknown[] {
  if (!Array.isArray(value)) fail(context, "expected an array");
  return value;
}

function readString(value: unknown, context: string) {
  if (typeof value !== "string") fail(context, "expected a string");
  return value;
}

function readNonEmptyString(value: unknown, context: string) {
  const result = readString(value, context);
  if (result.length === 0) fail(context, "expected a non-empty string");
  return result;
}

function readInteger(value: unknown, context: string, minimum = 0) {
  if (!Number.isInteger(value) || typeof value !== "number" || value < minimum) {
    fail(context, `expected an integer greater than or equal to ${minimum}`);
  }
  return value;
}

function assertKeys(record: UnknownRecord, context: string, allowed: readonly string[]) {
  const allowedKeys = new Set(allowed);
  for (const key of Object.keys(record)) {
    if (!allowedKeys.has(key)) fail(context, `unexpected field ${key}`);
  }
  for (const key of allowed) {
    if (!(key in record) && key !== "detail" && key !== "target") {
      fail(context, `missing field ${key}`);
    }
  }
}

function readRepositoryPath(value: unknown, context: string, allowRoot = false) {
  const result = readNonEmptyString(value, context);
  if (allowRoot && result === ".") return result;
  if (result === "." || result.includes("\\") || result.startsWith("/") || /^[A-Za-z]:\//.test(result)) {
    fail(context, "expected a repository-relative POSIX path");
  }
  const segments = result.split("/");
  if (segments.some(segment => !segment || segment === "." || segment === "..")) {
    fail(context, "path contains an invalid segment");
  }
  return result;
}

function readImportKind(value: unknown, context: string): ImportKind {
  if (value === "import" || value === "re-export" || value === "dynamic-import" || value === "require") return value;
  return fail(context, "unknown import kind");
}

function readSkippedReason(value: unknown, context: string): SkippedFileReason {
  switch (value) {
    case "ignored":
    case "unsupported-extension":
    case "symlink":
    case "read-failed":
    case "invalid-utf8":
    case "unsupported-file-type":
    case "parse-failed":
      return value;
    default:
      return fail(context, "unknown skipped-file reason");
  }
}

function readExcludedDirectoryReason(value: unknown, context: string): ExcludedDirectoryReason {
  if (value === "ignored" || value === "structural-exclusion" || value === "symlink") return value;
  return fail(context, "unknown excluded-directory reason");
}

function readOptionalDetail(record: UnknownRecord, context: string) {
  if (record.detail === undefined) return undefined;
  return readNonEmptyString(record.detail, `${context}.detail`);
}

function readFileNode(value: unknown, context: string): FileNode {
  const record = readRecord(value, context);
  assertKeys(record, context, [
    "path",
    "folder",
    "module",
    "lineCount",
    "contentHash",
    "fanIn",
    "fanOut",
    ...("exports" in record ? ["exports"] : []),
  ]);
  const contentHash = readString(record.contentHash, `${context}.contentHash`);
  if (!/^[0-9a-f]{64}$/.test(contentHash)) fail(`${context}.contentHash`, "expected a SHA-256 hex digest");
  return {
    path: readRepositoryPath(record.path, `${context}.path`),
    folder: readRepositoryPath(record.folder, `${context}.folder`, true),
    module: readRepositoryPath(record.module, `${context}.module`, true),
    lineCount: readInteger(record.lineCount, `${context}.lineCount`),
    contentHash,
    fanIn: readInteger(record.fanIn, `${context}.fanIn`),
    fanOut: readInteger(record.fanOut, `${context}.fanOut`),
    exports: "exports" in record ? readArray(record.exports, `${context}.exports`)
      .map((name, index) => readString(name, `${context}.exports[${index}]`)) : [],
  };
}

function readGraphEdge(value: unknown, context: string): GraphEdge {
  const record = readRecord(value, context);
  assertKeys(record, context, ["source", "target", "kinds"]);
  const kinds = readArray(record.kinds, `${context}.kinds`)
    .map((kind, index) => readImportKind(kind, `${context}.kinds[${index}]`));
  if (kinds.length === 0) fail(`${context}.kinds`, "expected at least one kind");
  return {
    source: readRepositoryPath(record.source, `${context}.source`),
    target: readRepositoryPath(record.target, `${context}.target`),
    kinds,
  };
}

function readResolution(value: unknown, context: string): ImportResolution {
  const record = readRecord(value, context);
  const status = readString(record.status, `${context}.status`);
  if (status === "internal") {
    assertKeys(record, context, ["status", "target"]);
    return { status, target: readRepositoryPath(record.target, `${context}.target`) };
  }
  if (status === "external") {
    assertKeys(record, context, ["status", "reason"]);
    return { status, reason: readNonEmptyString(record.reason, `${context}.reason`) };
  }
  if (status === "excluded") {
    assertKeys(record, context, ["status", "reason", "target"]);
    const target = record.target === undefined
      ? undefined
      : readRepositoryPath(record.target, `${context}.target`);
    return {
      status,
      reason: readNonEmptyString(record.reason, `${context}.reason`),
      ...(target === undefined ? {} : { target }),
    };
  }
  if (status === "unresolved") {
    assertKeys(record, context, ["status", "reason"]);
    return { status, reason: readNonEmptyString(record.reason, `${context}.reason`) };
  }
  return fail(`${context}.status`, "unknown resolution status");
}

function readImportRecord(value: unknown, context: string): ImportRecord {
  const record = readRecord(value, context);
  assertKeys(record, context, ["source", "specifier", "kind", "line", "resolution"]);
  const specifier = record.specifier === null
    ? null
    : readString(record.specifier, `${context}.specifier`);
  return {
    source: readRepositoryPath(record.source, `${context}.source`),
    specifier,
    kind: readImportKind(record.kind, `${context}.kind`),
    line: readInteger(record.line, `${context}.line`, 1),
    resolution: readResolution(record.resolution, `${context}.resolution`),
  };
}

function readSkippedFile(value: unknown, context: string): SkippedFile {
  const record = readRecord(value, context);
  assertKeys(record, context, ["path", "reason", "detail"]);
  const detail = readOptionalDetail(record, context);
  return {
    path: readRepositoryPath(record.path, `${context}.path`),
    reason: readSkippedReason(record.reason, `${context}.reason`),
    ...(detail === undefined ? {} : { detail }),
  };
}

function readExcludedDirectory(value: unknown, context: string): ExcludedDirectory {
  const record = readRecord(value, context);
  assertKeys(record, context, ["path", "reason", "detail"]);
  const detail = readOptionalDetail(record, context);
  return {
    path: readRepositoryPath(record.path, `${context}.path`),
    reason: readExcludedDirectoryReason(record.reason, `${context}.reason`),
    ...(detail === undefined ? {} : { detail }),
  };
}

function readFileCoverage(value: unknown, context: string): FileCoverage {
  const record = readRecord(value, context);
  assertKeys(record, context, [
    "discovered",
    "parsed",
    "skipped",
    "skippedFiles",
    "excludedDirectories",
  ]);
  return {
    discovered: readInteger(record.discovered, `${context}.discovered`),
    parsed: readInteger(record.parsed, `${context}.parsed`),
    skipped: readInteger(record.skipped, `${context}.skipped`),
    skippedFiles: readArray(record.skippedFiles, `${context}.skippedFiles`)
      .map((item, index) => readSkippedFile(item, `${context}.skippedFiles[${index}]`)),
    excludedDirectories: readArray(record.excludedDirectories, `${context}.excludedDirectories`)
      .map((item, index) => readExcludedDirectory(item, `${context}.excludedDirectories[${index}]`)),
  };
}

function readImportCoverage(value: unknown, context: string): ImportCoverage {
  const record = readRecord(value, context);
  assertKeys(record, context, ["discovered", "internal", "external", "excluded", "unresolved"]);
  return {
    discovered: readInteger(record.discovered, `${context}.discovered`),
    internal: readInteger(record.internal, `${context}.internal`),
    external: readInteger(record.external, `${context}.external`),
    excluded: readInteger(record.excluded, `${context}.excluded`),
    unresolved: readInteger(record.unresolved, `${context}.unresolved`),
  };
}

function readCoverage(value: unknown, context: string): AnalysisCoverage {
  const record = readRecord(value, context);
  assertKeys(record, context, ["files", "imports"]);
  return {
    files: readFileCoverage(record.files, `${context}.files`),
    imports: readImportCoverage(record.imports, `${context}.imports`),
  };
}

function readFramework(value: unknown): Framework {
  for (const framework of FRAMEWORKS) if (framework === value) return framework;
  return fail("framework", "unknown framework");
}

function readFileRole(value: unknown, context: string): FileRoleRecord {
  const record = readRecord(value, context);
  assertKeys(record, context, ["file", "role"]);
  let role: FileRole | undefined;
  for (const candidate of FILE_ROLES) if (record.role === candidate) role = candidate;
  if (!role) return fail(`${context}.role`, "unknown file role");
  return { file: readRepositoryPath(record.file, `${context}.file`), role };
}

function readHttpRoute(value: unknown, context: string): HttpRoute {
  const record = readRecord(value, context);
  assertKeys(record, context, ["file", "method", "path", "line"]);
  const method = readString(record.method, `${context}.method`);
  if (!["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS", "CONNECT", "TRACE"].includes(method)) {
    fail(`${context}.method`, "unknown HTTP method");
  }
  const routePath = readNonEmptyString(record.path, `${context}.path`);
  if (!routePath.startsWith("/") || /[\u0000-\u001f\u007f]/.test(routePath)) {
    fail(`${context}.path`, "expected an absolute route pattern without control characters");
  }
  return {
    file: readRepositoryPath(record.file, `${context}.file`), method, path: routePath,
    line: readInteger(record.line, `${context}.line`, 1),
  };
}

function compareText(left: string, right: string) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function compareEdges(left: GraphEdge, right: GraphEdge) {
  return compareText(left.source, right.source) || compareText(left.target, right.target);
}

function compareImports(left: ImportRecord, right: ImportRecord) {
  return compareText(left.source, right.source)
    || left.line - right.line
    || compareText(left.kind, right.kind)
    || compareText(left.specifier ?? "", right.specifier ?? "")
    || compareText(left.resolution.status, right.resolution.status);
}

function assertSorted<T>(values: readonly T[], compare: (left: T, right: T) => number, context: string) {
  for (let index = 1; index < values.length; index += 1) {
    if (compare(values[index - 1], values[index]) > 0) fail(context, "entries are not stably sorted");
  }
}

function assertUnique(values: readonly string[], context: string) {
  const seen = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) fail(context, `duplicate entry ${value}`);
    seen.add(value);
  }
}

function assertInvariants(result: AnalysisResult) {
  const { files: fileCoverage, imports: importCoverage } = result.coverage;
  if (fileCoverage.discovered !== fileCoverage.parsed + fileCoverage.skipped) {
    fail("coverage.files", "discovered does not equal parsed plus skipped");
  }
  if (fileCoverage.parsed !== result.files.length) fail("coverage.files.parsed", "does not match files length");
  if (fileCoverage.skipped !== fileCoverage.skippedFiles.length) {
    fail("coverage.files.skipped", "does not match skippedFiles length");
  }
  if (importCoverage.discovered !== importCoverage.internal
    + importCoverage.external
    + importCoverage.excluded
    + importCoverage.unresolved) {
    fail("coverage.imports", "status counts do not add up to discovered");
  }
  if (importCoverage.discovered !== result.imports.length) {
    fail("coverage.imports.discovered", "does not match imports length");
  }

  const statusCounts: Record<ImportResolution["status"], number> = {
    internal: 0,
    external: 0,
    excluded: 0,
    unresolved: 0,
  };
  for (const occurrence of result.imports) statusCounts[occurrence.resolution.status] += 1;
  for (const status of ["internal", "external", "excluded", "unresolved"] as const) {
    if (statusCounts[status] !== importCoverage[status]) {
      fail(`coverage.imports.${status}`, "does not match import records");
    }
  }

  assertSorted(result.files, (left, right) => compareText(left.path, right.path), "files");
  assertSorted(result.edges, compareEdges, "edges");
  assertSorted(result.imports, compareImports, "imports");
  assertSorted(fileCoverage.skippedFiles, (left, right) => compareText(left.path, right.path), "coverage.files.skippedFiles");
  assertSorted(fileCoverage.excludedDirectories, (left, right) => compareText(left.path, right.path), "coverage.files.excludedDirectories");

  assertUnique(result.files.map(file => file.path), "files");
  assertUnique(result.edges.map(edge => `${edge.source}\0${edge.target}`), "edges");
  assertUnique(fileCoverage.skippedFiles.map(file => file.path), "coverage.files.skippedFiles");
  assertUnique(fileCoverage.excludedDirectories.map(directory => directory.path), "coverage.files.excludedDirectories");

  for (const file of result.files) {
    assertSorted(file.exports, compareExportNames, `files.${file.path}.exports`);
    assertUnique(file.exports, `files.${file.path}.exports`);
  }
  const filePaths = new Set(result.files.map(file => file.path));
  assertSorted(result.frameworkEntries, compareText, "frameworkEntries");
  assertUnique(result.frameworkEntries, "frameworkEntries");
  if (!frameworkSupportsEntries(result.framework) && result.frameworkEntries.length > 0) {
    fail("frameworkEntries", "this framework cannot have special entries");
  }
  for (const file of result.frameworkEntries) {
    if (!filePaths.has(file)) fail("frameworkEntries", `file ${file} is not parsed`);
  }
  const roleCategories = new Set(categoriesForFramework(result.framework).map(category => category.id));
  assertSorted(result.fileRoles, (left, right) => compareText(left.file, right.file) || compareText(left.role, right.role), "fileRoles");
  assertUnique(result.fileRoles.map(record => record.file), "fileRoles");
  for (const record of result.fileRoles) {
    if (!filePaths.has(record.file)) fail("fileRoles", `file ${record.file} is not parsed`);
    if (!roleCategories.has(record.role)) fail("fileRoles", `role ${record.role} does not belong to this framework`);
  }
  assertSorted(result.routes, (left, right) => compareText(left.file, right.file)
    || compareText(left.method, right.method) || compareText(left.path, right.path), "routes");
  assertUnique(result.routes.map(route => `${route.file}\0${route.method}\0${route.path}`), "routes");
  if (!frameworkSupportsRoutes(result.framework) && result.routes.length > 0) fail("routes", "this framework cannot have routes");
  const filesByPath = new Map(result.files.map(file => [file.path, file]));
  for (const route of result.routes) {
    const file = filesByPath.get(route.file);
    if (!file) fail("routes", `file ${route.file} is not parsed`);
    if (route.line > file.lineCount) fail("routes", `line ${route.line} exceeds ${route.file}`);
  }
  for (const skipped of fileCoverage.skippedFiles) {
    if (filePaths.has(skipped.path)) fail("coverage.files.skippedFiles", `${skipped.path} is also parsed`);
  }
  for (const occurrence of result.imports) {
    if (!filePaths.has(occurrence.source)) fail("imports", `source ${occurrence.source} is not parsed`);
    if (occurrence.resolution.status === "internal" && !filePaths.has(occurrence.resolution.target)) {
      fail("imports", `target ${occurrence.resolution.target} is not parsed`);
    }
  }

  for (const edge of result.edges) {
    if (!filePaths.has(edge.source) || !filePaths.has(edge.target)) {
      fail("edges", `${edge.source} -> ${edge.target} has a missing endpoint`);
    }
    assertSorted(edge.kinds, compareText, `edge ${edge.source} -> ${edge.target} kinds`);
    assertUnique(edge.kinds, `edge ${edge.source} -> ${edge.target} kinds`);
  }

  const rebuilt = buildGraph(
    result.files.map(file => ({
      path: file.path,
      folder: file.folder,
      module: file.module,
      lineCount: file.lineCount,
      contentHash: file.contentHash,
    })),
    result.imports.flatMap(occurrence => occurrence.resolution.status === "internal"
      ? [{
          source: occurrence.source,
          target: occurrence.resolution.target,
          kind: occurrence.kind,
        }]
      : []),
  );
  if (JSON.stringify(rebuilt.edges) !== JSON.stringify(result.edges)) {
    fail("edges", "does not match internal import records");
  }
  const expectedFans = new Map(rebuilt.files.map(file => [file.path, [file.fanIn, file.fanOut] as const]));
  for (const file of result.files) {
    const expected = expectedFans.get(file.path);
    if (!expected || file.fanIn !== expected[0] || file.fanOut !== expected[1]) {
      fail(`files.${file.path}`, "fan-in or fan-out does not match edges");
    }
  }
}

export function validateAnalysisResult(value: unknown): AnalysisResult {
  const record = readRecord(value, "root");
  // Phase 7 has no framework block; earlier phase 8 snapshots lack only the
  // special-entry list. A present list always requires the complete block.
  const metadataKeys = ["framework", "fileRoles", "routes"];
  const hasEntries = "frameworkEntries" in record;
  const hasMetadata = hasEntries || metadataKeys.some(key => key in record);
  assertKeys(record, "root", ["schemaVersion", "files", "edges", "imports", "coverage",
    ...(hasMetadata ? metadataKeys : []), ...(hasEntries ? ["frameworkEntries"] : [])]);
  if (record.schemaVersion !== 1) fail("root.schemaVersion", "expected version 1");
  const result: AnalysisResult = {
    schemaVersion: 1,
    framework: hasMetadata ? readFramework(record.framework) : readFramework("generic"),
    fileRoles: hasMetadata ? readArray(record.fileRoles, "fileRoles").map((item, index) => readFileRole(item, `fileRoles[${index}]`)) : [],
    frameworkEntries: hasEntries ? readArray(record.frameworkEntries, "frameworkEntries")
      .map((item, index) => readRepositoryPath(item, `frameworkEntries[${index}]`)) : [],
    routes: hasMetadata ? readArray(record.routes, "routes").map((item, index) => readHttpRoute(item, `routes[${index}]`)) : [],
    files: readArray(record.files, "files").map((item, index) => readFileNode(item, `files[${index}]`)),
    edges: readArray(record.edges, "edges").map((item, index) => readGraphEdge(item, `edges[${index}]`)),
    imports: readArray(record.imports, "imports").map((item, index) => readImportRecord(item, `imports[${index}]`)),
    coverage: readCoverage(record.coverage, "coverage"),
  };
  assertInvariants(result);
  return result;
}

export async function readAnalysisResult(filePath: string) {
  const content = await readFile(filePath, "utf8");
  const parsed: unknown = JSON.parse(content);
  return validateAnalysisResult(parsed);
}

export async function writeAnalysisResult(filePath: string, result: AnalysisResult) {
  const validated = validateAnalysisResult(result);
  await mkdir(path.dirname(path.resolve(filePath)), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(validated, null, 2)}\n`, "utf8");
  return readAnalysisResult(filePath);
}
