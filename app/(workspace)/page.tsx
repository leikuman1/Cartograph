import { Suspense } from "react";
import { requireOrganization } from "@/lib/auth";
import { listAnalyses } from "@/lib/analyses";
import type { AnalysisStatus } from "@/lib/supabase/database.types";

const statusLabels: Record<AnalysisStatus, string> = {
  queued: "Queued",
  running: "Running",
  completed: "Completed",
  failed: "Failed",
};

function formatUtc(value: string) {
  return new Date(value).toISOString().slice(0, 19).replace("T", " ");
}

async function WorkspaceContent() {
  const { orgId, orgSlug } = await requireOrganization();
  const { analyses, hasMore } = await listAnalyses();

  return (
    <section className="flex flex-1 flex-col p-4" aria-labelledby="workspace-title">
      <div className="border-b border-border pb-3">
        <h1 id="workspace-title" className="text-sm font-semibold">Analyses</h1>
        <p className="mt-1 text-xs text-muted">
          Organization <span className="font-mono text-foreground">{orgSlug ?? orgId}</span>
        </p>
        {orgSlug && <p className="mt-1 font-mono text-xs text-muted">{orgId}</p>}
      </div>
      {analyses.length === 0 ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-1 py-16 text-center">
          <p className="text-sm font-medium">No analyses yet</p>
          <p className="text-xs text-muted">This organization has no analysis tasks.</p>
        </div>
      ) : (
        <div className="mt-3 overflow-x-auto">
          <table className="w-full text-left text-xs">
            <caption className="sr-only">Analysis tasks for {orgSlug ?? orgId}</caption>
            <thead className="border-b border-border text-muted">
              <tr>
                <th scope="col" className="py-2 pr-4 font-medium">Project</th>
                <th scope="col" className="px-4 py-2 font-medium">Status</th>
                <th scope="col" className="whitespace-nowrap px-4 py-2 font-medium">Created (UTC)</th>
                <th scope="col" className="whitespace-nowrap py-2 pl-4 font-medium">Completed (UTC)</th>
              </tr>
            </thead>
            <tbody>
              {analyses.map((analysis) => (
                <tr key={analysis.id} className="border-b border-border align-top">
                  <td className="py-3 pr-4">
                    <p className="font-medium">{analysis.project?.name ?? "Project unavailable"}</p>
                    {analysis.is_seed && <p className="mt-1 text-muted">Sample data</p>}
                    {analysis.project && (
                      <p className="mt-1 break-all font-mono text-muted">{analysis.project.repository_url}</p>
                    )}
                  </td>
                  <td className="whitespace-nowrap px-4 py-3">{statusLabels[analysis.status]}</td>
                  <td className="whitespace-nowrap px-4 py-3 font-mono text-muted">
                    <time dateTime={analysis.created_at}>{formatUtc(analysis.created_at)}</time>
                  </td>
                  <td className="whitespace-nowrap py-3 pl-4 font-mono text-muted">
                    {analysis.completed_at ? (
                      <time dateTime={analysis.completed_at}>{formatUtc(analysis.completed_at)}</time>
                    ) : (
                      <span aria-label="Not completed">—</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {hasMore && <p className="mt-3 text-xs text-muted">Showing the latest 50 analyses.</p>}
        </div>
      )}
    </section>
  );
}

function WorkspaceFallback() {
  return (
    <section
      className="flex flex-1 flex-col p-4"
      aria-labelledby="workspace-title"
      aria-busy="true"
    >
      <div className="border-b border-border pb-3">
        <h1 id="workspace-title" className="text-sm font-semibold">Analyses</h1>
        <p className="mt-1 text-xs text-muted">Loading organization…</p>
      </div>
      <div className="flex flex-1 items-center justify-center py-16" role="status">
        <p className="text-xs text-muted">Loading analyses…</p>
      </div>
    </section>
  );
}

export default function WorkspacePage() {
  return (
    <Suspense fallback={<WorkspaceFallback />}>
      <WorkspaceContent />
    </Suspense>
  );
}
