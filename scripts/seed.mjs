import { checkDatabase, clerkRequest, createAdminClient, reportFailure, syncOrganization } from "./lib/clients.mjs";

try {
  const ids = process.argv.slice(2);
  if (ids.length !== 2 || ids[0] === ids[1] || ids.some(id => !/^org_[a-zA-Z0-9]+$/.test(id))) {
    throw new Error("Usage: pnpm db:seed <first Clerk organization ID> <second Clerk organization ID>");
  }
  // Verify both IDs against Clerk before writing any sample data.
  for (const id of ids) {
    const organization = await clerkRequest(`/organizations/${encodeURIComponent(id)}`);
    if (organization.id !== id) throw new Error("Clerk returned a different organization.");
  }

  const client = createAdminClient();
  const createdAt = new Date().toISOString();
  for (const [index, organizationId] of ids.entries()) {
    await syncOrganization(client, organizationId);
    const repositoryUrl = index === 0 ? "https://github.com/vercel/next.js" : "https://github.com/microsoft/TypeScript";
    const canonicalUrl = repositoryUrl.toLowerCase();
    const project = {
      organization_id: organizationId,
      name: `Sample project ${index === 0 ? "A" : "B"}`,
      repository_url: repositoryUrl,
      canonical_repository_url: canonicalUrl,
      created_at: createdAt,
    };
    // Resolve identity by the unique repository key. Existing projects may
    // have migrated seed IDs or have been created by a real analysis first.
    const { error: projectError } = await client.from("projects").upsert(project, {
      onConflict: "organization_id,canonical_repository_url", ignoreDuplicates: true,
    });
    checkDatabase(projectError);
    const { data: existingProject, error: lookupError } = await client.from("projects")
      .select("id").eq("organization_id", organizationId)
      .eq("canonical_repository_url", canonicalUrl).single();
    checkDatabase(lookupError);

    // One analysis per repository is a database invariant. A sample row is
    // marked failed because it has no stored graph: the dashboard must not show
    // a completed analysis that would open an empty map.
    const analysis = {
      organization_id: organizationId, project_id: existingProject.id, status: "failed", is_seed: true,
      created_at: createdAt,
      started_at: null,
      completed_at: createdAt,
      error_message: "Sample data has no stored graph. Run the analysis from this page.",
      stage: null, stage_message: "", failed_stage: null,
    };
    // The migration kept one old sample ID. Ignore the unique project conflict
    // so both that survivor and any real analysis retain their data unchanged.
    const { error } = await client.from("analyses").upsert(analysis, {
      onConflict: "organization_id,project_id", ignoreDuplicates: true,
    });
    checkDatabase(error);
  }
  console.log("Ensured one analysis per sample repository; existing results were preserved. No repository was parsed.");
} catch (error) {
  reportFailure(error);
}
