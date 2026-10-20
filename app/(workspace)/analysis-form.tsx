"use client";

import { useActionState, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { startAnalysis, type AnalysisActionState } from "./actions";

const initialState: AnalysisActionState = { error: null, analysisId: null };

export default function AnalysisForm({ organizationId }: { organizationId: string }) {
  const router = useRouter();
  const [repositoryUrl, setRepositoryUrl] = useState("");
  const [state, action, pending] = useActionState(
    startAnalysis.bind(null, organizationId),
    initialState,
  );

  useEffect(() => {
    if (state.analysisId) router.push(`/analyses/${state.analysisId}`);
  }, [state.analysisId, router]);

  return <form action={action} className="mt-3 max-w-2xl">
    <label htmlFor="repository-url" className="mb-1 block text-xs font-medium">
      Public GitHub repository
    </label>
    <div className="flex flex-wrap gap-2">
      <input
        id="repository-url"
        name="repositoryUrl"
        value={repositoryUrl}
        onChange={event => setRepositoryUrl(event.target.value)}
        type="url"
        inputMode="url"
        autoComplete="off"
        spellCheck={false}
        required
        disabled={pending}
        placeholder="https://github.com/owner/repository"
        aria-describedby="repository-url-help repository-url-result"
        className="control min-w-0 flex-1 font-mono"
      />
      <button type="submit" className="control text-accent" disabled={pending}>
        {pending ? "Starting…" : "Analyze repository"}
      </button>
    </div>
    <p id="repository-url-help" className="mt-1 text-xs text-muted">
      Fetched as a public archive. No repository access or token is requested.
    </p>
    <p id="repository-url-result" role={state.error ? "alert" : "status"} className="mt-1 text-xs text-muted">
      {state.error ?? ""}
    </p>
  </form>;
}
