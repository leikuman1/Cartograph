import "server-only";

import { createClient } from "@supabase/supabase-js";
import { getEnvironment } from "../env";
import type { Database } from "../supabase/database.types";
import { createSupabaseClient } from "../supabase/server";
import type { AiCache } from "./cache";

export function createAiWriter() {
  const { supabaseUrl, supabaseSecretKey } = getEnvironment();
  return createClient<Database>(supabaseUrl, supabaseSecretKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
}

export async function requestCache(organizationId: string, model: string): Promise<AiCache> {
  const reader = await createSupabaseClient();
  const writer = createAiWriter();
  return {
    async read(key) {
      // RLS decides visibility; the key chooses the artifact, never the team.
      const { data, error } = await reader.from("ai_cache").select("result").eq("cache_key", key).maybeSingle();
      if (error) throw new Error("The AI cache could not be read. Apply the phase 10 migration.", { cause: error });
      return data?.result ?? null;
    },
    async write(key, operation, result) {
      const { error } = await writer.rpc("write_ai_cache", {
        p_organization_id: organizationId, p_cache_key: key, p_model: model, p_operation: operation, p_result: result,
      });
      if (error) throw new Error("The AI cache could not be stored.", { cause: error });
    },
  };
}

// Background analysis has no user request. The caller derives this organization
// from its already claimed run; service access is confined to that cache key.
export function pipelineCache(organizationId: string, model: string): AiCache {
  const client = createAiWriter();
  return {
    async read(key) {
      const { data, error } = await client.from("ai_cache").select("result")
        .eq("organization_id", organizationId).eq("cache_key", key).maybeSingle();
      if (error) throw new Error("The classification cache could not be read.", { cause: error });
      return data?.result ?? null;
    },
    async write(key, operation, result) {
      const { error } = await client.rpc("write_ai_cache", {
        p_organization_id: organizationId, p_cache_key: key, p_model: model, p_operation: operation, p_result: result,
      });
      if (error) throw new Error("The classification cache could not be stored.", { cause: error });
    },
  };
}
