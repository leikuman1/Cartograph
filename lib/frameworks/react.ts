import { Node, SyntaxKind, type SourceFile } from "ts-morph";
import type { FileRole } from "./taxonomy";

export function reactRole(source: SourceFile, file: string): FileRole | null {
  const functions = source.getDescendants().filter(node =>
    Node.isFunctionDeclaration(node) || Node.isArrowFunction(node) || Node.isFunctionExpression(node));
  for (const fn of functions) {
    const parent = fn.getParent();
    const name = Node.isFunctionDeclaration(fn) ? fn.getName()
      : parent && Node.isVariableDeclaration(parent) ? parent.getName() : undefined;
    if (name && /^use[A-Z0-9]/.test(name)
      && fn.getDescendantsOfKind(SyntaxKind.CallExpression).some(call => {
        const expression = call.getExpression();
        const called = Node.isIdentifier(expression) ? expression.getText()
          : Node.isPropertyAccessExpression(expression) ? expression.getName() : "";
        return /^use[A-Z0-9]/.test(called);
      })) return "hook";
  }
  const hasJsx = source.getDescendants().some(node => Node.isJsxElement(node)
    || Node.isJsxSelfClosingElement(node) || Node.isJsxFragment(node));
  if (hasJsx && (/\.[jt]sx$/.test(file)) && functions.length > 0) return "component";
  if (/(^|\/)hooks\/use[A-Z][^/]*\.[jt]sx?$/.test(file)
    && functions.some(fn => Node.isFunctionDeclaration(fn) && fn.isExported())) return "hook";
  return null;
}
