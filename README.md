# Cartograph

A local dependency-map app for public TypeScript and JavaScript repositories.
Phase 2 adds the organization-isolated analysis dashboard and versioned database schema.

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
v2 tokens (`org_id` in older tokens). RLS policies read that claim directly.
No custom JWT template or separate Supabase Auth session is needed.

`createSupabaseClient()` is server-only and request-scoped. It requires a signed-in
organization, checks the authenticated role, and forwards the Clerk token through
Supabase's `accessToken` callback on each request. Missing tokens fail instead of
falling back to anonymous access. The dashboard uses the same unfiltered query
for every organization and displays the latest 50 tasks, their status, or an
empty state. Sample tasks are explicitly labeled; no repository is parsed yet.

Reference: [Supabase's Clerk integration](https://supabase.com/docs/guides/auth/third-party/clerk).

## Database setup

In `.env.local`, also set `SUPABASE_SECRET_KEY` (Supabase **Settings > API Keys**)
for administrative scripts and `DATABASE_URL` (Supabase **Connect > Session pooler**,
with the database password URL-encoded) for migrations and SQL verification.
Neither is used by the dashboard. The four application variables remain required
at startup; each administrative command validates its own additional variables.

```sh
pnpm db:migrate
pnpm db:verify
pnpm db:advisors
```

All schema changes belong in `supabase/migrations/`; create later migration files
with `pnpm exec supabase migration new <name>`. There are nine tables: the private
`organizations` registry (`id`, `created_at`) and eight public business tables.
All eight have direct organization cascade foreign keys and read-only RLS for
authenticated users. References between business tables also preserve the
organization and analysis identity. New public tables automatically enable RLS;
without a policy they expose no rows. The SQL verification script uses real
database roles and rolls back every fixture and deletion.

Two advisor notices reflect the intended access model: the private registry has
[no read policy](https://supabase.com/docs/guides/database/database-linter?lint=0008_rls_enabled_no_policy),
and signed-in users can call the narrowly scoped
[`SECURITY DEFINER` registration function](https://supabase.com/docs/guides/database/database-linter?lint=0029_authenticated_security_definer_function_executable).
It requires a user and organization in the signed token, accepts no ID argument,
and has a fixed search path. Anonymous users cannot call it; administrative
synchronization functions are executable only by `service_role`.

## Organization synchronization without webhooks

Opening the dashboard calls `ensure_organization()` using the Clerk session token.
The database registers only the organization from that token, idempotently;
the caller cannot supply another organization ID. Memberships and roles stay in
Clerk, and switching organizations never transfers existing business data.

After creating or deleting organizations in Clerk, run:

```sh
pnpm db:sync-organizations
```

This command reads all Clerk organizations, backfills the registry, and checks
each potentially deleted organization individually. Only a Clerk 404 permits
deleting its registry row and cascading its business data. API failures stop the
command; rerunning it is safe. Deletions in Clerk are reflected after this command
runs, not immediately. No webhook endpoint, signing secret, deployment, or public
tunnel is required. This is an explicit local command, not background polling.

For Phase 2 acceptance, create two organizations in Clerk, then pass their real
IDs (shown below the dashboard title) to:

```sh
pnpm db:seed org_FIRST org_SECOND
```

The seed command verifies both IDs in Clerk and adds two labeled sample tasks
per organization, covering all four statuses. Reruns do not duplicate or overwrite
tasks. It inserts no files, edges, routes, explanations, roles, or insights.
An organization without seeded tasks remains empty.

## Checks

```sh
pnpm typecheck
pnpm lint
pnpm build
node --test scripts/organizations.test.mjs
```

Run the browser acceptance check in `docs/specs/phrase-02.md` manually. The
workspace shows the organization ID (or its slug) from the server-rendered
session, and switching teams refreshes that server state. Theme choices are
saved in local storage and applied to the root `data-theme` attribute before
paint. System mode follows OS changes; explicit light and dark override them.
