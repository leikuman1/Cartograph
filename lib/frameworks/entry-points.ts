import { categoryForFile, type FileCategory, type FileRole, type Framework } from "./taxonomy";

const entryRoles = new Set<FileCategory>(["page", "api", "action", "layout", "controller", "module"]);
// These conventions are file locations within a detected app, never basenames
// that could turn ordinary modules such as lib/error.ts into entry points.
const appEntry = /^(src\/)?app\/(.*\/)?(template|default|loading|error|global-error|not-found)\.[jt]sx?$/;
const rootEntry = /^(src\/)?(middleware|proxy|instrumentation)\.[jt]sx?$/;
const pagesEntry = /^(src\/)?pages\/(_app|_document|_error)\.[jt]sx?$/;

export function isFrameworkEntry(
  framework: Framework,
  path: string,
  fileRoles: readonly { file: string; role: FileRole }[],
): boolean {
  const role = categoryForFile(path, fileRoles).id;
  if (role === "test" || role === "declaration") return false;
  if (entryRoles.has(role)) return true;
  return framework === "nextjs" && (appEntry.test(path) || rootEntry.test(path) || pagesEntry.test(path));
}
