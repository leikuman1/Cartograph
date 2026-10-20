import path from "node:path";
import { Node, type Expression, type SourceFile } from "ts-morph";
import type { SkippedFile } from "../parser/contract";
import type { RepositoryFileSystem } from "../parser/filesystem";
import type { ParsedSourceFile } from "../parser/resolution";
import type { Framework } from "./taxonomy";

export interface FrameworkContext {
  rootPath: string;
  sourceFiles: readonly ParsedSourceFile[];
  packageDirectories: ReadonlySet<string>;
  skippedFiles: readonly SkippedFile[];
}

export interface PackageContext {
  directory: string;
  framework: Framework;
  files: readonly ParsedSourceFile[];
  skippedFiles: readonly SkippedFile[];
  fileSystem: RepositoryFileSystem;
  rootPath: string;
}

export function compareText(left: string, right: string) {
  return left < right ? -1 : left > right ? 1 : 0;
}

export function nearestPackage(file: string, directories: ReadonlySet<string>) {
  let current = path.posix.dirname(file);
  while (current !== ".") {
    if (directories.has(current)) return current;
    current = path.posix.dirname(current);
  }
  return ".";
}

export function localPath(file: string, directory: string) {
  return directory === "." ? file : file.slice(directory.length + 1);
}

export function unwrap(expression: Node): Node {
  let current = expression;
  while (Node.isParenthesizedExpression(current) || Node.isAsExpression(current)
    || Node.isSatisfiesExpression(current) || Node.isTypeAssertion(current)) {
    current = current.getExpression();
  }
  return current;
}

export function literalString(node: Node | undefined): string | null {
  if (!node) return null;
  const value = unwrap(node);
  return Node.isStringLiteral(value) || Node.isNoSubstitutionTemplateLiteral(value)
    ? value.getLiteralText() : null;
}

export function literalStrings(node: Node | undefined): string[] | null {
  if (!node) return [""];
  const value = unwrap(node);
  if (Node.isArrayLiteralExpression(value)) {
    const strings = value.getElements().map(element => literalString(element));
    return strings.every((item): item is string => item !== null) ? strings : null;
  }
  const text = literalString(value);
  return text === null ? null : [text];
}

// Compare bindings, rather than identifier spelling: aliases work and a local
// function named Controller/Get/etc. cannot impersonate a framework decorator.
export function importedName(node: Node, moduleName: string): string | null {
  const target = unwrap(node);
  if (Node.isIdentifier(target)) {
    for (const declaration of target.getSymbol()?.getDeclarations() ?? []) {
      if (!Node.isImportSpecifier(declaration)) continue;
      const importDeclaration = declaration.getFirstAncestor(Node.isImportDeclaration);
      if (importDeclaration
        && importDeclaration.getModuleSpecifierValue() === moduleName
        && !importDeclaration.isTypeOnly() && !declaration.isTypeOnly()) {
        return declaration.getName();
      }
    }
  }
  if (Node.isPropertyAccessExpression(target)) {
    const receiver = target.getExpression();
    if (!Node.isIdentifier(receiver)) return null;
    for (const declaration of receiver.getSymbol()?.getDeclarations() ?? []) {
      if (!Node.isNamespaceImport(declaration)) continue;
      const importDeclaration = declaration.getParent();
      if (Node.isImportClause(importDeclaration)) {
        const statement = importDeclaration.getParent();
        if (Node.isImportDeclaration(statement) && statement.getModuleSpecifierValue() === moduleName && !statement.isTypeOnly()) {
          return target.getName();
        }
      }
    }
  }
  return null;
}

export function objectProperty(expression: Node, name: string): Expression | undefined {
  const value = unwrap(expression);
  if (!Node.isObjectLiteralExpression(value)) return undefined;
  const property = value.getProperty(name);
  return property && Node.isPropertyAssignment(property) ? property.getInitializer() : undefined;
}

export function hasDirective(source: SourceFile | Node, directive: string) {
  const statements = Node.isSourceFile(source) || Node.isBlock(source) ? source.getStatements() : [];
  for (const statement of statements) {
    if (!Node.isExpressionStatement(statement)) return false;
    const text = literalString(statement.getExpression());
    if (text === null) return false;
    if (text === directive) return true;
  }
  return false;
}

export function safeRoutePart(value: string) {
  // Nest uses path-to-regexp; punctuation with adapter/version-dependent meaning
  // cannot be translated into one reliable pattern here.
  const trimmed = value.replace(/^\/|\/$/g, "");
  return trimmed === "" || trimmed.split("/").every(segment =>
    /^[A-Za-z0-9_.~-]+$/.test(segment) || /^:[A-Za-z_][A-Za-z0-9_]*$/.test(segment));
}

export function joinRoute(...parts: string[]) {
  return "/" + parts.map(part => part.replace(/^\/+|\/+$/g, "")).filter(Boolean).join("/");
}
