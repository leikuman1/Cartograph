"use server";

import { isClerkAPIResponseError } from "@clerk/nextjs/errors";
import { clerkClient } from "@clerk/nextjs/server";
import { headers } from "next/headers";
import { requireOrganization } from "@/lib/auth";

export type InvitationState = {
  status: "idle" | "success" | "error";
  message: string;
};

export async function inviteMember(
  expectedOrganizationId: string,
  _previousState: InvitationState,
  formData: FormData,
): Promise<InvitationState> {
  const { orgId, orgRole, userId } = await requireOrganization();

  // A stale form in another tab must not send an invitation to a different team.
  if (orgId !== expectedOrganizationId) {
    return { status: "error", message: "Your active team changed. Reload this page before inviting someone." };
  }
  if (orgRole !== "org:admin") {
    return { status: "error", message: "Only team admins can invite members." };
  }

  const value = formData.get("email");
  const emailAddress = typeof value === "string" ? value.trim() : "";
  if (emailAddress.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(emailAddress)) {
    return { status: "error", message: "Enter a valid email address." };
  }

  // Next validates Server Action origins against the host before invoking this action.
  const origin = (await headers()).get("origin");
  if (!origin || !/^https?:\/\//.test(origin)) {
    return { status: "error", message: "The app address is unavailable. Reload the page and try again." };
  }

  try {
    const client = await clerkClient();
    await client.organizations.createOrganizationInvitation({
      organizationId: orgId,
      inviterUserId: userId,
      emailAddress,
      role: "org:member",
      redirectUrl: new URL("/sign-in", origin).toString(),
    });
    return { status: "success", message: `Invitation sent to ${emailAddress}.` };
  } catch (error) {
    const clerkError = isClerkAPIResponseError(error);
    console.error("Organization invitation failed", clerkError
      ? { status: error.status, codes: error.errors.map(({ code }) => code) }
      : error instanceof Error ? error.message : "Unknown error");

    return {
      status: "error",
      message: clerkError && error.status === 429
        ? "Too many invitations. Wait a moment before trying again."
        : "The invitation could not be sent. Check the address and whether this person is already a member, then try again.",
    };
  }
}
