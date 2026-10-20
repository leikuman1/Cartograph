import { getEnvironment } from "./lib/env";

export function register() {
  const credentialNames = [
    "NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY",
    "CLERK_SECRET_KEY",
    "NEXT_PUBLIC_SUPABASE_URL",
    "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY",
    "SUPABASE_SECRET_KEY",
  ];
  // All-blank configuration is reserved for offline type generation; partial
  // setup must fail at startup rather than at the first pipeline write.
  if (credentialNames.some(name => process.env[name]?.trim())) {
    getEnvironment();
  }
}
