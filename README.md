# Cartograph

A local dependency-map app for public TypeScript and JavaScript repositories.
Includes an organization-isolated dashboard, a standalone parser, and dependency maps read from stored analysis results.

## Local setup

The project uses Node.js 22+ and pnpm 10.31.0. With the dependencies installed,
copy `.env.example` to `.env.local` and fill in these five values:

- `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY`: the Clerk publishable key.
- `CLERK_SECRET_KEY`: the matching Clerk secret key (server only).
- `NEXT_PUBLIC_SUPABASE_URL`: the Supabase project URL.
- `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`: the Supabase publishable key, never a service-role or secret key.
- `SUPABASE_SECRET_KEY`: the Supabase secret key for server-side pipeline writes; never expose it through `NEXT_PUBLIC_*`.

All five values are required for workspace and authentication requests. Partial
configuration fails at startup. All-blank configuration permits offline type
generation and compilation, but cannot serve authenticated pages. Authentication
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
for every organization and displays the latest 50 tasks, their live stage, or an
empty state. The browser uses a separate client with a fresh Clerk token callback
for private Realtime subscriptions. Its only configuration is the public URL and
publishable key; graph reads and pipeline writes happen on the server.

Reference: [Supabase's Clerk integration](https://supabase.com/docs/guides/auth/third-party/clerk).

## Database setup

In `.env.local`, also set `DATABASE_URL` (Supabase **Connect > Session pooler**,
with the database password URL-encoded) for migrations and SQL verification.
`SUPABASE_SECRET_KEY` (Supabase **Settings > API Keys**) is used by the server
pipeline and administrative scripts. The browser never receives either value.

```sh
pnpm db:migrate
pnpm db:verify
pnpm db:advisors
```

All schema changes belong in `supabase/migrations/`; create later migration files
with `pnpm exec supabase migration new <name>`. The eight public business tables
have direct organization cascade foreign keys and read-only RLS for authenticated
users. The private schema holds the organization registry and declared progress
channel pattern. References between business tables preserve organization and
analysis identity. New public tables automatically enable RLS; without a policy
they expose no rows. SQL verification uses real database roles and rolls back
fixtures and deletions.

The private organization registry intentionally has
[no read policy](https://supabase.com/docs/guides/database/database-linter?lint=0008_rls_enabled_no_policy).
Authenticated users call narrow
[`SECURITY DEFINER` RPCs](https://supabase.com/docs/guides/database/database-linter?lint=0029_authenticated_security_definer_function_executable)
for organization registration and starting/rerunning an analysis. These require a
user and active organization from the signed token, use a fixed search path, and
are unavailable to anonymous users. Stage, failure, and graph-storage RPCs are
service-role only. Versioned graph-read RPCs run with the caller's existing RLS
policies and return one consistent completed-run snapshot. `read_analysis_result`
preserves the exact five-key phase 7 response; `read_analysis_result_v2` preserves
the phase 8 contract for framework roles, routes and special Next.js entry files.
Phase 9 callers use `read_analysis_result_v3` for CommonJS exports, `require()`
imports and Express roles. Earlier reader contracts stay stable; all keep
`schemaVersion: 1`. The server encodes and decodes PostgreSQL C ordering at the
storage boundary; standalone snapshots retain their original UTF-16 path and
edge ordering, including non-BMP paths.

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

The seed command verifies both IDs in Clerk and adds one labeled sample task
per organization, preserving existing analyses. Samples show `failed` with an
explicit no-stored-graph message. Open one and choose **Rerun analysis** to replace
it with a real run. The command inserts no graph data; unseeded organizations
remain empty.

## Analyze a repository

Run `pnpm dev`, sign in, and paste `https://github.com/owner/repository` on the
dashboard. Cartograph resolves the default branch's commit, fetches its public
archive at that SHA, then runs **Fetch → Select → Parse → Store**. Repository
access permissions and GitHub tokens are not requested. Nothing from the archive
is executed, and temporary files are removed after the run.

The archive is limited to 50 MiB compressed, 200 MiB extracted, and 20,000 entries.
Symbolic links and hard links are never created or followed; their paths and
reasons are counted as skipped files in coverage while regular files continue.
Unsafe paths, conflicting entries, devices and other special archive entries
still fail; unsupported entry errors include the path and type. A nonexistent or
private repository records a failed Fetch stage. An unexpected exception records
its stage and reason; runs with no update for five minutes show **Stale**.

TypeScript configuration and import resolution use filesystem callbacks confined
to the repository root and refuse symlinks. Configuration globs do not enumerate
files; the discovery stage owns file selection. An unavailable or out-of-root
extended configuration fails the Parse stage, and blocked local imports remain
unresolved with a reason. Syntax trees use an in-memory filesystem. Parsing still
runs in the application process without aggregate concurrency or memory limits;
the per-archive limits do not provide process isolation.

Each organization has one analysis per canonical repository URL. Pasting that URL
again opens the existing page. **Rerun analysis** on that page starts a new run
only after the previous one completed, failed, or became stale. Run IDs prevent
late writes from an earlier process replacing the current result.

A trigger on `public.analyses` publishes a stage and message to the declared
private `analysis:<id>:progress` channel. Its RLS policy checks organization
visibility. The dashboard and detail page subscribe with Clerk authentication;
a snapshot after subscription closes any missed-event gap. There is no database
polling. A local clock marks stale rows without reading the database.

The map reads files, resolved edges, imports, coverage, framework roles, and
routes from stored rows in one consistent database snapshot. File coverage and
local import resolution are separate percentages with both counts visible even
when the banner is collapsed.
Skipped files, excluded directories, and unresolved imports keep the map labeled
incomplete. The previous committed parser output and `/preview` route are removed.

## Explore the map

Expand folders into paginated file rows, select a file to highlight its imports
and importers, or inspect the Files table. The detail panel shows direct
connections and two-step traversals; category filtering and graph insights use
the same stored parser output. Escape or a background click clears selection.
Framework detection runs in fixed order: Next.js, NestJS, Express, then React.
Detection and roles stay inside the nearest package boundary. Express requires an
exact `express` dependency, a non-type static import, or an unshadowed literal
`require('express')`; directory names alone do not detect a framework. The sidebar
uses each framework's concrete roles in a fixed reading order; unmatched files
keep Source, Tests, or Declarations. Unmatched repositories render normally with
an empty Routes table. Older analyses need an explicit rerun to populate these
new facts.

The Routes table shows only recoverable HTTP methods and full path patterns.
A route can reveal its file in the map or open the source at the analyzed commit
and line on GitHub. Next.js page conventions and App Router HTTP exports, and
NestJS controller/method decorators with a recoverable bootstrap, supply these
facts. Pages Router API handlers retain their role but produce no route rows,
since a method check in a function cannot prove which methods it serves.
Dynamic configuration, unknown prefixes, and unsupported routing syntax also
produce no routes. React has file roles without an inferred routing system.
Express assigns roles from exact package-relative directory segments:
`route`/`routes`, `controller`/`controllers`, `middleware`/`middlewares`,
`service`/`services`, and `model`/`models`. The deepest matching directory wins;
filenames do not establish roles, and tests and declarations keep their generic
categories. Express categories read Routes, Controllers, Middleware, Services,
Models, then the generic categories. Express routes and special framework entries
are always empty; controllers require explicit imports to leave the unimported
file list. Framework adapters reuse parsed syntax; no repository code is executed.

Phase 9 collects string-literal `require()` calls alongside existing imports,
re-exports and dynamic imports, resolving them through the same module resolver.
Mixed module syntax retains both kinds on one dependency edge. Nonliteral
`require()` calls remain excluded with a reason and count toward import coverage;
locally shadowed `require` calls are ordinary function calls. Stored files also
carry CommonJS export names from direct top-level assignments: literal properties
on `exports` or `module.exports`, object-literal keys, and `default` for a whole
value export. Dynamic keys and spread names are omitted; replacements and the
`exports` alias are tracked in statement order. Existing import-only edge lists
retain their ordering and content.

Apply every migration with `pnpm db:migrate` before starting the phase 9 app. A
later migration adds the v3 reader and CommonJS/Express storage without changing
already applied migrations or the legacy and v2 reader contracts. Run
`pnpm db:verify` to check storage, all reader contracts and RLS. Rolling the app
back preserves the earlier readers' response shapes. Existing analyses need an
explicit rerun to collect CommonJS dependencies, export names and Express roles;
migration does not invent that evidence.

The parser also remains usable without the app:

```sh
pnpm analyze /path/to/repository --output /path/to/analysis.json
```

## Checks

```sh
pnpm typecheck
pnpm lint
pnpm test:parser
pnpm test:pipeline
pnpm test:environment
pnpm build
node --test scripts/organizations.test.mjs
pnpm db:verify
pnpm db:advisors
```

Run the phase 9 browser acceptance check in `docs/specs/phrase-09.md` manually.
The phase 8 framework checks and phase 7 progress checks, including watching
progress from a second tab, remain manual.
The workspace derives its organization from the server session, and switching
teams refreshes that state. Theme choices
are saved in local storage; system mode follows OS changes.
