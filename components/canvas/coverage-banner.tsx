import type { AnalysisCoverage } from "@/lib/parser/contract";
import { formatPercent, summarizeCoverage } from "./coverage";

function Metric({ label, numerator, denominator, percent }: {
  label: string;
  numerator: number;
  denominator: number;
  percent: number | null;
}) {
  return <span className="coverage-metric">
    <span className="coverage-label">{label}</span>
    <strong>{formatPercent(percent)}</strong>
    <span className="coverage-count">{numerator}/{denominator}</span>
  </span>;
}

// Always a <details>, so the numeric line survives when collapsed. It is open
// by default whenever anything was skipped or unresolved: an incomplete map
// must not silently look complete.
export default function CoverageBanner({ coverage }: { coverage: AnalysisCoverage }) {
  const summary = summarizeCoverage(coverage);
  const skippedReasons = new Map<string, number>();
  for (const file of coverage.files.skippedFiles) {
    skippedReasons.set(file.reason, (skippedReasons.get(file.reason) ?? 0) + 1);
  }
  const unresolved = coverage.imports.unresolved;
  const excluded = coverage.imports.excluded;

  return <details className="coverage-banner" open={!summary.complete}>
    <summary>
      <span className="coverage-title">{summary.complete ? "Coverage" : "Incomplete map"}</span>
      <Metric {...summary.files} />
      <Metric {...summary.imports} />
      {coverage.files.excludedDirectories.length > 0 && <span className="coverage-metric">
        <span className="coverage-label">Directories excluded</span>
        <strong>{coverage.files.excludedDirectories.length}</strong>
      </span>}
    </summary>
    <div className="coverage-detail">
      <p>
        File coverage counts files found under the repository root, including files skipped for unsupported extensions. Import coverage counts local
        imports that resolved to a parsed file; external packages are not part of that denominator.
      </p>
      {coverage.files.skippedFiles.length > 0 && <div>
        <h3>Skipped files ({coverage.files.skippedFiles.length})</h3>
        <ul>{[...skippedReasons.entries()].sort().map(([reason, count]) =>
          <li key={reason}><span className="font-mono">{reason}</span> — {count}</li>)}
        </ul>
        <details><summary>Paths</summary>
          <ul>{coverage.files.skippedFiles.slice(0, 100).map(file =>
            <li key={file.path}><span className="font-mono">{file.path}</span> — {file.reason}{file.detail ? ` (${file.detail})` : ""}</li>)}
          </ul>
          {coverage.files.skippedFiles.length > 100 && <p>Showing the first 100 of {coverage.files.skippedFiles.length}.</p>}
        </details>
      </div>}
      {coverage.files.excludedDirectories.length > 0 && <div>
        <h3>Excluded directories ({coverage.files.excludedDirectories.length})</h3>
        <p>These directories were not enumerated, so their file counts are not in the denominator.</p>
        <ul>{coverage.files.excludedDirectories.slice(0, 100).map(directory =>
          <li key={directory.path}><span className="font-mono">{directory.path}</span> — {directory.reason}{directory.detail ? ` (${directory.detail})` : ""}</li>)}
        </ul>
      </div>}
      {(unresolved > 0 || excluded > 0) && <div>
        <h3>Local imports not resolved ({unresolved + excluded})</h3>
        <p>{unresolved} unresolved, {excluded} excluded. No edge is drawn for these.</p>
        <ul>{coverage.imports.discovered > 0 && <li>{coverage.imports.external} external package imports were resolved as external and are not missing edges.</li>}</ul>
      </div>}
    </div>
  </details>;
}
