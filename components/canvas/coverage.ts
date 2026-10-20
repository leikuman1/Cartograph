import type { AnalysisCoverage } from "@/lib/parser/contract";

export interface CoverageMetric {
  label: string;
  numerator: number;
  denominator: number;
  percent: number | null;
}

export interface CoverageSummary {
  files: CoverageMetric;
  imports: CoverageMetric;
  complete: boolean;
}

function metric(label: string, numerator: number, denominator: number): CoverageMetric {
  return {
    label,
    numerator,
    denominator,
    // Absent beats approximate: no denominator means no percentage.
    percent: denominator === 0 ? null : (numerator / denominator) * 100,
  };
}

// File coverage answers "how much of what we saw did we parse"; import
// coverage answers "how many local imports resolved". They are kept separate
// because a high file percentage can hide broken aliases and missing edges.
export function summarizeCoverage(coverage: AnalysisCoverage): CoverageSummary {
  const localImports = coverage.imports.internal + coverage.imports.unresolved + coverage.imports.excluded;
  const files = metric("Files parsed", coverage.files.parsed, coverage.files.discovered);
  const imports = metric("Local imports resolved", coverage.imports.internal, localImports);
  const complete = coverage.files.skipped === 0
    && coverage.files.excludedDirectories.length === 0
    && coverage.imports.unresolved === 0
    && coverage.imports.excluded === 0
    && (files.percent === null || files.percent >= 95)
    && (imports.percent === null || imports.percent >= 95);
  return { files, imports, complete };
}

export function formatPercent(value: number | null) {
  return value === null ? "n/a" : `${value.toFixed(1)}%`;
}
