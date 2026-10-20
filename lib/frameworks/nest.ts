import { Node, SyntaxKind, type CallExpression, type ClassDeclaration, type Decorator } from "ts-morph";
import type { FileRoleRecord, HttpRoute } from "../parser/contract";
import {
  importedName, joinRoute, literalString, literalStrings, localPath,
  objectProperty, safeRoutePart, unwrap, type PackageContext,
} from "./shared";

const HTTP_DECORATORS = new Map([
  ["Get", "GET"], ["Head", "HEAD"], ["Post", "POST"], ["Put", "PUT"],
  ["Patch", "PATCH"], ["Delete", "DELETE"], ["Options", "OPTIONS"],
]);

function decoratorName(decorator: Decorator) {
  const expression = decorator.getExpression();
  return importedName(Node.isCallExpression(expression) ? expression.getExpression() : expression, "@nestjs/common");
}

function decoratorPaths(decorator: Decorator, controller: boolean) {
  const expression = decorator.getExpression();
  if (!Node.isCallExpression(expression)) return null;
  const args = expression.getArguments();
  if (args.length > 1) return null;
  const argument = args[0];
  if (argument && Node.isObjectLiteralExpression(unwrap(argument))) {
    if (!controller) return null;
    const value = unwrap(argument);
    if (!Node.isObjectLiteralExpression(value) || value.getProperties().some(property =>
      !Node.isPropertyAssignment(property) || property.getNameNode().getText() !== "path")
      || value.getProperties().length > 1) return null;
    return literalStrings(objectProperty(argument, "path"));
  }
  return literalStrings(argument);
}

function resolvedClass(expression: Node): ClassDeclaration | null {
  const value = unwrap(expression);
  if (Node.isClassDeclaration(value)) return value;
  if (!Node.isIdentifier(value)) return null;
  const symbol = value.getSymbol();
  const declarations = (symbol?.getAliasedSymbol() ?? symbol)?.getDeclarations() ?? [];
  return declarations.find(Node.isClassDeclaration) ?? null;
}

function isFactoryCreate(call: CallExpression) {
  const expression = call.getExpression();
  return Node.isPropertyAccessExpression(expression) && expression.getName() === "create"
    && importedName(expression.getExpression(), "@nestjs/core") === "NestFactory";
}

function bootstrap(context: PackageContext) {
  if (context.skippedFiles.some(file => file.reason === "parse-failed"
    || /(^|\/)(main|bootstrap)\.[cm]?[jt]s$/.test(file.path))) return null;
  const calls = context.files.flatMap(file => file.sourceFile.getDescendantsOfKind(SyntaxKind.CallExpression));
  // RouterModule can prefix an entire imported subtree. Until its module graph is
  // recoverable, even an otherwise literal controller path is incomplete.
  if (calls.some(call => {
    const expression = call.getExpression();
    return Node.isPropertyAccessExpression(expression)
      && importedName(expression.getExpression(), "@nestjs/core") === "RouterModule";
  })) return null;
  const creates = calls.filter(isFactoryCreate);
  if (creates.length !== 1) return null;
  const create = creates[0];
  const awaited = create.getParent();
  const variable = awaited && Node.isAwaitExpression(awaited) ? awaited.getParent() : null;
  if (!variable || !Node.isVariableDeclaration(variable) || !Node.isIdentifier(variable.getNameNode())) return null;
  if (variable.getVariableStatement()?.getDeclarationKind() !== "const") return null;
  const moduleArgument = create.getArguments()[0];
  const rootModule = moduleArgument ? resolvedClass(moduleArgument) : null;
  if (!rootModule) return null;
  // A custom HTTP adapter can add an independent mount prefix.
  if (create.getArguments().length > 1) return null;
  const statement = variable.getVariableStatement();
  const block = statement?.getParent();
  if (!block || !Node.isBlock(block)) return null;
  const symbol = variable.getSymbol();
  const starts = calls.filter(call => {
    const expression = call.getExpression();
    return Node.isPropertyAccessExpression(expression)
      && ["listen", "init"].includes(expression.getName()) && expression.getExpression().getSymbol() === symbol;
  });
  if (starts.length === 0) return null;
  const firstStart = Math.min(...starts.map(call => call.getStart()));
  let prefix = "";
  let prefixCalls = 0;
  for (const identifier of create.getSourceFile().getDescendantsOfKind(SyntaxKind.Identifier)) {
    if (identifier.getSymbol() !== symbol || identifier === variable.getNameNode()) continue;
    const access = identifier.getParent();
    const call = access?.getParent();
    if (!access || !Node.isPropertyAccessExpression(access) || access.getExpression() !== identifier
      || !call || !Node.isCallExpression(call) || call.getExpression() !== access) return null;
    const name = access.getName();
    if (name === "enableVersioning") return null;
    if (name === "setGlobalPrefix") {
      const callStatement = call.getParent();
      // Conditional configuration does not establish one exact prefix.
      if (!callStatement || !Node.isExpressionStatement(callStatement) || callStatement.getParent() !== block) return null;
      if (call.getStart() > firstStart || call.getArguments().length !== 1 || ++prefixCalls > 1) return null;
      const value = literalString(call.getArguments()[0]);
      if (value === null || !safeRoutePart(value) || value.includes(":")) return null;
      prefix = value;
    } else if (!["listen", "init", "enableCors", "useGlobalPipes", "useGlobalFilters", "useGlobalInterceptors",
      "useGlobalGuards", "enableShutdownHooks", "useLogger", "flushLogs"].includes(name)) return null;
  }
  return { prefix, rootModule };
}

function registeredControllers(root: ClassDeclaration) {
  const controllers = new Set<ClassDeclaration>();
  const visited = new Set<ClassDeclaration>();
  let complete = true;
  function walk(module: ClassDeclaration) {
    if (visited.has(module)) return;
    visited.add(module);
    const decorator = module.getDecorators().find(item => decoratorName(item) === "Module");
    const expression = decorator?.getExpression();
    const metadata = expression && Node.isCallExpression(expression) ? expression.getArguments()[0] : undefined;
    if (module.getDecorators().length !== 1 || !metadata || !Node.isObjectLiteralExpression(unwrap(metadata))) { complete = false; return; }
    const object = unwrap(metadata);
    if (!Node.isObjectLiteralExpression(object) || object.getProperties().some(property =>
      !Node.isPropertyAssignment(property) || Node.isComputedPropertyName(property.getNameNode()))) { complete = false; return; }
    const names = object.getProperties().map(property => property.getText().split(":", 1)[0]);
    if (new Set(names).size !== names.length) { complete = false; return; }
    const declared = objectProperty(metadata, "controllers");
    if (declared) {
      const array = unwrap(declared);
      if (!Node.isArrayLiteralExpression(array)) { complete = false; return; }
      for (const entry of array.getElements()) {
        const controller = resolvedClass(entry);
        if (!controller) { complete = false; return; }
        controllers.add(controller);
      }
    }
    const imports = objectProperty(metadata, "imports");
    if (imports) {
      const array = unwrap(imports);
      if (!Node.isArrayLiteralExpression(array)) { complete = false; return; }
      for (const entry of array.getElements()) {
        if (Node.isSpreadElement(entry)) { complete = false; return; }
        const imported = resolvedClass(entry);
        if (imported) walk(imported);
        else {
          // Dynamic or external modules may configure router metadata that
          // changes a local controller's prefix.
          complete = false;
          return;
        }
      }
    }
  }
  walk(root);
  return complete ? controllers : new Set<ClassDeclaration>();
}

export function analyzeNest(context: PackageContext) {
  const fileRoles: FileRoleRecord[] = [];
  const routes: HttpRoute[] = [];
  const boot = bootstrap(context);
  const registered = boot ? registeredControllers(boot.rootModule) : new Set<ClassDeclaration>();
  for (const { discovered, sourceFile } of context.files) {
    const file = discovered.path;
    const local = localPath(file, context.directory);
    const classes = sourceFile.getClasses();
    const suffix = /\.(controller|service|module|entity)\.[cm]?[jt]s$/.exec(local)?.[1];
    let role: FileRoleRecord["role"] | null = suffix === "controller" || suffix === "service"
      || suffix === "module" || suffix === "entity" ? suffix : null;
    if (classes.some(item => item.getDecorators().some(decorator => decoratorName(decorator) === "Module"))) role = "module";
    if (classes.some(item => item.getDecorators().some(decorator => decoratorName(decorator) === "Controller"))) role = "controller";
    if (role) fileRoles.push({ file, role });
    if (!boot) continue;
    for (const controller of classes) {
      if (!registered.has(controller) || controller.getExtends()) continue;
      const decorators = controller.getDecorators().filter(decorator => decoratorName(decorator) === "Controller");
      if (decorators.length !== 1 || controller.getDecorators().length !== 1) continue;
      const prefixes = decoratorPaths(decorators[0], true);
      if (!prefixes || !prefixes.every(safeRoutePart)) continue;
      for (const method of controller.getMethods()) {
        const decorators = method.getDecorators();
        // Even a framework decorator such as SetMetadata can replace route
        // metadata. A single recognized handler is the recoverable subset.
        if (decorators.length !== 1) continue;
        const handlers = decorators.filter(decorator => HTTP_DECORATORS.has(decoratorName(decorator) ?? ""));
        if (handlers.length !== 1) continue;
        const handler = handlers[0];
        const verb = HTTP_DECORATORS.get(decoratorName(handler) ?? "");
        const paths = decoratorPaths(handler, false);
        if (!verb || !paths || !paths.every(safeRoutePart)) continue;
        for (const prefix of prefixes) for (const route of paths) {
          routes.push({ file, method: verb, path: joinRoute(boot.prefix, prefix, route), line: handler.getStartLineNumber() });
        }
      }
    }
  }
  return { fileRoles, routes };
}
