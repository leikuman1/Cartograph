import { createHash } from "node:crypto";
import type { AnalysisResult } from "../parser/contract";
import { foldFolders, compareText } from "../canvas/graph";
export { roleCandidates } from "./candidates";
import { PROMPT_VERSION } from "./config";
import { MODEL_ROLES, type ExplainTarget, type ModelRoleRecord } from "./types";

export function explanationContext(analysis: AnalysisResult, target: ExplainTarget) {
  const members = target.kind === "file"
    ? analysis.files.filter(file => file.path === target.path)
    : foldFolders(analysis.files, analysis.edges).groups.find(group => group.path === target.path)?.files;
  if (!members?.length) throw new Error("The selected file or folded folder is absent from this analysis.");
  const memberPaths = new Set(members.map(file => file.path));
  const edges = analysis.edges.filter(edge => memberPaths.has(edge.source) || memberPaths.has(edge.target))
    .toSorted((a, b) => compareText(a.source, b.source) || compareText(a.target, b.target));
  const supplied = new Set([...memberPaths, ...edges.flatMap(edge => [edge.source, edge.target])]);
  const files = analysis.files.filter(file => supplied.has(file.path)).toSorted((a, b) => compareText(a.path, b.path));
  return {
    target, framework: analysis.framework,
    members: members.map(file => file.path).sort(compareText),
    files: files.map(file => ({ path: file.path, contentHash: file.contentHash, exports: file.exports,
      lineCount: file.lineCount, role: analysis.fileRoles.find(role => role.file === file.path)?.role ?? null })),
    edges,
  };
}

export function inputKey(model: string, endpoint: string, operation: string, input: unknown) {
  return createHash("sha256").update(JSON.stringify({ model, endpoint, operation, prompt: PROMPT_VERSION, input })).digest("hex");
}

export function validateRoles(value: unknown, files: readonly { path: string; contentHash: string }[], complete = true): ModelRoleRecord[] {
  if (!Array.isArray(value) || (complete && value.length !== files.length)) throw new Error("The model did not classify every supplied file.");
  const byPath = new Map(files.map(file => [file.path, file.contentHash]));
  const seen = new Set<string>();
  const roles = value.map((entry: unknown): ModelRoleRecord => {
    if (typeof entry !== "object" || entry === null || !("file" in entry) || !("role" in entry)
      || typeof entry.file !== "string" || typeof entry.role !== "string") throw new Error("The model returned an invalid role.");
    const contentHash = byPath.get(entry.file);
    const role = MODEL_ROLES.find(role => role === entry.role);
    if (!contentHash || seen.has(entry.file) || !role) throw new Error("The model returned an unprovided file or a structural role.");
    if ("contentHash" in entry && entry.contentHash !== contentHash) throw new Error("The stored role belongs to different file contents.");
    seen.add(entry.file);
    return { file: entry.file, role, contentHash };
  });
  return roles.sort((a, b) => compareText(a.file, b.file));
}
