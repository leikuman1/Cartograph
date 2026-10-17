import { createHash } from "node:crypto";
import { checkDatabase, clerkRequest, createAdminClient, reportFailure, syncOrganization } from "./lib/clients.mjs";

function seedId(value) {
  const bytes = createHash("sha256").update(`cartograph:phase02:${value}`).digest().subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

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
    const projectId = seedId(`${organizationId}:project`);
    const project = {
      id: projectId, organization_id: organizationId,
      name: `Sample project ${index === 0 ? "A" : "B"}`,
      repository_url: index === 0 ? "https://github.com/vercel/next.js" : "https://github.com/microsoft/TypeScript",
      created_at: createdAt,
    };
    const { error: projectError } = await client.from("projects").upsert(project, { onConflict: "id", ignoreDuplicates: true });
    checkDatabase(projectError);

    const statuses = index === 0 ? ["completed", "queued"] : ["failed", "running"];
    const analyses = statuses.map((status, position) => ({
      id: seedId(`${organizationId}:analysis:${position}`),
      organization_id: organizationId, project_id: projectId, status, is_seed: true,
      created_at: createdAt,
      started_at: status === "queued" ? null : createdAt,
      completed_at: status === "completed" || status === "failed" ? createdAt : null,
      error_message: status === "failed" ? "Sample failure for dashboard acceptance; no repository was analyzed." : null,
    }));
    // Stable IDs make reruns safe without replacing real analysis results.
    const { error } = await client.from("analyses").upsert(analyses, { onConflict: "id", ignoreDuplicates: true });
    checkDatabase(error);
  }
  console.log("Seeded two sample analysis tasks per organization. No repository was parsed.");
} catch (error) {
  reportFailure(error);
}
