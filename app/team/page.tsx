import Link from "next/link";
import { requireOrganization } from "@/lib/auth";
import InviteForm from "./invite-form";

export default async function TeamPage() {
  const { orgId, orgSlug, orgRole } = await requireOrganization();

  return (
    <section className="p-4" aria-labelledby="team-title">
      <Link href="/" className="text-xs text-accent">Back to workspace</Link>
      <h1 id="team-title" className="mt-4 text-sm font-semibold">Team</h1>
      <p className="mt-1 break-all font-mono text-xs text-muted">{orgSlug ?? orgId}</p>
      <div className="mt-4 border-t border-border pt-4">
        <h2 className="text-sm font-medium">Invite a member</h2>
        {orgRole === "org:admin" ? (
          <InviteForm key={orgId} organizationId={orgId} />
        ) : (
          <p className="mt-2 text-xs text-muted">Ask a team admin to send an invitation.</p>
        )}
      </div>
    </section>
  );
}
