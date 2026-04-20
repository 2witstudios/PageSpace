# One-Fetch Groundwork — Review Follow-Up Fixes

Follow-ups to the code review on branch `pu/one-fetch-groundwork`. All changes
land against purely-additive code (no route consumes the new fetchers yet), so
blast radius is limited to anyone who runs the migration or calls
`loadPagePayload` / `loadAppShell`.

## Status

| # | Fix | Status | Commit |
|---|---|---|---|
| 1 | Pin `search_path` on SECURITY DEFINER | ✅ done | `c3e4da09` |
| 2 | Cycle/depth guard on breadcrumb CTE | ✅ done | `cda93b7e` |
| 3 | Migration comment reflects stricter semantics | ✅ done | `c3e4da09` |
| 4 | Require accepted ADMIN membership (CodeRabbit Critical) | ✅ done | `59c96623` |
| 5 | Isolate shell drives from explicit page grants (Codex P1 / CodeRabbit Major) | ✅ done | `8261d673` |
| 6 | Redact breadcrumb ancestors caller cannot view (CodeRabbit Major) | ✅ done | `5899d508` |

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

## Fix 4 — Accepted-ADMIN gate on the SECURITY DEFINER function

**Given** the SQL function grants page visibility to ADMIN members,
**should** it require `drive_members.acceptedAt IS NOT NULL` so pending ADMIN
invites do not leak data.

Acceptance: regression test `does NOT grant access to an ADMIN member whose
invitation has not been accepted` asserts the empty result; the existing happy
path still passes. Companion change in `loadAppShell` requires the same
accepted-member gate for shell-drive visibility.

## Fix 5 — Isolate app-shell drives from explicit page grants

**Given** `loadAppShell.fetchAccessibleDriveIds` promoted any explicit
`page_permissions` row into a full drive entry (returning the drive summary,
the drive's member list, and potentially the drive's non-trashed page tree),
**should** shell drive visibility be restricted to owner ∪ accepted-member, so
a single-page grant cannot enumerate unrelated member rows or sibling pages.

Acceptance: a caller with only an explicit page-permission grant in a drive
they do not belong to sees neither the drive summary nor any member rows for
that drive; an `activeDriveId` pointing at such a drive is silently ignored.
Page-level access still flows through `loadPagePayload` /
`accessible_page_ids_for_user`.

## Fix 6 — Redact breadcrumb ancestors the caller cannot view

**Given** `fetchBreadcrumb` returned `title` and `type` for every ancestor of
the requested page,
**should** ancestor metadata be redacted for any ancestor not in the caller's
`accessible_page_ids_for_user` set, so explicit-grant holders do not learn the
titles of parent folders they cannot view.

Acceptance: `BreadcrumbEntry.title` and `.type` are nullable; the CTE nulls
them for inaccessible ancestors. The leaf page is always populated (already
authorized by `ensurePageAccessible`). Regression test verifies a grantee on a
nested doc sees `null` title/type for the parent folder.
