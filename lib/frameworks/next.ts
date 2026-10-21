import path from "node:path";
import { Node, SyntaxKind, type SourceFile } from "ts-morph";
import type { FileRoleRecord, HttpRoute } from "../parser/contract";
import { compareText, hasDirective, localPath, unwrap, type PackageContext } from "./shared";
import { reactRole } from "./react";

const METHODS = new Set(["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"]);
const EXTENSION = /\.(tsx|ts|jsx|js)$/;

function routingRoot(context: PackageContext, name: string) {
  context.fileSystem.blocked.clear();
  const exists = context.fileSystem.host.directoryExists?.(path.join(context.rootPath, context.directory, name));
  return exists || context.fileSystem.blocked.size > 0 ? name : `src/${name}`;
}

function propertyName(node: Node) {
  return Node.isIdentifier(node) ? node.getText() : Node.isStringLiteral(node) ? node.getLiteralText() : null;
}

function experimentalFlag(config: Node, name: string) {
  if (!Node.isObjectLiteralExpression(config)) return false;
  const properties = config.getProperties().filter(property => !Node.isSpreadAssignment(property)
    && propertyName(property.getNameNode()) === "experimental");
  if (properties.length !== 1 || !Node.isPropertyAssignment(properties[0])) return false;
  const initializer = properties[0].getInitializer();
  const experimental = initializer ? unwrap(initializer) : undefined;
  if (!experimental || !Node.isObjectLiteralExpression(experimental)) return false;
  // Spreads and computed keys can override a literal flag. Omit uncertain entries.
  if (experimental.getProperties().some(property => Node.isSpreadAssignment(property)
    || (!Node.isIdentifier(property.getNameNode()) && !Node.isStringLiteral(property.getNameNode())))) return false;
  const flags = experimental.getProperties().filter(property => !Node.isSpreadAssignment(property)
    && propertyName(property.getNameNode()) === name);
  if (flags.length !== 1 || !Node.isPropertyAssignment(flags[0])) return false;
  const flag = flags[0].getInitializer();
  return flag !== undefined && unwrap(flag).getKind() === SyntaxKind.TrueKeyword;
}

function configuration(context: PackageContext) {
  const unknown = { allowRoutes: false, authInterrupts: false, globalNotFound: false };
  let allowRoutes = true;
  const configs: Node[] = [];
  for (const extension of ["ts", "js", "mjs", "cjs", "mts"]) {
    const file = context.directory === "." ? `next.config.${extension}` : `${context.directory}/next.config.${extension}`;
    context.fileSystem.blocked.clear();
    const exists = context.fileSystem.host.fileExists(path.join(context.rootPath, file));
    if (context.fileSystem.blocked.size > 0) return unknown;
    if (!exists) continue;
    const parsed = context.files.find(candidate => candidate.discovered.path === file)?.sourceFile;
    if (!parsed || parsed.getDescendantsOfKind(SyntaxKind.CallExpression).length > 0) return unknown;
    let value: Node | undefined = parsed.getExportAssignments().find(item => !item.isExportEquals())?.getExpression();
    if (!value) {
      for (const expression of parsed.getDescendantsOfKind(SyntaxKind.BinaryExpression)) {
        if (expression.getLeft().getText() === "module.exports") value = expression.getRight();
      }
    }
    if (!value) return unknown;
    value = unwrap(value);
    if (Node.isIdentifier(value)) {
      const symbol = value.getSymbol();
      const declaration = symbol?.getDeclarations()[0];
      if (!declaration || !Node.isVariableDeclaration(declaration)
        || declaration.getVariableStatement()?.getDeclarationKind() !== "const") return unknown;
      // A plain object is safe only while nobody mutates it or passes it to a
      // plugin. Config code is inspected, never executed.
      if (parsed.getDescendantsOfKind(SyntaxKind.Identifier).some(identifier => identifier.getSymbol() === symbol
        && identifier !== value && identifier !== declaration.getNameNode())) return unknown;
      value = declaration.getInitializer();
      if (value) value = unwrap(value);
    }
    if (!value || !Node.isObjectLiteralExpression(value)) return unknown;
    if (parsed.getDescendantsOfKind(SyntaxKind.BinaryExpression).some(expression =>
      expression.getLeft().getText().startsWith("module.exports.") || expression.getLeft().getText().startsWith("exports."))) return unknown;
    for (const property of value.getProperties()) {
      if (Node.isSpreadAssignment(property)) return unknown;
      const nameNode = property.getNameNode();
      if (!Node.isIdentifier(nameNode) && !Node.isStringLiteral(nameNode)) return unknown;
      const name = Node.isStringLiteral(nameNode) ? nameNode.getLiteralText() : nameNode.getText();
      if (["basePath", "pageExtensions", "rewrites", "redirects", "exportPathMap", "i18n", "trailingSlash"].includes(name)) allowRoutes = false;
    }
    configs.push(value);
  }
  // An omitted config can change every filesystem route and experimental flag.
  if (context.skippedFiles.some(file => /^next\.config\./.test(localPath(file.path, context.directory))
    && file.reason !== "unsupported-extension")) return unknown;
  return {
    allowRoutes,
    authInterrupts: configs.length === 1 && experimentalFlag(configs[0], "authInterrupts"),
    globalNotFound: configs.length === 1 && experimentalFlag(configs[0], "globalNotFound"),
  };
}

function routePath(parts: readonly string[], groups = true) {
  const segments: string[] = [];
  for (const part of parts) {
    if (part.startsWith("_") || part.startsWith("@")) return null;
    if (groups && /^\([A-Za-z0-9_-][^()]*\)$/.test(part)) continue;
    if (/^\[[A-Za-z0-9_-]+\]$/.test(part)
      || /^\[\.\.\.[A-Za-z0-9_-]+\]$/.test(part)
      || /^\[\[\.\.\.[A-Za-z0-9_-]+\]\]$/.test(part)) {
      segments.push(part);
    } else if (/^[A-Za-z0-9_~!$&'+,;=.:-]+$/.test(part)) segments.push(part);
    else return null;
  }
  return "/" + segments.join("/");
}

function defaultExportLine(source: SourceFile) {
  const declarations = source.getDefaultExportSymbol()?.getDeclarations();
  return declarations?.[0]?.getStartLineNumber() ?? null;
}

function callableDeclaration(node: Node) {
  if (Node.isFunctionDeclaration(node)) return node;
  if (Node.isVariableDeclaration(node)) {
    const initializer = node.getInitializer();
    if (initializer && (Node.isArrowFunction(initializer) || Node.isFunctionExpression(initializer))) return initializer;
  }
  return null;
}

function appHandlers(source: SourceFile, file: string, route: string): HttpRoute[] {
  const routes: HttpRoute[] = [];
  for (const [name, declarations] of source.getExportedDeclarations()) {
    if (!METHODS.has(name)) continue;
    for (const declaration of declarations) {
      if (declaration.getSourceFile() !== source || !callableDeclaration(declaration)) continue;
      routes.push({ file, method: name, path: route, line: declaration.getStartLineNumber() });
      break;
    }
  }
  return routes;
}

function hasExport(source: SourceFile, name: string) {
  // Export aliases and re-exports are entries too, even when the handler's
  // implementation cannot be recovered well enough to publish an HTTP route.
  return source.getExportSymbols().some(symbol => symbol.getName() === name);
}

function specialAppEntry(parts: readonly string[], config: ReturnType<typeof configuration>) {
  const basename = parts[parts.length - 1];
  if (parts.slice(0, -1).some(part => part.startsWith("_"))) return false;
  if (["template", "default", "loading", "error", "not-found", "sitemap"].includes(basename)) return true;
  // Next 16's metadata matcher permits one optional digit, not an arbitrary number.
  if (/^(icon|apple-icon|opengraph-image|twitter-image)\d?$/.test(basename)) return true;
  if (["forbidden", "unauthorized"].includes(basename)) return config.authInterrupts;
  if (parts.length !== 1) return false;
  if (["global-error", "robots", "manifest"].includes(basename)) return true;
  return basename === "global-not-found" && config.globalNotFound;
}

function hookDirectory(context: PackageContext, appRoot: string, pagesRoot: string) {
  // Next resolves server hooks beside the active pages directory, or app when
  // there is no pages directory. An inactive src tree must not supply hooks.
  for (const root of [pagesRoot, appRoot]) {
    context.fileSystem.blocked.clear();
    if (context.fileSystem.host.directoryExists?.(path.join(context.rootPath, context.directory, root))
      && context.fileSystem.blocked.size === 0) return path.posix.dirname(root);
  }
  return null;
}

export function analyzeNext(context: PackageContext) {
  const fileRoles: FileRoleRecord[] = [];
  const frameworkEntries: string[] = [];
  const routes: HttpRoute[] = [];
  const appRoot = routingRoot(context, "app");
  const pagesRoot = routingRoot(context, "pages");
  const hooks = hookDirectory(context, appRoot, pagesRoot);
  const config = configuration(context);
  const { allowRoutes } = config;
  for (const { discovered, sourceFile } of context.files) {
    const file = discovered.path;
    const local = localPath(file, context.directory);
    const app = local.startsWith(`${appRoot}/`) && EXTENSION.test(local)
      ? local.slice(appRoot.length + 1).replace(EXTENSION, "").split("/") : null;
    const pages = local.startsWith(`${pagesRoot}/`) && EXTENSION.test(local)
      ? local.slice(pagesRoot.length + 1).replace(EXTENSION, "").split("/") : null;
    if (app && specialAppEntry(app, config) && hasExport(sourceFile, "default")) frameworkEntries.push(file);
    if (pages?.length === 1 && ["_app", "_document", "_error"].includes(pages[0])
      && hasExport(sourceFile, "default")) frameworkEntries.push(file);
    if (hooks !== null && path.posix.dirname(local) === hooks && EXTENSION.test(local)) {
      const basename = path.posix.basename(local).replace(EXTENSION, "");
      if (["middleware", "proxy"].includes(basename)
        && (hasExport(sourceFile, "default") || hasExport(sourceFile, basename))) frameworkEntries.push(file);
      // Instrumentation can have only module side effects; both hooks are optional.
      if (basename === "instrumentation") frameworkEntries.push(file);
    }
    let role = reactRole(sourceFile, local);
    if (hasDirective(sourceFile, "use server") || sourceFile.getDescendantsOfKind(SyntaxKind.Block)
      .some(block => hasDirective(block, "use server"))) role = "action";
    if (app) {
      const basename = app[app.length - 1];
      const route = routePath(app.slice(0, -1));
      if (route !== null) {
        if (basename === "layout") role = "layout";
        if (basename === "page") {
          role = "page";
          const line = defaultExportLine(sourceFile);
          if (allowRoutes && line !== null) routes.push({ file, method: "GET", path: route, line });
        }
        if (basename === "route") {
          role = "api";
          if (allowRoutes) routes.push(...appHandlers(sourceFile, file, route));
        }
      }
    }
    if (pages && !pages.some(part => part.startsWith("_"))) {
      const api = pages[0] === "api";
      const segments = pages[pages.length - 1] === "index" ? pages.slice(0, -1) : pages;
      const route = routePath(segments, false);
      if (route !== null) {
        role = api ? "api" : "page";
        // A pages API function has no declarative method list. Checking
        // req.method can reject that verb just as readily as implement it.
        if (allowRoutes && !api) {
          const line = defaultExportLine(sourceFile);
          if (line !== null) routes.push({ file, method: "GET", path: route, line });
        }
      }
    }
    if (role) fileRoles.push({ file, role });
  }
  return { fileRoles, frameworkEntries: [...new Set(frameworkEntries)].sort(compareText), routes };
}
