import { Node, SyntaxKind, type SourceFile } from "ts-morph";
import type { ImportKind } from "./contract";

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
    if (call.getExpression().getKind() !== SyntaxKind.ImportKeyword) continue;
    const argument = call.getArguments()[0];
    const specifier = Node.isStringLiteral(argument) || Node.isNoSubstitutionTemplateLiteral(argument)
      ? argument.getLiteralValue()
      : null;
    occurrences.push({
      source,
      specifier,
      kind: "dynamic-import",
      line: call.getStartLineNumber(),
    });
  }

  return occurrences.sort(compareOccurrences);
}
