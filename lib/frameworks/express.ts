import type { FileRoleRecord } from "../parser/contract";
import { localPath, type PackageContext } from "./shared";
import type { FileRole } from "./taxonomy";

const DIRECTORY_ROLES = new Map<string, FileRole>([
  ["route", "route"], ["routes", "route"],
  ["controller", "controller"], ["controllers", "controller"],
  ["service", "service"], ["services", "service"],
  ["model", "model"], ["models", "model"],
  ["middleware", "middleware"], ["middlewares", "middleware"],
]);

export function analyzeExpress(context: PackageContext) {
  const fileRoles: FileRoleRecord[] = [];
  for (const { discovered } of context.files) {
    const directories = localPath(discovered.path, context.directory).split("/").slice(0, -1);
    // The closest directory describes the file; a parent convention cannot
    // override a more specific location inside it.
    for (let index = directories.length - 1; index >= 0; index -= 1) {
      const role = DIRECTORY_ROLES.get(directories[index]);
      if (role) {
        fileRoles.push({ file: discovered.path, role });
        break;
      }
    }
  }
  return { fileRoles };
}
