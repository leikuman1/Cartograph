import path from "node:path";
import type { FileRoleRecord, HttpRoute } from "../parser/contract";
import { createRepositoryFileSystem } from "../parser/filesystem";
import { analyzeNest } from "./nest";
import { analyzeNext } from "./next";
import { reactRole } from "./react";
import { compareText, nearestPackage, type FrameworkContext, type PackageContext } from "./shared";
import type { Framework } from "./taxonomy";

export type { FrameworkContext } from "./shared";

export interface FrameworkAnalysis {
  framework: Framework;
  fileRoles: FileRoleRecord[];
  frameworkEntries: string[];
  routes: HttpRoute[];
}

const PRECEDENCE: readonly Framework[] = ["nextjs", "nestjs", "react", "generic"];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function dependencyNames(content: string | undefined) {
  if (!content) return [];
  let manifest: unknown;
  try { manifest = JSON.parse(content); } catch { return []; }
  if (!isRecord(manifest)) return [];
  return ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"].flatMap(name => {
    const dependencies = manifest[name];
    return isRecord(dependencies) ? Object.keys(dependencies).filter(key => typeof dependencies[key] === "string") : [];
  });
}

function packageFramework(context: PackageContext): Framework {
  const manifest = context.fileSystem.host.readFile(path.join(context.rootPath, context.directory, "package.json"));
  const packages = dependencyNames(manifest);
  for (const { sourceFile } of context.files) {
    for (const statement of sourceFile.getImportDeclarations()) {
      if (!statement.isTypeOnly()) packages.push(statement.getModuleSpecifierValue());
    }
    for (const statement of sourceFile.getExportDeclarations()) {
      const specifier = statement.getModuleSpecifierValue();
      if (specifier && !statement.isTypeOnly()) packages.push(specifier);
    }
  }
  if (packages.some(name => name === "next" || name.startsWith("next/"))) return "nextjs";
  if (packages.some(name => name.startsWith("@nestjs/"))) return "nestjs";
  if (packages.some(name => name === "react" || name.startsWith("react/"))) return "react";
  return "generic";
}

function isRoleCandidate(file: string) {
  return !/(^|\/)(__tests__|__mocks__|tests?|fixtures)(\/|$)/.test(file)
    && !/\.(test|spec)\.[cm]?[jt]sx?$/.test(file) && !/\.d\.[cm]?ts$/.test(file);
}

export function analyzeFramework(context: FrameworkContext): FrameworkAnalysis {
  const fileSystem = createRepositoryFileSystem(context.rootPath, context.skippedFiles);
  const directories = new Set([".", ...context.packageDirectories]);
  const packages: PackageContext[] = [...directories].sort(compareText).map(directory => ({
    ...context,
    directory,
    fileSystem,
    framework: "generic",
    files: context.sourceFiles.filter(file => nearestPackage(file.discovered.path, directories) === directory
      && isRoleCandidate(file.discovered.path)),
    skippedFiles: context.skippedFiles.filter(file => nearestPackage(file.path, directories) === directory),
  }));
  for (const entry of packages) entry.framework = packageFramework(entry);
  const framework = PRECEDENCE.find(candidate => packages.some(entry => entry.framework === candidate)) ?? "generic";
  const fileRoles: FileRoleRecord[] = [];
  const frameworkEntries: string[] = [];
  const routes: HttpRoute[] = [];
  for (const entry of packages) {
    if (entry.framework !== framework) continue;
    if (entry.framework === "nextjs") {
      const result = analyzeNext(entry);
      fileRoles.push(...result.fileRoles);
      frameworkEntries.push(...result.frameworkEntries);
      routes.push(...result.routes);
    } else if (entry.framework === "nestjs") {
      const result = analyzeNest(entry);
      fileRoles.push(...result.fileRoles);
      routes.push(...result.routes);
    } else if (entry.framework === "react") {
      for (const file of entry.files) {
        const role = reactRole(file.sourceFile, file.discovered.path);
        if (role) fileRoles.push({ file: file.discovered.path, role });
      }
    }
  }
  fileRoles.sort((left, right) => compareText(left.file, right.file) || compareText(left.role, right.role));
  routes.sort((left, right) => compareText(left.file, right.file) || compareText(left.method, right.method)
    || compareText(left.path, right.path) || left.line - right.line);
  const uniqueRoutes = routes.filter((route, index) => index === 0 || route.file !== routes[index - 1].file
    || route.method !== routes[index - 1].method || route.path !== routes[index - 1].path);
  return { framework, fileRoles, frameworkEntries: [...new Set(frameworkEntries)].sort(compareText), routes: uniqueRoutes };
}
