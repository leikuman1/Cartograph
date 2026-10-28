import { explanationFolders } from "./paths";

export const PATH_EVALUATOR_VERSION = "invented-paths-1";
const PROSE = new Set(["next.js", "node.js", "nest.js", "nuxt.js", "vue.js", "express.js", "react.js", "svelte.js",
  "and/or", "client/server", "request/response", "read/write", "input/output"]);

export type PathEvaluation = {
  key: "invented_paths";
  score: 0 | 1;
  evaluator: string;
  mentionedPaths: string[];
  inventedPaths: string[];
  failures: { path: string; excerpt: string }[];
};

// This evaluates the raw answer, including paths a formatter might discard.
// Known paths are consumed first to preserve literal spaces, brackets and dots.
export function evaluateInventedPaths(text: string, suppliedPaths: readonly string[]): PathEvaluation {
  const allowed = new Set(suppliedPaths);
  const folders = new Set(explanationFolders(suppliedPaths));
  const references = new Map<string, number>();
  const masked = text.split("");
  const boundary = /[\p{L}\p{N}_./\\-]/u;
  for (const path of [...allowed].sort((a, b) => b.length - a.length)) {
    let from = 0;
    while (from < text.length) {
      const index = text.indexOf(path, from);
      if (index < 0) break;
      from = index + path.length;
      if ((index > 0 && boundary.test(text[index - 1])) || (text[from] && boundary.test(text[from])) ||
        (text[from] === "." && text[from + 1] && boundary.test(text[from + 1]))) continue;
      references.set(path, references.get(path) ?? index);
      // split("") uses UTF-16 offsets, just like indexOf and RegExp indices.
      for (let offset = index; offset < from; offset += 1) masked[offset] = " ";
    }
  }
  const literalPattern = /`([^`\n]+)`|\]\(([^\n]+?)\)/g;
  for (const match of text.matchAll(literalPattern)) {
    const path = match[1] ?? match[2];
    const offset = match.index + (match[1] !== undefined ? 1 : 2);
    const visible = masked.slice(offset, offset + path.length).join("");
    if (!visible.trim() || !/[/\\\\]|\.[a-z][a-z0-9]*[.-]*$/i.test(path) || PROSE.has(path.toLowerCase()) || folders.has(path) ||
      /^(?:GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)(?:\/(?:GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS))+$/.test(path)) continue;
    references.set(path, references.get(path) ?? offset);
    for (let index = offset; index < offset + path.length; index += 1) masked[index] = " ";
  }
  for (const match of text.matchAll(/!?\[([^\]\n]*)\]\(/g)) {
    const labelStart = match.index + (match[0].startsWith("!") ? 2 : 1);
    for (let index = match.index; index < labelStart; index += 1) masked[index] = " ";
    masked[labelStart + match[1].length] = " ";
    masked[labelStart + match[1].length + 1] = " ";
  }
  const remaining = masked.join("");
  const pattern = /(?:[A-Za-z]:[\\/])?(?:[\p{L}\p{N}_@~.()[\]-]+[\\/])+[\p{L}\p{N}_@~.()[\]-]+|[\p{L}\p{N}_@-][\p{L}\p{N}_@.-]*\.(?:[cm]?[jt]sx?|json|ya?ml|mdx?|css|scss|sass|less|html?|vue|svelte|sql|graphql|gql|toml|xml|txt|sh|py|go|rs|java|rb|svg|png|jpe?g|env)\b/giu;
  for (const match of remaining.matchAll(pattern)) {
    let path = match[0];
    // Delimiters around prose are not part of a filename. A literal terminal
    // period is retained when it is an exact supplied file or folder.
    if (path.endsWith(".") && !allowed.has(path) && !folders.has(path)) path = path.slice(0, -1);
    if (folders.has(path) || PROSE.has(path.toLowerCase()) || /^(?:GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)(?:\/(?:GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS))+$/.test(path)) continue;
    references.set(path, references.get(path) ?? match.index);
  }
  const mentionedPaths = [...references.keys()].sort();
  const inventedPaths = mentionedPaths.filter(path => !allowed.has(path));
  return {
    key: "invented_paths", score: inventedPaths.length ? 0 : 1, evaluator: PATH_EVALUATOR_VERSION,
    mentionedPaths, inventedPaths,
    failures: inventedPaths.map(path => {
      const index = references.get(path) ?? 0;
      return { path, excerpt: text.slice(Math.max(0, index - 60), index + path.length + 60) };
    }),
  };
}
