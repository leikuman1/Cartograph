# Cartograph

A local dependency-map app for public TypeScript and JavaScript repositories.
Includes an organization-isolated analysis dashboard, standalone parser, and offline canvas preview.

## Local setup

The project uses Node.js 22+ and pnpm 10.31.0. With the dependencies installed,
copy `.env.example` to `.env.local` and fill in these four values:

- `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY`: the Clerk publishable key.
- `CLERK_SECRET_KEY`: the matching Clerk secret key (server only).
- `NEXT_PUBLIC_SUPABASE_URL`: the Supabase project URL.
- `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`: the Supabase publishable key, never a service-role or secret key.

Missing or blank configuration fails when opening workspace or authentication
routes. `/preview` and production builds need no credentials. Authentication
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
for workspace requests; each administrative command validates its own additional variables.

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

This command reads all Clerk organizations and checks each potentially deleted
organization individually. If every stored organization still exists, it backfills
the registry normally. If any ID returns 404, it lists the pending deletion IDs and
count, then stops before any database writes. A 404 can also mean that
`CLERK_SECRET_KEY` points to a different Clerk instance, so verify the key's
instance and the entire deletion list before confirming:

```sh
pnpm db:sync-organizations --confirm-delete
```

Confirmation is required even for one organization: deleting its registry row
cascades to all its business data. The confirmed command checks Clerk again and
only deletes IDs that individually return 404; it is not a saved deletion plan.
API failures stop the command, including when confirmation is supplied. Deletions
in Clerk are reflected after a confirmed run, not immediately. No webhook endpoint,
signing secret, deployment, or public tunnel is required. This is an explicit
local command, not background polling.

For Phase 2 acceptance, create two organizations in Clerk, then pass their real
IDs (shown below the dashboard title) to:

```sh
pnpm db:seed org_FIRST org_SECOND
```

The seed command verifies both IDs in Clerk and adds two labeled sample tasks
per organization, covering all four statuses. Reruns do not duplicate or overwrite
tasks. It inserts no files, edges, routes, explanations, roles, or insights.
An organization without seeded tasks remains empty.

## Canvas preview (phase 4)

Run `pnpm dev` and open `/preview`. This route renders a local, typed parser
result without Clerk, Supabase, API keys, font services, or runtime network
requests. The authenticated workspace keeps its original URLs. A fixed
three-column shell contains the category legend, map, and empty details column.

The sample is the full Hono v4.10.2 repository at commit
`0c6455dc10db6428257bdd601eca559247e27de6` (MIT; license beside the fixture).
The parser produced 384 files and 894 edges, with 91 skipped files, 4 unresolved
imports, and 2 excluded imports. Categories are derived from declaration/test
filename conventions; all other files remain Source. No parser fields changed.

Click a folder to expand it into file rows; click its header to collapse it.
Panels show nine rows at a time and count the remaining files. Their pagination
lets every file be selected. Imports for rows on other pages attach to the
explicit remaining-files footer. Select a file to retain its direct neighbours
and connecting edges; click the background or press Escape to clear selection.
File rows explicitly show `in` (files importing this file) and `out` (files this
file imports). Internal edges use separate outside lanes and turn into the target
row from the right. Cross-folder paths avoid card rectangles. A number on a
highlighted aggregate edge counts its original imports into a collapsed folder.
Expansion fits the new card and route bounds with zoom capped at the preceding zoom.
The Files tab provides a searchable-by-browser table of the same real data.

Generate the identical fixture from an unchanged checkout and run terminal checks:

```sh
git clone --depth 1 --branch v4.10.2 https://github.com/honojs/hono.git ../hono-canvas
pnpm fixture:canvas ../hono-canvas
pnpm check:canvas
pnpm check:preview-offline
```

`check:canvas` reports the folding threshold, node/file ratio, single-file nodes,
and missing edge endpoints. It also checks deterministic layout, every panel
page and row handle, unique labels, and viewport bounds without using a browser.
`check:preview-offline` builds and requests `/preview` with all four application
credentials explicitly blank. The browser checks in `docs/specs/phrase-04.md`
remain manual.

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
