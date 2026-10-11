# Cartograph

A local dependency-map app for public TypeScript and JavaScript repositories.
Phase 1 implements authentication, teams, themes, and the application shell.

## Local setup

The project uses Node.js 22+ and pnpm 10.31.0. With the dependencies installed,
copy `.env.example` to `.env.local` and fill in these four values:

- `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY`: the Clerk publishable key.
- `CLERK_SECRET_KEY`: the matching Clerk secret key (server only).
- `NEXT_PUBLIC_SUPABASE_URL`: the Supabase project URL.
- `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`: the Supabase publishable key, never a service-role or secret key.

Missing or blank configuration fails during startup and build. Authentication
paths are `/sign-in` and `/sign-up`; every enabled method finishes at `/`.

```sh
pnpm dev
```

## Clerk configuration

In Clerk Dashboard, under **Organizations > Settings**:

1. Enable Organizations with **Membership required** (Personal Accounts disabled).
2. Enable **Create first organization automatically**. Clerk handles creation and
   activation as part of sign-in, including the organization invitation flow.
3. Keep the default creator/member roles, `org:admin` and `org:member`.

Automatic first-organization creation is a Clerk setting, not a custom webhook
or a second onboarding flow. Without it, new users will be asked to create an
organization by Clerk. Enable these settings before running the acceptance check.
The application rejects sessions without an active organization.

Enable the desired sign-in methods under **User & authentication**. Keep email
addresses enabled for organization invitations; email/password sign-in itself
is optional. Register the application's `/sign-in` and `/sign-up` URLs in
Clerk's application paths. No provider-specific authentication code is needed.

Use **Team > Send invitation** in the app. Invitations are created on the server
with the default member role and this app's `/sign-in` URL. The prebuilt Clerk
sign-in/sign-up components consume the invitation ticket. No invitations are
sent until an admin submits the form. The organization switcher's Manage link
also opens this page, and its create-organization flow skips the default invite
screen so all app invitations use the same return address.

Reference: [Organization settings](https://clerk.com/docs/guides/organizations/configure)
and [Organization invitations](https://clerk.com/docs/guides/organizations/add-members/invitations).

## Supabase configuration

Activate the **Supabase integration** in Clerk, then add **Clerk** under
**Authentication > Sign In / Providers > Third-party Auth** in Supabase using
the Clerk domain provided by the integration.

The integration adds `role: "authenticated"` to Clerk session tokens. Clerk
also carries the active organization in its default session claims: `o.id` in
v2 tokens (`org_id` in older tokens). Future RLS policies must read that claim.
No custom JWT template, shared signing secret, Supabase Auth session, or table
is needed in this phase.

`createSupabaseClient()` is server-only and request-scoped. It requires a signed-in
organization, checks the authenticated role, and forwards the Clerk token through
Supabase's `accessToken` callback on each request. Missing tokens fail instead of
falling back to anonymous access. Nothing queries the database in Phase 1.

Reference: [Supabase's Clerk integration](https://supabase.com/docs/guides/auth/third-party/clerk).

## Checks

```sh
pnpm typecheck
pnpm lint
pnpm build
```

Run the browser acceptance check in `docs/specs/phase-01.md` manually. The
workspace shows the organization ID (or its slug) from the server-rendered
session, and switching teams refreshes that server state. Theme choices are
saved in local storage and applied to the root `data-theme` attribute before
paint. System mode follows OS changes; explicit light and dark override them.
