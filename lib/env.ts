export function getEnvironment() {
  const required = (name: string) => {
    const value = process.env[name]?.trim();
    if (!value) {
      throw new Error(`Missing environment variable ${name}. Set it in .env.local before starting Cartograph.`);
    }
    return value;
  };

  const clerkPublishableKey = required("NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY");
  const clerkSecretKey = required("CLERK_SECRET_KEY");
  const supabaseUrl = required("NEXT_PUBLIC_SUPABASE_URL");
  const supabasePublishableKey = required("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY");
  // The pipeline writes through service-role RPCs. This module is imported by
  // server code only; the secret is never sent to the browser.
  const supabaseSecretKey = required("SUPABASE_SECRET_KEY");

  if (!/^pk_(test|live)_/.test(clerkPublishableKey)) {
    throw new Error("NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY must be a Clerk publishable key.");
  }
  if (!/^sk_(test|live)_/.test(clerkSecretKey)) {
    throw new Error("CLERK_SECRET_KEY must be a Clerk secret key.");
  }

  let url: URL;
  try {
    url = new URL(supabaseUrl);
  } catch {
    throw new Error("NEXT_PUBLIC_SUPABASE_URL must be an absolute HTTP(S) URL.");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error("NEXT_PUBLIC_SUPABASE_URL must be an absolute HTTP(S) URL.");
  }

  return {
    clerkPublishableKey, clerkSecretKey, supabaseUrl, supabasePublishableKey, supabaseSecretKey,
  };
}
