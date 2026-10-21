import { categoryForFile, frameworkSupportsEntries, type FileCategory, type FileRole, type Framework } from "./taxonomy";

const entryRoles = new Set<FileCategory>(["page", "api", "action", "layout", "module"]);
const entryIndexes = new WeakMap<readonly string[], ReadonlySet<string>>();

export function isFrameworkEntry(
  framework: Framework,
  path: string,
  fileRoles: readonly { file: string; role: FileRole }[],
  frameworkEntries: readonly string[],
): boolean {
  const role = categoryForFile(path, fileRoles).id;
  if (role === "test" || role === "declaration") return false;
  if (role === "controller") return framework === "nestjs";
  if (entryRoles.has(role)) return true;
  if (!frameworkSupportsEntries(framework)) return false;
  // Only the adapter knows the package and active root. The browser consumes
  // its exact facts instead of inferring conventions from repository paths.
  let entries = entryIndexes.get(frameworkEntries);
  if (!entries) {
    entries = new Set(frameworkEntries);
    entryIndexes.set(frameworkEntries, entries);
  }
  return entries.has(path);
}
