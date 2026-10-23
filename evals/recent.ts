import type { Client } from "langsmith";
import type { Run } from "langsmith/schemas";
import type { ExplanationInput } from "../lib/ai/operations";
import { FILE_ROLES, FRAMEWORKS } from "../lib/frameworks/taxonomy";
import { IMPORT_KINDS } from "../lib/parser/contract";

export type RecordedExplanation = {
  id: string;
  sessionId: string;
  input: ExplanationInput;
  markdown: string;
};

export type RecordedExplanationRun = Pick<Run,
  "id" | "session_id" | "name" | "run_type" | "inputs" | "outputs" | "extra" | "error" | "parent_run_id"
>;

const EXPLANATION_PREFIX = "You explain a parsed repository";
// The installed OpenAI wrapper uses ChatOpenAI; older recorded runs can use
// the SDK method name instead. The system prompt distinguishes classification.
const LEGACY_NAMES = ["chat.completions.create", "ChatOpenAI", "AzureChatOpenAI"];
const RECENT_FILTER = `or(eq(name, "explanation-answer"), and(eq(run_type, "llm"), or(${LEGACY_NAMES.map(name => `eq(name, "${name}")`).join(", ")}), search(inputs, "${EXPLANATION_PREFIX}")))`;

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function object(value: unknown, field: string): Record<string, unknown> {
  if (!record(value)) throw new Error(`${field} must be an object.`);
  return value;
}

function array(value: unknown, field: string): readonly unknown[] {
  if (!Array.isArray(value)) throw new Error(`${field} must be an array.`);
  return value;
}

function string(value: unknown, field: string): string {
  if (typeof value !== "string") throw new Error(`${field} must be a string.`);
  return value;
}

function nonempty(value: unknown, field: string): string {
  const result = string(value, field);
  if (!result.trim()) throw new Error(`${field} must not be empty.`);
  return result;
}

function repositoryPath(value: unknown, field: string, allowRoot = false): string {
  const path = nonempty(value, field);
  if (allowRoot && path === ".") return path;
  if (path.includes("\\") || /^[A-Za-z]:\//.test(path)
    || path.split("/").some(segment => !segment || segment === "." || segment === "..")) {
    throw new Error(`${field} must be a repository-relative POSIX path.`);
  }
  return path;
}

function unique(paths: readonly string[], field: string) {
  if (new Set(paths).size !== paths.length) throw new Error(`${field} contains duplicates.`);
}

export function parseExplanationInput(value: unknown): ExplanationInput {
  const input = object(value, "Explanation input");
  const selected = object(input.target, "target");
  const kind = selected.kind;
  if (kind !== "file" && kind !== "folder") throw new Error("target.kind must be file or folder.");
  const target: ExplanationInput["target"] = { kind, path: repositoryPath(selected.path, "target.path", kind === "folder") };
  const framework = FRAMEWORKS.find(framework => framework === input.framework);
  if (!framework) throw new Error("Unknown explanation framework.");
  const members = array(input.members, "members").map(value => repositoryPath(value, "members"));
  const folders = array(input.folders, "folders").map(value => repositoryPath(value, "folders"));
  const files = array(input.files, "files").map(value => {
    const file = object(value, "file");
    const contentHash = string(file.contentHash, "file.contentHash");
    if (!/^[0-9a-f]{64}$/.test(contentHash)) throw new Error("file.contentHash must be a SHA-256 digest.");
    const lineCount = file.lineCount;
    if (typeof lineCount !== "number" || !Number.isSafeInteger(lineCount) || lineCount < 0) {
      throw new Error("file.lineCount must be a nonnegative integer.");
    }
    const role = file.role === null ? null : FILE_ROLES.find(role => role === file.role);
    if (role === undefined) throw new Error("Unknown explanation file role.");
    return { path: repositoryPath(file.path, "file.path"), contentHash, lineCount, role,
      exports: array(file.exports, "file.exports").map(value => string(value, "file.exports")) };
  });
  const edges = array(input.edges, "edges").map(value => {
    const edge = object(value, "edge");
    const kinds = array(edge.kinds, "edge.kinds").map(value => {
      const kind = IMPORT_KINDS.find(kind => kind === value);
      if (!kind) throw new Error("Unknown explanation import kind.");
      return kind;
    });
    if (!kinds.length) throw new Error("An edge must contain an import kind.");
    unique(kinds, "edge.kinds");
    return { source: repositoryPath(edge.source, "edge.source"), target: repositoryPath(edge.target, "edge.target"), kinds };
  });
  const sources = array(input.sources, "sources").map(value => {
    const source = object(value, "source");
    return { path: repositoryPath(source.path, "source.path"), content: string(source.content, "source.content") };
  });
  unique(members, "members");
  unique(folders, "folders");
  unique(files.map(file => file.path), "files");
  unique(sources.map(source => source.path), "sources");
  if (!members.length || !files.length) throw new Error("Explanation members and files must not be empty.");
  const filePaths = new Set(files.map(file => file.path));
  const memberPaths = new Set(members);
  if (members.some(path => !filePaths.has(path))) throw new Error("An explanation member is absent from files.");
  if (kind === "file" && (members.length !== 1 || members[0] !== target.path)) {
    throw new Error("The file target must be the only explanation member.");
  }
  if (kind === "folder" && target.path !== "." && members.some(path => !path.startsWith(`${target.path}/`))) {
    throw new Error("An explanation member is outside the selected folder.");
  }
  if (sources.length !== members.length || sources.some(source => !memberPaths.has(source.path))) {
    throw new Error("Source content must be supplied for exactly the explanation members.");
  }
  if (edges.some(edge => !filePaths.has(edge.source) || !filePaths.has(edge.target)
    || (!memberPaths.has(edge.source) && !memberPaths.has(edge.target)))) {
    throw new Error("An explanation edge has an unprovided endpoint or no selected member.");
  }
  return { target, framework, members, folders, files, edges, sources };
}

function parseJson(value: unknown, field: string): unknown {
  try { return JSON.parse(string(value, field)); }
  catch { throw new Error(`${field} must contain valid JSON.`); }
}

function evaluationRun(run: RecordedExplanationRun): boolean {
  const extra: unknown = run.extra;
  return record(extra) && record(extra.metadata) && extra.metadata.origin === "eval";
}

export function decodeRecordedExplanation(run: RecordedExplanationRun): RecordedExplanation {
  if (evaluationRun(run)) throw new Error("Evaluation traffic is excluded.");
  if (run.error) throw new Error("The explanation run failed.");
  let input: unknown;
  let output: unknown;
  if (run.name === "explanation-answer" && run.run_type === "chain") {
    input = run.inputs;
    output = run.outputs;
  } else if (run.run_type === "llm" && LEGACY_NAMES.includes(run.name)) {
    const inputs = object(run.inputs, "Run inputs");
    const messages = array(inputs.messages, "messages");
    const system = messages[0];
    const user = messages[1];
    if (messages.length !== 2 || !record(system) || system.role !== "system"
      || typeof system.content !== "string" || !system.content.startsWith(EXPLANATION_PREFIX)
      || !record(user) || user.role !== "user") {
      throw new Error("The model run is not a repository explanation.");
    }
    input = parseJson(user.content, "Explanation user message");
    const outputs = object(run.outputs, "Run outputs");
    const choice = array(outputs.choices, "choices")[0];
    if (!record(choice) || (choice.finish_reason !== undefined && choice.finish_reason !== "stop")) {
      throw new Error("The explanation completion is missing or unfinished.");
    }
    const message = object(choice.message, "Completion message");
    output = parseJson(message.content, "Explanation completion");
  } else {
    throw new Error("The run is not a generated repository explanation.");
  }
  return { id: nonempty(run.id, "Run ID"), sessionId: nonempty(run.session_id, "Run project ID"),
    input: parseExplanationInput(input), markdown: nonempty(object(output, "Explanation output").markdown, "Explanation markdown") };
}

export async function recentExplanations(client: Client, projectName: string, limit = 20): Promise<RecordedExplanation[]> {
  if (!Number.isSafeInteger(limit) || limit < 1) throw new Error("Explanation limit must be a positive integer.");
  nonempty(projectName, "LangSmith project name");
  // Bound malformed and excluded traffic while leaving room for legacy spans
  // and their newer parent answer to appear together in the same list read.
  const scanLimit = Math.max(limit, Math.min(1000, limit * 5));
  const decoded: { run: RecordedExplanationRun; explanation: RecordedExplanation }[] = [];
  let inspected = 0;
  let skipped = 0;
  for await (const run of client.listRuns({ projectName, order: "desc", limit: scanLimit, filter: RECENT_FILTER,
    select: ["id", "session_id", "name", "run_type", "inputs", "outputs", "extra", "error", "parent_run_id"] })) {
    inspected += 1;
    try { decoded.push({ run, explanation: decodeRecordedExplanation(run) }); }
    catch { skipped += 1; }
    if (inspected >= scanLimit) break;
  }
  const answers = new Set(decoded.filter(({ run }) => run.name === "explanation-answer").map(({ run }) => run.id));
  const seen = new Set<string>();
  const usable = decoded.filter(({ run }) => {
    if (seen.has(run.id) || (run.parent_run_id && answers.has(run.parent_run_id))) {
      skipped += 1;
      return false;
    }
    seen.add(run.id);
    return true;
  });
  const results = usable.slice(0, limit).map(({ explanation }) => explanation);
  console.error(`Recent explanations: selected ${results.length} of ${usable.length} usable; skipped ${skipped} of ${inspected} inspected runs (excluded, malformed, or duplicate).`);
  if (!results.length) {
    throw new Error(`No usable generated explanations found in project ${projectName}; skipped ${skipped} of ${inspected} inspected runs.`);
  }
  return results;
}
