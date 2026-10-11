import "server-only";

import { createClient } from "@supabase/supabase-js";
import { requireOrganization } from "@/lib/auth";
import { getEnvironment } from "@/lib/env";

export async function createSupabaseClient() {
  const session = await requireOrganization();
  const { supabaseUrl, supabasePublishableKey } = getEnvironment();

  if (session.sessionClaims.role !== "authenticated") {
    throw new Error("Enable the Clerk Supabase integration so session tokens carry role: authenticated.");
  }

  return createClient(supabaseUrl, supabasePublishableKey, {
    // Clerk owns the session. Never create or refresh a second Supabase session.
    accessToken: async () => {
      const token = await session.getToken();
      if (!token) {
        throw new Error("The Clerk session token is unavailable. Sign in again.");
      }
      return token;
    },
    auth: {
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false,
    },
  });
}
