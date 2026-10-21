import { Node, SyntaxKind, type SourceFile } from "ts-morph";
import { compareExportNames } from "./export-names";

const bindings = new WeakMap<SourceFile, Map<string, Set<Node>>>();

function bindingScope(node: Node, functionScoped = false): Node {
  return node.getAncestors().find(ancestor => Node.isSourceFile(ancestor)
    || Node.isFunctionLikeDeclaration(ancestor)
    || (!functionScoped && (Node.isBlock(ancestor) || Node.isCaseBlock(ancestor)
      || Node.isCatchClause(ancestor) || Node.isForStatement(ancestor)
      || Node.isForInStatement(ancestor) || Node.isForOfStatement(ancestor)))) ?? node.getSourceFile();
}

function sourceBindings(source: SourceFile) {
  const cached = bindings.get(source);
  if (cached) return cached;
  const scopes = new Map<string, Set<Node>>();
  function add(name: Node | undefined, scope: Node) {
    if (!name) return;
    if (Node.isIdentifier(name)) {
      const existing = scopes.get(name.getText()) ?? new Set<Node>();
      existing.add(scope);
      scopes.set(name.getText(), existing);
    } else if (Node.isObjectBindingPattern(name) || Node.isArrayBindingPattern(name)) {
      for (const element of name.getElements()) {
        if (Node.isBindingElement(element)) add(element.getNameNode(), scope);
      }
    }
  }
  source.forEachDescendant((declaration, traversal) => {
    // Ambient declarations describe existing globals; they create no runtime
    // bindings, including declarations nested inside a declare global block.
    if (Node.isAmbientable(declaration) && declaration.isAmbient()) {
      traversal.skip();
      return;
    }
    if (Node.isVariableDeclaration(declaration)) {
      const list = declaration.getFirstAncestorByKind(SyntaxKind.VariableDeclarationList);
      add(declaration.getNameNode(), bindingScope(declaration, list?.getDeclarationKind() === "var"));
    } else if (Node.isParameterDeclaration(declaration)) {
      add(declaration.getNameNode(), bindingScope(declaration, true));
    } else if (Node.isFunctionDeclaration(declaration) || Node.isClassDeclaration(declaration)) {
      add(declaration.getNameNode(), bindingScope(declaration));
    } else if (Node.isFunctionExpression(declaration) || Node.isClassExpression(declaration)) {
      add(declaration.getNameNode(), declaration);
    } else if (Node.isImportClause(declaration)) {
      add(declaration.getDefaultImport(), source);
    } else if (Node.isImportSpecifier(declaration)) {
      add(declaration.getAliasNode() ?? declaration.getNameNode(), source);
    } else if (Node.isNamespaceImport(declaration) || Node.isImportEqualsDeclaration(declaration)) {
      add(declaration.getNameNode(), source);
    }
  });
  bindings.set(source, scopes);
  return scopes;
}

// TypeScript's JS binder synthesizes CommonJS symbols, even for a local module
// variable. Explicit binding scopes also cover hoisting and lexical TDZ without
// allowing a sibling function's parameter to hide the runtime require binding.
export function isCommonJsIdentifier(node: Node | undefined, name: string): boolean {
  if (!node || !Node.isIdentifier(node) || node.getText() !== name) return false;
  const scopes = sourceBindings(node.getSourceFile()).get(name);
  return !scopes || !node.getAncestors().some(ancestor => scopes.has(ancestor));
}

function unwrap(node: Node): Node {
  if (Node.isParenthesizedExpression(node)
    || Node.isAsExpression(node)
    || Node.isTypeAssertion(node)
    || Node.isNonNullExpression(node)
    || Node.isSatisfiesExpression(node)) return unwrap(node.getExpression());
  return node;
}

function member(node: Node): { receiver: Node; name: string | null } | null {
  const value = unwrap(node);
  if (Node.isPropertyAccessExpression(value)) {
    return { receiver: value.getExpression(), name: value.getName() };
  }
  if (Node.isElementAccessExpression(value)) {
    const argument = value.getArgumentExpression();
    return { receiver: value.getExpression(), name: argument && Node.isStringLiteral(argument)
      ? argument.getLiteralValue() : null };
  }
  return null;
}

function isModuleExports(node: Node) {
  const access = member(node);
  return access?.name === "exports" && isCommonJsIdentifier(access.receiver, "module");
}

function propertyName(node: Node): string | null {
  if (Node.isIdentifier(node)) return node.getText();
  if (Node.isStringLiteral(node)) return node.getLiteralValue();
  if (Node.isNumericLiteral(node)) return String(node.getLiteralValue());
  if (Node.isComputedPropertyName(node)) {
    const expression = node.getExpression();
    if (Node.isStringLiteral(expression)) return expression.getLiteralValue();
    if (Node.isNumericLiteral(expression)) return String(expression.getLiteralValue());
  }
  return null;
}

export function extractCommonJsExports(sourceFile: SourceFile): string[] {
  let moduleNames = new Set<string>();
  let aliasNames = moduleNames;

  function valueNames(node: Node): Set<string> {
    const value = unwrap(node);
    if (isModuleExports(value)) return moduleNames;
    if (isCommonJsIdentifier(value, "exports")) return aliasNames;
    if (Node.isBinaryExpression(value) && value.getOperatorToken().getKind() === SyntaxKind.EqualsToken) {
      return assign(value.getLeft(), value.getRight());
    }
    if (Node.isObjectLiteralExpression(value)) {
      const names = new Set<string>();
      for (const property of value.getProperties()) {
        // A spread or dynamic key can overwrite a known key, but cannot make it
        // disappear. Record only keys explicitly present in this object literal.
        if (Node.isSpreadAssignment(property)) continue;
        const name = propertyName(property.getNameNode());
        const prototypeSetter = name === "__proto__" && Node.isPropertyAssignment(property)
          && !Node.isComputedPropertyName(property.getNameNode());
        if (name !== null && !prototypeSetter) names.add(name);
      }
      return names;
    }
    return new Set(["default"]);
  }

  function assign(left: Node, right: Node): Set<string> {
    const target = unwrap(left);
    const access = member(target);
    // Ordinary targets can wrap an export assignment in the same direct chain.
    const names = valueNames(right);
    if (isModuleExports(target)) moduleNames = names;
    else if (isCommonJsIdentifier(target, "exports")) aliasNames = names;
    else {
      if (access && access.name !== null) {
        if (isModuleExports(access.receiver)) moduleNames.add(access.name);
        else if (isCommonJsIdentifier(access.receiver, "exports")) aliasNames.add(access.name);
      }
    }
    return names;
  }

  // Conditional and function-body writes do not prove a module's export shape.
  // Process direct assignments in order so replacements and a detached exports
  // alias cannot leave names behind from the wrong object.
  for (const statement of sourceFile.getStatements()) {
    if (Node.isExpressionStatement(statement)) valueNames(statement.getExpression());
    else if (Node.isVariableStatement(statement) && !statement.isAmbient()) {
      for (const declaration of statement.getDeclarations()) {
        const initializer = declaration.getInitializer();
        if (initializer) valueNames(initializer);
      }
    }
  }
  return [...moduleNames].sort(compareExportNames);
}
