// Browser-safe vocabulary. Detection and syntax extraction live in the adapters.
export const FRAMEWORKS = ["nextjs", "nestjs", "express", "react", "generic"] as const;
export type Framework = (typeof FRAMEWORKS)[number];

export const FRAMEWORK_LABELS: Record<Framework, string> = {
  nextjs: "Next.js",
  nestjs: "NestJS",
  express: "Express",
  react: "React",
  generic: "Not detected",
};

export const FILE_ROLES = [
  "page", "api", "action", "layout", "controller", "service", "module", "entity", "component", "hook",
  "route", "model", "middleware",
] as const;
export type FileRole = (typeof FILE_ROLES)[number];
export type FileCategory = FileRole | "source" | "test" | "declaration";

export interface CategoryDefinition {
  id: FileCategory;
  label: string;
  code: string;
  description: string;
}

const definitions: Record<FileCategory, CategoryDefinition> = {
  page: { id: "page", label: "Page routes", code: "P", description: "Pages identified by routing conventions" },
  api: { id: "api", label: "API endpoints", code: "A", description: "API handler files" },
  action: { id: "action", label: "Server actions", code: "A", description: "Files declaring server actions" },
  layout: { id: "layout", label: "Layouts", code: "L", description: "Routing layouts" },
  controller: { id: "controller", label: "Controllers", code: "C", description: "Controller files" },
  service: { id: "service", label: "Services", code: "S", description: "Service files" },
  module: { id: "module", label: "Modules", code: "M", description: "Module files" },
  entity: { id: "entity", label: "Entities", code: "E", description: "Entity files" },
  component: { id: "component", label: "Components", code: "C", description: "React component files" },
  hook: { id: "hook", label: "Hooks", code: "H", description: "React hook files" },
  route: { id: "route", label: "Routes", code: "R", description: "Files in Express route directories" },
  model: { id: "model", label: "Models", code: "M", description: "Files in Express model directories" },
  middleware: { id: "middleware", label: "Middleware", code: "M", description: "Files in Express middleware directories" },
  source: { id: "source", label: "Source", code: "S", description: "Source files with no framework role" },
  test: { id: "test", label: "Tests", code: "T", description: "Test files" },
  declaration: { id: "declaration", label: "Declarations", code: "D", description: "Type declaration files" },
};

const generic: readonly CategoryDefinition[] = [definitions.source, definitions.test, definitions.declaration];
const categories: Record<Framework, readonly CategoryDefinition[]> = {
  nextjs: [definitions.page, definitions.api, definitions.action, definitions.layout, definitions.component, definitions.hook, ...generic],
  nestjs: [definitions.controller, definitions.service, definitions.module, definitions.entity, ...generic],
  express: [definitions.route, definitions.controller, definitions.middleware, definitions.service, definitions.model, ...generic],
  react: [definitions.component, definitions.hook, ...generic],
  generic,
};

export function frameworkSupportsRoutes(framework: Framework): boolean {
  return framework === "nextjs" || framework === "nestjs";
}

export function frameworkSupportsEntries(framework: Framework): boolean {
  return framework === "nextjs";
}

export function categoriesForFramework(framework: Framework): readonly CategoryDefinition[] {
  return categories[framework];
}

export function genericCategoryForPath(path: string): CategoryDefinition {
  if (/\.d\.[cm]?ts$/.test(path)) return definitions.declaration;
  if (/(^|\/)(__tests__|tests?|runtime-tests)(\/|$)|\.(test|spec)\.[^.]+$/.test(path)) return definitions.test;
  return definitions.source;
}

type RoleRecords = readonly { file: string; role: FileRole }[];
const roleIndexes = new WeakMap<RoleRecords, ReadonlyMap<string, FileRole>>();

export function categoryForFile(path: string, fileRoles: RoleRecords): CategoryDefinition {
  const genericCategory = genericCategoryForPath(path);
  if (genericCategory.id !== "source") return genericCategory;
  // Analysis snapshots are immutable. Reuse one lookup across rows, filters,
  // and counts rather than scanning all role records for every rendered file.
  let roles = roleIndexes.get(fileRoles);
  if (!roles) {
    roles = new Map(fileRoles.map(record => [record.file, record.role]));
    roleIndexes.set(fileRoles, roles);
  }
  const role = roles.get(path);
  return role ? definitions[role] : genericCategory;
}
