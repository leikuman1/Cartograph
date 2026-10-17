"use client";

import { useActionState } from "react";
import { inviteMember, type InvitationState } from "./actions";

const initialState: InvitationState = { status: "idle", message: "" };

export default function InviteForm({ organizationId }: { organizationId: string }) {
  const [state, action, pending] = useActionState(
    inviteMember.bind(null, organizationId),
    initialState,
  );

  return (
    <form action={action} className="mt-4 max-w-md">
      <label htmlFor="invite-email" className="mb-2 block text-xs font-medium">Email address</label>
      <div className="flex flex-wrap gap-2">
        <input
          id="invite-email"
          name="email"
          type="email"
          autoComplete="email"
          maxLength={254}
          required
          disabled={pending}
          aria-describedby="invitation-result"
          className="control min-w-0 flex-1"
        />
        <button type="submit" className="control text-accent" disabled={pending}>
          {pending ? "Sending…" : "Send invitation"}
        </button>
      </div>
      <p id="invitation-result" role={state.status === "error" ? "alert" : "status"} className="mt-3 text-xs text-muted">
        {state.message}
      </p>
    </form>
  );
}
