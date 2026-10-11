import "server-only";

import { auth } from "@clerk/nextjs/server";

export async function requireOrganization() {
  const session = await auth.protect();

  // Organization identity comes from the verified session, never a directory lookup.
  if (!session.orgId) {
    throw new Error(
      "No active organization in the Clerk session. Enable Organizations, Membership required, and Create first organization automatically in Clerk, then sign in again.",
    );
  }

  return { ...session, orgId: session.orgId };
}
