"use client";

import { OrganizationSwitcher, Show, SignInButton, UserButton } from "@clerk/nextjs";
import Link from "next/link";

export default function AuthControls() {
  return (
    <div className="flex min-h-8 items-center gap-2">
      <Show when="signed-out">
        <SignInButton mode="redirect">
          <button type="button" className="control">
            Sign in
          </button>
        </SignInButton>
      </Show>
      <Show when="signed-in">
        <OrganizationSwitcher
          hidePersonal
          skipInvitationScreen
          afterSelectOrganizationUrl="/"
          afterCreateOrganizationUrl="/"
          afterLeaveOrganizationUrl="/"
          organizationProfileMode="navigation"
          organizationProfileUrl="/team"
        />
        <Link href="/team" className="control">Team</Link>
        <UserButton />
      </Show>
    </div>
  );
}
