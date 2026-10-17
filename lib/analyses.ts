import "server-only";

import { createSupabaseClient } from "@/lib/supabase/server";

const ANALYSIS_LIMIT = 50;

export async function listAnalyses() {
  const supabase = await createSupabaseClient();
  // Clerk's prebuilt creation flow does not call our server. Register only the
  // organization in the verified token; this RPC cannot choose another ID.
  const { error: organizationError } = await supabase.rpc("ensure_organization");
  if (organizationError) {
    throw new Error("The current organization could not be synchronized.", { cause: organizationError });
  }

  // The active organization is enforced by RLS using the Clerk session token.
  const { data, error } = await supabase
    .from("analyses")
    .select("id, status, is_seed, created_at, completed_at, project:projects(name, repository_url)")
    .order("created_at", { ascending: false })
    .order("id", { ascending: false })
    .limit(ANALYSIS_LIMIT + 1);

  if (error) {
    throw new Error("Analyses could not be loaded from the database.", { cause: error });
  }

  return {
    analyses: data.slice(0, ANALYSIS_LIMIT),
    hasMore: data.length > ANALYSIS_LIMIT,
  };
}
