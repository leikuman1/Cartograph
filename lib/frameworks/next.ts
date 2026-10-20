import path from "node:path";
import { Node, SyntaxKind, type SourceFile } from "ts-morph";
import type { FileRoleRecord, HttpRoute } from "../parser/contract";
import { hasDirective, localPath, unwrap, type PackageContext } from "./shared";
import { reactRole } from "./react";

const METHODS = new Set(["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"]);
const EXTENSION = /\.(tsx|ts|jsx|js)$/;

function routingRoot(context: PackageContext, name: string) {
  context.fileSystem.blocked.clear();
  const exists = context.fileSystem.host.directoryExists?.(path.join(context.rootPath, context.directory, name));
  return exists || context.fileSystem.blocked.size > 0 ? name : `src/${name}`;
}

function configurationAllowsRoutes(context: PackageContext) {
  for (const extension of ["ts", "js", "mjs", "cjs", "mts"]) {
    const file = context.directory === "." ? `next.config.${extension}` : `${context.directory}/next.config.${extension}`;
    context.fileSystem.blocked.clear();
    const exists = context.fileSystem.host.fileExists(path.join(context.rootPath, file));
    if (context.fileSystem.blocked.size > 0) return false;
    if (!exists) continue;
    const parsed = context.files.find(candidate => candidate.discovered.path === file)?.sourceFile;
    if (!parsed || parsed.getDescendantsOfKind(SyntaxKind.CallExpression).length > 0) return false;
    let value: Node | undefined = parsed.getExportAssignments().find(item => !item.isExportEquals())?.getExpression();
    if (!value) {
      for (const expression of parsed.getDescendantsOfKind(SyntaxKind.BinaryExpression)) {
        if (expression.getLeft().getText() === "module.exports") value = expression.getRight();
      }
    }
    if (!value) return false;
    value = unwrap(value);
    if (Node.isIdentifier(value)) {
      const symbol = value.getSymbol();
      const declaration = symbol?.getDeclarations()[0];
      if (!declaration || !Node.isVariableDeclaration(declaration)
        || declaration.getVariableStatement()?.getDeclarationKind() !== "const") return false;
      // A plain object is safe only while nobody mutates it or passes it to a
      // plugin. Config code is inspected, never executed.
      if (parsed.getDescendantsOfKind(SyntaxKind.Identifier).some(identifier => identifier.getSymbol() === symbol
        && identifier !== value && identifier !== declaration.getNameNode())) return false;
      value = declaration.getInitializer();
      if (value) value = unwrap(value);
    }
    if (!value || !Node.isObjectLiteralExpression(value)) return false;
    if (parsed.getDescendantsOfKind(SyntaxKind.BinaryExpression).some(expression =>
      expression.getLeft().getText().startsWith("module.exports.") || expression.getLeft().getText().startsWith("exports."))) return false;
    for (const property of value.getProperties()) {
      if (Node.isSpreadAssignment(property)) return false;
      const nameNode = property.getNameNode();
      if (!Node.isIdentifier(nameNode) && !Node.isStringLiteral(nameNode)) return false;
      const name = Node.isStringLiteral(nameNode) ? nameNode.getLiteralText() : nameNode.getText();
      if (["basePath", "pageExtensions", "rewrites", "redirects", "exportPathMap", "i18n", "trailingSlash"].includes(name)) return false;
    }
  }
  // An omitted config can change every filesystem route.
  return !context.skippedFiles.some(file => /^next\.config\./.test(localPath(file.path, context.directory))
    && file.reason !== "unsupported-extension");
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

export function analyzeNext(context: PackageContext) {
  const fileRoles: FileRoleRecord[] = [];
  const routes: HttpRoute[] = [];
  const appRoot = routingRoot(context, "app");
  const pagesRoot = routingRoot(context, "pages");
  const allowRoutes = configurationAllowsRoutes(context);
  for (const { discovered, sourceFile } of context.files) {
    const file = discovered.path;
    const local = localPath(file, context.directory);
    const app = local.startsWith(`${appRoot}/`) && EXTENSION.test(local)
      ? local.slice(appRoot.length + 1).replace(EXTENSION, "").split("/") : null;
    const pages = local.startsWith(`${pagesRoot}/`) && EXTENSION.test(local)
      ? local.slice(pagesRoot.length + 1).replace(EXTENSION, "").split("/") : null;
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
  return { fileRoles, routes };
}
