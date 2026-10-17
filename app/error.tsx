"use client";

export default function ErrorPage({ reset }: { reset: () => void }) {
  return (
    <section className="p-4" aria-labelledby="error-title">
      <h1 id="error-title" className="text-sm font-semibold">Workspace could not load</h1>
      <p className="my-3 text-muted">Try again. If this continues, ask the app administrator to check the server logs.</p>
      <button type="button" className="control" onClick={reset}>Try again</button>
    </section>
  );
}
