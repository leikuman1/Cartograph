import type { ExplanationBlock, ExplanationDocument, ExplanationInline } from "./types";
import { explanationFolders } from "./paths";

const FRAMEWORK_NAMES = new Set(["next.js", "node.js", "nest.js", "nuxt.js", "vue.js", "express.js", "react.js", "svelte.js"]);
const SLASH_PROSE = new Set(["and/or", "client/server", "request/response", "read/write", "input/output"]);

function hasUnknownPath(text: string, folders: ReadonlySet<string>) {
  const references = text.matchAll(/(?:[\p{L}\p{N}_@.-]+\/)+[\p{L}\p{N}_@.-]+|\b[\w.-]+\.(?:[cm]?[jt]sx?|json|ya?ml|md|css|html|vue|svelte)\b/giu);
  for (const [reference] of references) {
    if (folders.has(reference) || FRAMEWORK_NAMES.has(reference.toLowerCase()) || SLASH_PROSE.has(reference.toLowerCase())) continue;
    // HTTP method pairs are ordinary prose, never repository paths.
    if (/^(?:GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)(?:\/(?:GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS))+$/.test(reference)) continue;
    return true;
  }
  return false;
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

// Only repository paths supplied in this operation can become links. Reject
// unexpected file names before caching; escaping HTML alone cannot prevent fiction.
function linkText(text: string, kind: "text" | "code" | "strong", paths: readonly string[]): ExplanationInline[] {
  const nodes: ExplanationInline[] = [];
  let rest = text;
  const ordered = [...paths].sort((a, b) => b.length - a.length);
  const folders = new Set(explanationFolders(paths));
  while (rest) {
    let start = rest.length;
    let match: string | undefined;
    for (const path of ordered) {
      const index = rest.indexOf(path);
      if (index < 0 || index >= start) continue;
      const before = rest[index - 1];
      const after = rest[index + path.length];
      if ((before && /[\p{L}\p{N}_./\\-]/u.test(before)) || (after && /[\p{L}\p{N}_/\\-]/u.test(after))) continue;
      start = index;
      match = path;
    }
    const plain = rest.slice(0, start);
    if (hasUnknownPath(plain, folders)) {
      throw new Error("The explanation names a file path that was not supplied to the model. Try Explain again.");
    }
    if (plain) nodes.push({ kind, text: plain });
    if (!match) break;
    nodes.push({ kind: "file", path: match });
    rest = rest.slice(start + match.length);
  }
  return nodes;
}

function inline(text: string, paths: readonly string[]): ExplanationInline[] {
  const nodes: ExplanationInline[] = [];
  const pieces = text.split(/(\*\*[^*]+\*\*|`[^`]+`)/g);
  for (const piece of pieces) {
    if (!piece) continue;
    const kind = piece.startsWith("**") && piece.endsWith("**") ? "strong"
      : piece.startsWith("`") && piece.endsWith("`") ? "code" : "text";
    const content = kind === "strong" ? piece.slice(2, -2) : kind === "code" ? piece.slice(1, -1) : piece;
    // Unsupported formatting never leaks raw Markdown markers into the panel.
    nodes.push(...linkText(content.replace(/[`*#]/g, ""), kind, paths));
  }
  return nodes;
}

export function renderableDocument(value: unknown, paths: readonly string[]): ExplanationDocument {
  const object = record(value);
  if (!object || typeof object.markdown !== "string" || !object.markdown.trim() || object.markdown.length > 16000) {
    throw new Error("The model returned an empty or invalid explanation.");
  }
  const markdown = object.markdown.replace(/\r\n?/g, "\n")
    .replace(/^\s*```[^\n]*$/gm, "")
    .replace(/^\s{0,3}#{1,6}\s*/gm, "")
    .replace(/!?\[([^\]]+)\]\([^)]*\)/g, "$1");
  const blocks: ExplanationBlock[] = [];
  for (const line of markdown.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const bullet = /^(?:[-*+]\s+|\d+[.)]\s+)/.test(trimmed);
    blocks.push({ kind: bullet ? "bullet" : "paragraph", children: inline(trimmed.replace(/^(?:[-*+]\s+|\d+[.)]\s+|>\s*)/, ""), paths) });
  }
  if (!blocks.length) throw new Error("The model returned an empty explanation.");
  return { blocks };
}

export function validateDocument(value: unknown, paths: readonly string[]): ExplanationDocument {
  const object = record(value);
  if (!object || !Array.isArray(object.blocks) || !object.blocks.length || object.blocks.length > 200) throw new Error("Invalid cached explanation.");
  const blocks = object.blocks.map((value: unknown): ExplanationBlock => {
    const block = record(value);
    if (!block || (block.kind !== "paragraph" && block.kind !== "bullet") || !Array.isArray(block.children)) throw new Error("Invalid cached block.");
    const children = block.children.flatMap((value: unknown): ExplanationInline[] => {
      const node = record(value);
      if (!node) throw new Error("Invalid cached text.");
      if (node.kind === "file" && typeof node.path === "string" && paths.includes(node.path)) return [{ kind: "file", path: node.path }];
      if ((node.kind === "text" || node.kind === "code" || node.kind === "strong") && typeof node.text === "string") {
        return linkText(node.text.replace(/[`*#]/g, ""), node.kind, paths);
      }
      throw new Error("Invalid cached reference.");
    });
    return { kind: block.kind, children };
  });
  return { blocks };
}
