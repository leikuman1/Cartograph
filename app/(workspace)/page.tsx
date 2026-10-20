import { Suspense } from "react";
import AnalysisForm from "./analysis-form";
import AnalysisList from "@/components/pipeline/analysis-list";
import { requireOrganization } from "@/lib/auth";
import { listAnalyses } from "@/lib/analyses";

async function WorkspaceContent() {
  const { orgId, orgSlug } = await requireOrganization();
  // listAnalyses reads a bounded, named snapshot; RLS supplies the organization.
  const { analyses, hasMore } = await listAnalyses();

  return (
    <section className="flex flex-1 flex-col p-4" aria-labelledby="workspace-title">
      <div className="border-b border-border pb-3">
        <h1 id="workspace-title" className="text-sm font-semibold">Analyses</h1>
        <p className="mt-1 text-xs text-muted">
          Organization <span className="font-mono text-foreground">{orgSlug ?? orgId}</span>
        </p>
        {orgSlug && <p className="mt-1 font-mono text-xs text-muted">{orgId}</p>}
        <AnalysisForm organizationId={orgId} />
      </div>
      {analyses.length === 0 ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-1 py-16 text-center">
          <p className="text-sm font-medium">No analyses yet</p>
          <p className="text-xs text-muted">Paste a public GitHub repository URL to draw its dependency map.</p>
        </div>
      ) : (
        <AnalysisList key={orgId} organizationId={orgId} initial={analyses} hasMore={hasMore} />
      )}
    </section>
  );
}

function WorkspaceFallback() {
  return (
    <section className="flex flex-1 flex-col p-4" aria-labelledby="workspace-title" aria-busy="true">
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
