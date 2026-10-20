"use client";

import { useActionState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { rerunAnalysis, type AnalysisActionState } from "./actions";

const initialState: AnalysisActionState = { error: null, analysisId: null };

export default function RerunButton({ organizationId, analysisId }: { organizationId: string; analysisId: string }) {
  const router = useRouter();
  const [state, action, pending] = useActionState(
    rerunAnalysis.bind(null, organizationId, analysisId),
    initialState,
  );

  useEffect(() => {
    if (!state.error && state.analysisId) router.refresh();
  }, [state, router]);

  return <form action={action}>
    <button type="submit" className="control" disabled={pending}>
      {pending ? "Starting…" : "Rerun analysis"}
    </button>
    {state.error && <p role="alert" className="mt-2 text-xs text-muted">{state.error}</p>}
  </form>;
}
