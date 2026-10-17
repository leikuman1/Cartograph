import { pathToFileURL } from "node:url";
import { checkDatabase, clerkRequest, createAdminClient, reportFailure, syncOrganization } from "./lib/clients.mjs";

export async function synchronizeOrganizations(client, request = clerkRequest, { confirmDelete = false } = {}) {
  const currentIds = new Set();
  let expectedTotal;
  // Pagination of one snapshot, not background polling.
  for (let offset = 0; ; offset += 100) {
    const page = await request(`/organizations?limit=100&offset=${offset}&order_by=created_at`);
    if (!Array.isArray(page.data) || !Number.isInteger(page.total_count) || page.total_count < 0) {
      throw new Error("Clerk returned an invalid organization list.");
    }
    expectedTotal ??= page.total_count;
    if (expectedTotal !== page.total_count) throw new Error("Clerk organizations changed during synchronization. Run the command again.");
    for (const organization of page.data) {
      if (typeof organization.id !== "string" || !/^org_[a-zA-Z0-9]+$/.test(organization.id)) {
        throw new Error("Clerk returned an invalid organization ID.");
      }
      currentIds.add(organization.id);
    }
    if (offset + page.data.length >= expectedTotal || page.data.length === 0) break;
  }
  if (currentIds.size !== expectedTotal) throw new Error("Clerk organization pagination was incomplete. Run the command again.");

  const storedIds = new Set();
  for (let after = ""; ; ) {
    const { data, error } = await client.rpc("list_organization_ids", { p_after_id: after });
    checkDatabase(error);
    if (!Array.isArray(data)) throw new Error("Supabase returned an invalid organization list.");
    for (const row of data) {
      if (typeof row.id !== "string" || !row.id || storedIds.has(row.id)) throw new Error("Supabase organization pagination did not advance.");
      storedIds.add(row.id);
      after = row.id;
    }
    if (data.length < 100) break;
  }

  // Confirm each deletion individually. An absent page entry, timeout, 401, or
  // rate limit is never evidence that an organization has been deleted.
  const deletedIds = [];
  for (const id of storedIds) {
    if (!currentIds.has(id)) {
      const organization = await request(`/organizations/${encodeURIComponent(id)}`, true);
      if (organization === null) deletedIds.push(id);
      else if (organization.id !== id) throw new Error("Clerk returned a different organization.");
    }
  }

  // A valid key for a different Clerk instance also returns 404 for these IDs.
  // Require confirmation before any writes, even when only one organization is missing.
  if (deletedIds.length > 0 && confirmDelete !== true) {
    throw new Error([
      `Deletion requires confirmation for ${deletedIds.length} organization(s):`,
      ...deletedIds.map(id => `  ${id}`),
      "Deleting an organization also deletes all its business data through cascading foreign keys.",
      "Check that CLERK_SECRET_KEY belongs to the intended Clerk instance and verify these IDs.",
      "Then rerun pnpm db:sync-organizations --confirm-delete to confirm deletion.",
      "No database writes were made.",
    ].join("\n"));
  }

  for (const id of currentIds) await syncOrganization(client, id);
  for (const id of deletedIds) await syncOrganization(client, id, true);
  return { synchronized: currentIds.size, deleted: deletedIds.length };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const args = process.argv.slice(2);
    if (args.some(arg => arg !== "--confirm-delete")) {
      throw new Error("Usage: pnpm db:sync-organizations [--confirm-delete]");
    }
    const result = await synchronizeOrganizations(createAdminClient(), clerkRequest, {
      confirmDelete: args.includes("--confirm-delete"),
    });
    console.log(`Organizations synchronized: ${result.synchronized}; deleted: ${result.deleted}.`);
  } catch (error) {
    reportFailure(error);
  }
}
