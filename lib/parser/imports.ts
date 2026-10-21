import { Node, SyntaxKind, type SourceFile } from "ts-morph";
import type { ImportKind } from "./contract";
import { isCommonJsIdentifier } from "./commonjs";

export interface ImportOccurrence {
  source: string;
  specifier: string | null;
  kind: ImportKind;
  line: number;
}

function compareText(left: string, right: string) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function compareOccurrences(left: ImportOccurrence, right: ImportOccurrence) {
  return left.line - right.line
    || compareText(left.kind, right.kind)
    || compareText(left.specifier ?? "", right.specifier ?? "");
}

export function extractImports(sourceFile: SourceFile, source: string) {
  const occurrences: ImportOccurrence[] = [];

  for (const declaration of sourceFile.getImportDeclarations()) {
    const specifier = declaration.getModuleSpecifier();
    occurrences.push({
      source,
      specifier: specifier.getLiteralValue(),
      kind: "import",
      line: specifier.getStartLineNumber(),
    });
  }

  for (const declaration of sourceFile.getExportDeclarations()) {
    const specifier = declaration.getModuleSpecifier();
    if (!specifier) continue;
    occurrences.push({
      source,
      specifier: specifier.getLiteralValue(),
      kind: "re-export",
      line: specifier.getStartLineNumber(),
    });
  }

  for (const call of sourceFile.getDescendantsOfKind(SyntaxKind.CallExpression)) {
    const expression = call.getExpression();
    const dynamicImport = expression.getKind() === SyntaxKind.ImportKeyword;
    const commonJs = isCommonJsIdentifier(expression, "require");
    if (!dynamicImport && !commonJs) continue;
    const argument = call.getArguments()[0];
    const specifier = Node.isStringLiteral(argument) || (dynamicImport && Node.isNoSubstitutionTemplateLiteral(argument))
      ? argument.getLiteralValue()
      : null;
    occurrences.push({
      source,
      specifier,
      kind: commonJs ? "require" : "dynamic-import",
      line: call.getStartLineNumber(),
    });
  }

  return occurrences.sort(compareOccurrences);
}
