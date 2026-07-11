# Docs Routing & Domain Landing Pages Epic

**Status**: 📋 PLANNED
**Goal**: Route `pagespace.ai/docs` to published Canvas content the same way `/prism` already works, then generalize that mechanism into a self-service per-domain landing/404-page override so any drive owner — not just a platform admin hand-editing a shared Caddyfile — can give different domains on the same drive genuinely different content. Full path-prefix multi-site mounting (the deeper generalization that would let `/prism` and `/docs` stop being registered paths entirely) is intentionally out of scope here and deferred to its own epic.

---

## Flip Caddy Routing for /docs

In `~/production/PageSpace-Deploy` (`fly/Caddyfile.fly`), stop `/docs` from being claimed by the marketing matcher so it falls through to the same published-content path `/prism` already uses.

**Requirements**:
- Given `(pagespace_ai_published_paths)` (line 67) lists only `/prism /prism/*`, should extend it to `/prism /prism/* /docs /docs/*` per the file's own maintenance note (lines 62–64: "Add a line here for EVERY new top-level path registered as a platform-owned published page").
- Given the `@marketing` matcher (lines 214–215) lists `path /docs` / `path /docs/*`, should remove those two lines so marketing stops claiming the path.
- Given `@pagespace_root_published`'s exclusion list (line 332) has `not path /docs /docs/*`, should remove that line so the published-content fallback picks the path up.
- Given this is a shared production proxy fronting all pagespace.ai traffic, should make no other changes to the file — this is a 3-line diff, not a refactor.

---

## Verify /docs Production Cutover

Confirm the routing change works end-to-end without regressing anything else on the shared proxy, before and after deploy.

**Requirements**:
- Given the drive's own `<subdomain>.pagespace.site/docs/...` published URL, should confirm the docs pages resolve correctly there first (content-correctness check independent of Caddy).
- Given `curl -I https://pagespace.ai/docs` and a couple of nested paths (e.g. `/docs/getting-started`), should confirm they return the published Canvas content's headers (`published_headers` import: `frame-ancestors 'none'`, no `X-Frame-Options`, no HSTS) rather than marketing's, after the proxy redeploys.
- Given `/prism`, `/`, `/pricing`, `/blog` are unrelated paths touched by adjacent matchers in the same file, should confirm each still routes to its expected upstream (regression check).
- Given a published-content miss (page not actually published at that path), should confirm it falls through to `pagespace-web.flycast` (the app's own 404), not to marketing — matching `/prism`'s existing behavior.

---

## Review: Caddyfile Routing Change

Run a focused review of the Phase 0 diff before merge, given the high blast radius of editing a shared production edge proxy.

**Requirements**:
- Given the diff touches `@marketing`, `@pagespace_root_published`, and `(pagespace_ai_published_paths)`, should verify no other reserved path (`/pricing`, `/blog`, `/faq`, `/api/*`, `/dashboard/*`, etc.) was accidentally altered.
- Given Caddy's `handle` blocks are matched top-down and mutually exclusive, should verify matcher ordering still puts `@marketing` and `@pagespace_root_published` in the correct relative sequence after the edit.
- Given the header-scoping snippet exists specifically so published paths don't inherit app security headers, should verify `/docs` genuinely receives `published_headers`, not `@app_headers`/`@app_headers_coep`/`@corp_same_origin`.
- Given this repo's deploy flow auto-redeploys `pagespace-proxy` on merge (`.github/workflows/deploy-proxy.yml`), should flag in the PR description that merge = immediate production effect, not a staged rollout.

---

## Rubric: Docs Routing Acceptance Criteria

Define the explicit pass/fail checklist for Phase 0 before it's considered done.

**Requirements**:
- Given a visitor requests `pagespace.ai/docs` and any nested doc path, should serve the published Canvas content with a 200 and correct published-page headers.
- Given a visitor requests `pagespace.ai/prism`, `/`, `/pricing`, or `/blog`, should see no behavior change from before the edit.
- Given a doc path that isn't actually published, should serve the app's own 404 (via `pagespace-web.flycast`), not marketing's docs 404 and not a raw Tigris error.
- Given the marketing app's old `/docs/**` code is left in place per the deferred-cleanup decision, should confirm it is simply unreachable in production (not double-served, not causing a conflict) — no cleanup required to pass this rubric.

---

## Add Per-Domain Landing & 404 Page Columns

Extend `custom_domains` (`packages/db/src/schema/custom-domains.ts`) so a domain can override which published page serves its root and its 404, instead of every domain on a drive being a byte-for-byte identical mirror.

**Requirements**:
- Given `custom_domains` currently has no way to differ per-row in served content, should add nullable `publishLandingPageId` and `publishNotFoundPageId` columns, both FKs to `pages.id` with `onDelete: 'set null'` — named distinctly from `drives.homePageId` (the unrelated in-app workspace landing page from the Drive Home Page epic) to avoid UI/mental-model confusion between "in-app home" and "public site landing page per domain".
- Given an override is unset (`null`), should fall back to the drive-wide root (path `''`) and the drive-wide `notFoundPageId`, exactly as today — this must be strictly additive, no behavior change for existing single-purpose domains.
- Given the referenced page must actually be a published Canvas page belonging to the same drive, should not enforce that at the DB layer (no cross-table type check in Postgres) but document it as an API-layer invariant for the next task.
- Given schema changes in this repo, should run `bun run db:generate` to produce the migration — never hand-edit SQL in `packages/db/drizzle/`.

---

## Extend Publish Resolution & Mirror Pipeline for Per-Domain Overrides

Make the actual artifact served at a custom domain's root (and 404) honor its override, given today's mirror pipeline assumes every domain is an identical copy.

**Requirements**:
- Given `apps/web/src/lib/canvas/custom-domain-mirror.ts`'s `mirrorDriveToCustomHost` copies the subdomain's tree verbatim into `published/<host>/`, should special-case the root `index.html` and `404.html` objects: when the domain row has `publishLandingPageId`/`publishNotFoundPageId` set, mirror that specific published page's artifact into the root/404 slot instead of the drive-wide one.
- Given `packages/lib/src/canvas/primary-host.ts` documents "every custom-domain mirror is byte-for-byte identical to the subdomain copy" as a load-bearing assumption, should update that comment once it's no longer universally true, and confirm nothing else (canonical URL selection, sitemap generation) silently depended on the old guarantee.
- Given a domain override changes, should trigger a re-mirror for just that domain (not the whole drive) — avoid re-copying every domain's tree when only one changed.
- Given this is the riskiest part of the epic, should add unit tests for the resolver (override set / unset / referenced page later trashed) before wiring it into the mirror pipeline.

---

## API: Per-Domain Page Override Endpoints

Expose the new columns through the existing domain-management API.

**Requirements**:
- Given `PATCH /api/drives/[driveId]/domains/[domainId]/route.ts` already handles `isPrimary`, should extend it to accept `publishLandingPageId`/`publishNotFoundPageId`, validating the referenced page exists, belongs to the same drive, is `PageType.CANVAS`, and is not trashed.
- Given a `null` value should clear the override (fall back to drive-wide), should accept explicit `null` distinctly from an omitted field, mirroring the existing `notFoundPageId` PATCH pattern on `/api/drives/[driveId]/route.ts`.
- Given only drive owners/admins can manage domains today (`canManage` check in the settings page), should enforce the same authorization here — no new permission model needed.
- Given a successful update should actually change what's served, should trigger the single-domain re-mirror from the previous task synchronously or via the existing publish-job mechanism (whichever the codebase's other publish-triggering endpoints use).

---

## Settings UI: Per-Domain Landing & 404 Page Controls

Surface the override in the existing Domains & Publishing settings page rather than building a new surface.

**Requirements**:
- Given `apps/web/src/app/dashboard/[driveId]/settings/domains/page.tsx` already renders a drive-wide "Custom 404 Page" card using `PagePickerPopover` with `pageType={PageType.CANVAS}`, should reuse the same component per-domain inside `DomainRow`, gated to `domain.status === 'active'` (same gating as the existing "Make primary"/cert buttons).
- Given `showPrimaryControls` only appears once `domains.length > 1`, should apply the same "only show once it matters" instinct to the override controls — but note landing/404 overrides are useful even with exactly one custom domain (e.g. one custom domain differing from the `*.pagespace.site` default), so don't copy that specific gate verbatim without checking it fits.
- Given the existing pattern of optimistic local state + `mutateDomains()` refetch (see `handleSetPrimary`), should follow the same request/toast/error-rollback shape already established in this file rather than introducing a new one.
- Given a domain with no override should visibly read as "using the drive default", should show that state explicitly in the UI (not just an empty picker) so users understand the fallback behavior.

---

## Review: Per-Domain Override Implementation

Full review of the Phase 1 diff (schema, resolver, mirror pipeline, API, UI) before merge.

**Requirements**:
- Given the mirror-pipeline change is the highest-risk part, should verify a domain WITHOUT an override still produces an identical mirror to today (no regression for the common case).
- Given the new FK columns reference `pages.id`, should verify the override never points at a dead page: hard deletion is handled by `onDelete: 'set null'` on the FK itself, but trashing is a soft delete that does NOT touch the FK — that case relies entirely on the resolver-level fallback (`resolveBackfillRootCopy` treating a trashed/unpublished override target as absent) and API-layer validation rejecting trashed pages on write, so both paths need explicit test coverage, not just the hard-delete one.
- Given this touches billing-adjacent surface area (custom domains already have a plan-tier `limit`), should flag to product/billing whether per-domain overrides should also be tier-gated, without blocking this PR on that decision.
- Given tests should exist for the resolver and API validation, should verify coverage for: override set, override unset, override page later trashed, override page from a different drive (rejected).

---

## Rubric: Per-Domain Landing Page Acceptance Criteria

Define the explicit pass/fail checklist for Phase 1 before it's considered done.

**Requirements**:
- Given a drive with two custom domains, should support setting different landing pages on each and observe genuinely different content at each domain's root.
- Given a domain with no override set, should serve exactly what it serves today (the drive-wide root) — zero behavior change for the default case.
- Given the settings UI, should let a drive owner set, change, and clear a per-domain landing/404 page without needing API/DB access.
- Given the `/docs` and `/prism` platform-owned rows on the production drive, should confirm they continue to work unchanged (this feature does not require migrating them off their current setup).
