import { createClient } from "@supabase/supabase-js";

export function required(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Set ${name} in .env.local before running this command.`);
  return value;
}

export function createAdminClient() {
  return createClient(required("NEXT_PUBLIC_SUPABASE_URL"), required("SUPABASE_SECRET_KEY"), {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    global: {
      fetch: (input, init) => fetch(input, { ...init, signal: AbortSignal.timeout(15000) }),
    },
  });
}

export async function clerkRequest(path, allowMissing = false) {
  const response = await fetch(`https://api.clerk.com/v1${path}`, {
    headers: { Authorization: `Bearer ${required("CLERK_SECRET_KEY")}` },
    signal: AbortSignal.timeout(15000),
  });
  if (allowMissing && response.status === 404) return null;
  if (!response.ok) throw new Error(`Clerk request failed (HTTP ${response.status}); no deletion follows this error.`);
  return response.json();
}

export function checkDatabase(error) {
  if (error) throw new Error(`Supabase operation failed (${error.code || "network error"}): ${error.message}`);
}

export async function syncOrganization(client, id, deleted = false) {
  const { error } = await client.rpc("sync_organization", {
    p_organization_id: id, p_deleted: deleted,
  });
  checkDatabase(error);
}

export function reportFailure(error) {
  // Avoid logging request objects or headers containing privileged credentials.
  let message = error instanceof Error ? error.message : "Command failed.";
  for (const name of ["CLERK_SECRET_KEY", "SUPABASE_SECRET_KEY", "DATABASE_URL"]) {
    if (process.env[name]) message = message.replaceAll(process.env[name], "[redacted]");
  }
  console.error(message);
  process.exitCode = 1;
}
