"use client";

import { createClient } from "@supabase/supabase-js";

// Browser configuration only. The server's getEnvironment() also reads Clerk's
// secret and the service key, so it must never be imported here.
export function createBrowserSupabaseClient(getToken: () => Promise<string | null>) {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
  if (!url || !key) {
    throw new Error("Supabase browser configuration is missing.");
  }
  return createClient(url, key, {
    // Clerk owns the session. The callback asks for a fresh token each time so
    // a long run does not rely on one captured, expiring JWT.
    accessToken: async () => {
      const token = await getToken();
      if (!token) throw new Error("The Clerk session token is unavailable. Sign in again.");
      return token;
    },
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
}
