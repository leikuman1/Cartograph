# Engineering Lessons

Mistakes that reached review and the rule each one produced. Add an entry when a
fix corrects a mistake, not when a feature ships.

## 1. A deletion command writes nothing until it is confirmed

### Problem
`pnpm db:sync-organizations` deleted an organization's registry row, and through
cascading foreign keys all of its business data, as soon as Clerk answered 404
for its ID.

### Root Cause
A 404 was treated as proof the organization was gone. A `CLERK_SECRET_KEY` from
a different Clerk instance returns 404 for every stored ID, which looks the same.

### Rule
A command that deletes data prints the exact rows it will delete, states what
cascades, and makes no write until given an explicit flag. Confirmation
re-verifies each row; it never replays a saved list.

### Verification
`scripts/organizations.test.mjs` asserts no writes before confirmation, the
wrong-instance case, and that an API failure still stops a confirmed run.

## 2. An empty input list is not a broken configuration

### Problem
A repository with a valid `tsconfig.json` failed to parse when `include` matched
nothing, when `files` was empty, or when JavaScript files existed without
`allowJs`. TypeScript reported TS18002 or TS18003 and the parser discarded the
whole configuration.

### Root Cause
Every configuration diagnostic was treated as fatal. Discovery selects the
source files, so an empty input list says nothing about whether the compiler
options are usable.

### Rule
Separate "this configuration has nothing to compile" from "this configuration is
wrong". Ignore only the diagnostics you can name; every other error still fails.

### Verification
`lib/parser/parser.test.ts` covers each empty-input shape and asserts that an
invalid compiler option (TS6046) still throws.

## 3. A documented command is run as documented, by a check

### Problem
The README showed `pnpm analyze <directory>` while the CLI's own usage message
showed `pnpm analyze -- <directory>`. `pnpm` can forward the `--` into the
script's arguments, and the parser rejected it as an unknown option.

### Root Cause
The argument parser was only exercised through `analyzeRepository`, never
through the command with the arguments a person would type. Two documents
drifted because nothing executed either form.

### Rule
Every documented invocation is run end to end by an automated check, including
the usage message and the failure paths. A command line that appears in two
places is tested from one.

### Verification
`lib/parser/parser.test.ts` spawns the CLI with and without the separator, and
with an unknown option and no argument.

## 4. Partial configuration fails at startup, not at first use

### Problem
During the former offline-preview phase, partial credential configuration let
the app start normally, then fail when a workspace or authentication route was
opened.

### Root Cause
Validation ran only at the request boundary. The earlier offline preview allowed
all-blank credentials, which obscured accidental partial configuration.

### Rule
If any credential is nonblank, validate all five required values during startup.
The offline preview has been removed. All-blank configuration is permitted only
for offline type generation and compilation; application requests still require
all five values.

### Verification
`scripts/environment.test.ts` walks every partial combination, plus all-blank,
complete, and invalid values.

## 5. Keyboard focus owns state the pointer does not

### Problem
Moving the mouse off a folder or file cleared its highlight while that control
still held keyboard focus. Selecting a file in the files table unmounted the
table and dropped focus to the page.

### Root Cause
Hover was implemented as a pointer-only concept even though focus set the same
state. Nothing moved focus to the row the interaction revealed.

### Rule
Any state a control can enter from the keyboard survives the pointer leaving.
When an interaction removes the focused element, move focus to the element the
interaction revealed. If a child renderer commits that element later, observe
its insertion rather than assuming the parent's effect runs after it exists.

### Verification
Manual: tab to a folder, move the mouse away, and confirm the highlight stays;
press Enter in the files and routes tables, including a collapsed folder, and
confirm focus lands on the revealed row.

## 6. A framework convention matches a location, not a filename

### Problem
`page.tsx`, `route.ts`, `layout.ts` and `error.ts` were treated as framework
entry points anywhere in the tree, so `src/utils/error.ts` and `lib/layout.ts`
were hidden from the list of unimported files.

### Root Cause
A routing convention was matched on the basename alone. Next.js only treats
those names as routes inside `app/` or `pages/`.

### Rule
Resolve framework conventions relative to the detected package and its active
routing root. Pass exact entry-file paths to consumers; a suffix match loses the
package boundary and misclassifies ordinary modules inside monorepos.

### Verification
Framework adapter tests cover real special files, nested package scopes, shadowed
routing roots, and ordinary modules with the same basename. Serialization and SQL
checks preserve those exact entry paths through stored snapshots.

## 7. A trust boundary is enforced at the sink, not at the door

### Problem
The parser confined discovery to the repository root, but configuration loading
and module resolution still ran through `ts.sys`, which reads any path it is
given and follows symlinks. A `tsconfig.json` with `extends: "../external/base.json"`
or an import through a symlinked directory read outside the repository.

### Root Cause
The root was checked when files were listed, not when they were read. TypeScript
probes paths the parser never chose.

### Rule
Every filesystem callback TypeScript can reach checks the path segment by
segment, refuses symlinks, and reports why. A lexical prefix check is not enough;
resolve and inspect each segment.

### Verification
`lib/parser/parser.test.ts` replaces `ts.sys.readFile` and asserts no outside or
symlinked path ever reaches it, for configuration, aliases, and imports.

## 8. Delete and look up by the index's leading columns

### Problem
`store_analysis` deleted files and edges by `analysis_id` alone and resolved
edge endpoints the same way, so every statement scanned tables whose indexes
lead with `organization_id`. A local variable also shared a column's name.

### Root Cause
The function was written from the table's logical key rather than the indexes it
would run against. In plpgsql an unqualified name resolves to the variable first,
so a shared name changes what a statement means without an error.

### Rule
Scope every delete and lookup by the leading columns of an index, and prefix
plpgsql locals so they can never be mistaken for columns.

### Verification
`supabase/tests/phase07.sql` stores a graph in a neighbouring organization with
an overlapping path and asserts every one of its rows survives.

## 9. A rejected form submission keeps what the user typed

### Problem
When the analysis action rejected a repository URL, the input came back empty.

### Root Cause
The field was uncontrolled. React 19 resets a form after its action completes,
so an error response wiped the value the user needed to correct.

### Rule
A field the server can reject is controlled, so the text survives the round
trip. Errors are returned next to the input that caused them.

### Verification
Manual: submit an invalid URL and confirm the field still holds it.

## 10. Failure reasons cannot depend on resolver callback side effects

### Problem
Two files importing the same blocked path received different unresolved reasons.
An ordinary missing alias could also be reported as outside the repository.

### Root Cause
TypeScript caches failed resolutions and skips filesystem callbacks on a cache
hit. On a cache miss, unrelated ancestor package searches can set the same
blocked flags as a real local target. Those flags describe probes, not the
cause of the import failure.

### Rule
Keep resolution and failure diagnosis separate. Diagnose a failed local import
from its selected candidates with fresh evidence, respecting TypeScript's paths
precedence, configuration origin, and extension probing. Do not infer the cause
from flags accumulated by a general package search.

### Verification
`lib/parser/parser.test.ts` checks repeated failures across files, missing aliases,
baseUrl, inherited paths, rootDirs, and symlinked extension and index candidates.

## 11. Skipping archive links must preserve the evidence

### Problem
A public repository stopped at Fetch because its archive contained a link. The
extractor rejected all links before the parser could report skipped paths.

### Root Cause
Not creating links was implemented as rejecting the entire repository. Simply
ignoring the entries would hide them from discovery and turn linked imports
into ordinary missing files.

### Rule
Never create or follow archive links. Carry their paths and reasons through
selection, coverage, and the parser's filesystem boundary. Reserve skipped paths
against duplicate or conflicting members, and keep body and entry limits in
force. Unsupported special-file errors identify the member and its type.

### Verification
Pipeline tests cover skipped links through extraction, discovery, coverage and
cross-file import resolution, plus conflicting members and malformed bodies.

## 12. An expanded read contract needs an explicit opt-in

### Problem

The framework migration added keys to an existing graph-read RPC. The previous
application's strict validator rejected them, so a database-first upgrade broke
old instances and application-only rollbacks.

### Root Cause

Tests proved that the new reader accepted old data, but never checked that the
old reader still received its original response shape.

### Rule

Keep an existing RPC's response contract stable. Expose additional facts through
an explicitly selected reader and preserve both callers' row policies and snapshot
semantics. Repair an applied migration with a later migration.

### Verification

SQL checks assert the legacy reader's exact five keys, equality with the new
reader's graph projection, and the same run and organization visibility for both.

## 13. Runtime facts follow execution, not declaration names

### Problem
Ambient CommonJS declarations and type-only imports hid real requires and exports.
Export assignments inside top-level variable initializers or ordinary assignment
chains were missed.

### Root Cause
Every declaration was treated as a runtime binding, and export tracking stopped
at a statement or assignment target that was not itself a CommonJS export.

### Rule
Skip ambient declaration and type-only import subtrees when collecting runtime
bindings. Follow direct assignment chains in top-level expressions and variable
initializers in order; keep conditional and nested execution outside the export
contract.

### Verification
`lib/parser/parser.test.ts` covers ambient declarations and `declare global`,
type-only import forms, real local shadowing, chained initializers and assignments,
replacement and alias identity, and excluded conditional and nested writes.

## 14. Database collation is a transport contract

### Problem
A stored graph with both non-BMP and high BMP paths failed to load because SQL C
order differs from JavaScript UTF-16 order. Next special entries could also fail
writer validation for the same reason.

### Root Cause
Reconstructed SQL rows were validated as canonical parser arrays without decoding
their transport order. The writer's special-entry order was not reflected at the
application boundary.

### Rule
Validate database ordering before converting it to the existing parser order.
Encode special entries in the writer's order and decode them on read. Keep the
standalone graph contract unchanged, including serialized edge order, and retain
all duplicate, coverage, endpoint and fan-count checks.

### Verification
`lib/parser/serialization.test.ts` exercises Unicode paths, edge targets and route
patterns, validates special-entry storage round trips, and rejects malformed
transport order and graph data. The original standalone edge bytes stay intact.

## 15. Model wording must respect the renderer's path contract

### Problem
The controllers folder explanation failed twice even though its repository file
references were valid. Ordinary shorthand such as `author/genre` and `GET/POST`
matched the renderer's unknown-path check.

### Root Cause
The prompt restricted invented file paths but still allowed slash-separated prose.
The renderer cannot reliably distinguish that prose from an unprovided path.

### Rule
When output syntax has a strict validator, describe that syntax in the prompt too.
Reserve slashes for exact supplied file paths and spell prose alternatives with
"and" or "or". Version the prompt change in the cache identity; keep the unknown-path
check intact. When checking surrounding prose, preserve exact references and allow
at most one sentence-ending period; never strip trailing hyphens or multiple dots.

### Verification
BrowserOS Neo generated the full controllers folder explanation after the prompt
change. A repeat click hit the persistent cache; its LangSmith trace had no model
call. AI tests reject unprovided paths and cover punctuation, literal trailing-dot
names and unknown paths ending with hyphens or repeated dots. Types, lint and build
pass.

## 16. Optional batch failure preserves completed work

### Problem
A later AI classification batch could fail after earlier batches had succeeded.
The outer recovery boundary returned an empty list, so those valid roles were
cached but never attached to the saved analysis.

### Root Cause
Recovery surrounded the entire classification operation instead of the batch
that could fail. Both automatic and explicit assignment lost the accumulated
results.

### Rule
Catch a known optional failure where partial results are still available. Stop
later batches and return validated completed results; keep source, cache and
database failures fatal.

### Verification
AI tests exercise the classification operation with a cached first batch and a
failing provider or invalid second response, asserting the first roles survive
and no third batch starts. They also check first-batch failure, missing source,
cache reads and writes, and malformed cached roles.
