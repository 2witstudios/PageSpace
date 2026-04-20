# One-Fetch Groundwork — Review Follow-Up Fixes

Follow-ups to the code review on branch `pu/one-fetch-groundwork`. All three are
hardening/correctness fixes against purely-additive code (no route consumes the
new fetchers yet), so blast radius is limited to anyone who runs the migration
or calls `loadPagePayload` / `loadAppShell`.

## Fix 1 — Pin `search_path` on the `SECURITY DEFINER` function

**Given** the Postgres function `accessible_page_ids_for_user(uid text)` is
declared `SECURITY DEFINER` (runs with the definer's privileges, not the
caller's),
**should** it set an explicit `search_path` on the function so a role with
`CREATE` on any schema in the default search path cannot shadow built-ins like
`now()` or operators referenced inside the function body.

Acceptance: `pg_proc.proconfig` for `accessible_page_ids_for_user` contains a
`search_path=` entry pointing at `pg_catalog, public` (or equivalent minimal
path).

## Fix 2 — Cycle / depth guard on the breadcrumb recursive CTE

**Given** `fetchBreadcrumb` walks `pages.parentId` via a recursive CTE
(`page-payload-service.ts`),
**should** the CTE refuse to recurse indefinitely if the `parentId` chain ever
contains a cycle — a malformed tree must not be able to hang the request.

Acceptance: a test that inserts a 2-node cycle (`a.parentId = b`,
`b.parentId = a`) and asserts `loadPagePayload` returns a bounded breadcrumb
rather than timing out.

## Fix 3 — Reconcile migration comment with stricter semantics

**Given** the migration comment in `0100_accessible_page_ids_for_user.sql`
claims it "mirrors `getUserAccessLevel` + `getUserAccessiblePagesInDrive`",
**should** the comment accurately state the new function is *stricter* — it
excludes trashed pages and pages in trashed drives, which neither source
function does.

Acceptance: the migration header reads as a truthful spec of the function's
behaviour; a reviewer doesn't have to diff against old code to discover the
tightening.
