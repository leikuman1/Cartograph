import { requireOrganization } from "@/lib/auth";

export default async function WorkspacePage() {
  const { orgId, orgSlug } = await requireOrganization();

  return (
    <section className="flex flex-1 flex-col p-4" aria-labelledby="workspace-title">
      <div className="border-b border-border pb-3">
        <h1 id="workspace-title" className="text-sm font-semibold">Workspace</h1>
        <p className="mt-1 text-xs text-muted">
          Organization <span className="font-mono text-foreground">{orgSlug ?? orgId}</span>
        </p>
        {orgSlug && <p className="mt-1 font-mono text-xs text-muted">{orgId}</p>}
      </div>
      <div className="flex flex-1 items-center justify-center py-16 text-muted">
        <p>Your team workspace is ready.</p>
      </div>
    </section>
  );
}
