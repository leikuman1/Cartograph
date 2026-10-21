import { Suspense } from "react";
import { notFound } from "next/navigation";
import type { Metadata } from "next";
import AnalysisDetail from "@/components/pipeline/analysis-detail";
import DependencyCanvas from "@/components/canvas/dependency-canvas";
import { getAnalysis, loadAnalysisResult } from "@/lib/analyses";
import { requireOrganization } from "@/lib/auth";

export const metadata: Metadata = { title: "Analysis · Cartograph" };

function isUuid(value: string) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

async function AnalysisPageContent({ params }: { params: Promise<{ id: string }> }) {
  const { orgId } = await requireOrganization();
  const { id } = await params;
  if (!isUuid(id)) notFound();
  const analysis = await getAnalysis(id);
  if (!analysis) notFound();
  // The result is read only after the row says the store completed, so the map
  // never renders a half-written graph.
  const result = analysis.status === "completed" && analysis.run_id
    ? await loadAnalysisResult(id, analysis.run_id) : null;
  return <AnalysisDetail key={orgId} organizationId={orgId} initial={analysis} graphRunId={result ? analysis.run_id : null}>
    {result && <DependencyCanvas analysis={result} repositoryName={analysis.project?.name ?? "Repository"}
      repositoryUrl={analysis.project?.canonical_repository_url ?? null} commitSha={analysis.commit_sha} />}
  </AnalysisDetail>;
}

export default function AnalysisPage({ params }: { params: Promise<{ id: string }> }) {
  return <Suspense fallback={<p className="p-4 text-xs text-muted" role="status">Loading analysis…</p>}>
    <AnalysisPageContent params={params} />
  </Suspense>;
}
