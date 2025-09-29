# Processor RBAC Integration Plan

## 1. Goals & Non-Negotiables
- **Single source of truth for access control**: the processor must rely on the same drive/page RBAC that powers the web app (`packages/lib/src/permissions-cached.ts`).
- **Content-addressed storage without per-node metadata drift**: deduped files remain immutable, while ownership/ACL data lives in the database, not local JSON files.
- **Scoped, verifiable service-to-service auth**: every processor call is authenticated with issuer/audience-bound JWTs that carry user identity, resource, and scope claims.
- **Auditability and revocation**: all access is logged with user/page/drive context; permission changes take effect instantly without redeploying processor nodes.

## 2. Current State Snapshot
- The processor gates requests with `SERVICE_JWT_SECRET` and a `tenantId` claim (`apps/processor/src/middleware/auth.ts`), storing per-file metadata in `/data/files/<hash>/metadata.json` (`apps/processor/src/cache/content-store.ts`).
- Web APIs mint tokens with `tenantId = user.id` (`apps/web/src/app/api/files/[id]/view/route.ts`, etc.), so collaborators cannot satisfy the processor’s tenant check.
- Drive membership exists (`packages/db/src/schema/members.ts`) but only drive owners are treated specially; the processor knows nothing about these roles.
- File ownership is implied by the uploading user; dedupe for another user fails hard (`apps/processor/src/api/upload.ts`).

**Result**: authorization is inconsistent with the web app, multi-user drives break, and local metadata cannot scale across instances.

## 3. Target Architecture

### 3.1 Identity & Service Authentication
- Introduce an auth helper shared by web + processor:
  - Issue JWTs using JOSE with claims: `iss` (auth service), `aud` (`processor`), `sub` (user id), `resource` (page id), `scope` (array like `files:read`, `files:write`, `queue:read`), `token_type = service`, `exp`, `jti`.
  - Enforce length/entropy requirements for `SERVICE_JWT_SECRET` replacement, or move to asymmetric keys.
- Processor middleware verifies:
  - signature, issuer, intended audience,
  - expiration & `jti` (optional replay cache),
  - presence of `sub`, `resource`, `scope`.
- Replace `tenantId` usage with the `sub` (user) plus `resource` so we can resolve permissions through the shared RBAC helpers.

### 3.2 Permission Resolution
- Export the cached permission helpers from `packages/lib/src/permissions-cached.ts` via a shared package re-used in the processor (DB access + Redis cache).
- Processor endpoints map incoming content hashes to page IDs, then call:
  - `getUserAccessLevel(userId, pageId)` for read/write operations.
  - `getUserDriveAccess(userId, driveId)` for drive-scoped actions (queue status, ingestion).
- Build lightweight wrappers in processor to translate scopes: e.g. `files:read` requires `canView`, `files:write` requires `canEdit` (or drive ownership), `files:share:any` ties to `canShare` + owner.
- Enforce drive-owner/role checks once drive roles acquire semantics beyond owner-only.

### 3.3 Metadata & Deduplication
- Add database tables (Drizzle + migration):
  - `files`: `id` (content hash), `drive_id`, `mime_type`, `size`, `created_at`, `created_by`, `checksum_version`.
  - `file_pages`: `file_id`, `page_id`, `linked_at`, `linked_by`.
  - Optional `file_jobs` for queued operations and state.
- During upload:
  1. Processor persists the original file to storage (local disk or object store) keyed by hash.
  2. Processor upserts into `files` and inserts into `file_pages` (idempotent on conflict), using the DB connection shared with the web app (reuse `DATABASE_URL`).
  3. Response to web includes `contentHash` + metadata.
- Dedup rules:
  - Allow linking existing hashes to additional pages as long as the uploader has `canEdit` or higher on the target page.
  - Optional: record `created_by` vs `linked_by` for auditing.

### 3.4 Storage & Distribution
- Continue using content-addressed storage but treat `/data/files/<hash>/metadata.json` as a cache-only artifact. Eventually move to object storage (S3/GCS) using the same directory schema.
- Store derived assets (cache presets) under `/data/cache/<hash>/<preset>` but reference them via DB metadata instead of inferring from the filesystem.
- Add a background reconciliation job to update DB metadata from legacy JSON until the migration completes.

### 3.5 Processor API Changes
- **Upload (`/api/upload/*`)**
  - Require tokens with `scope=files:write` and `resource=pageId` (or include `driveId` if needed).
  - After storing the file, insert `files`/`file_pages` rows.
  - Drop tenant checks; rely on RBAC to ensure the uploader can edit the page.

- **Serve (`/cache/:contentHash/...`)**
  - Look up `file_pages` for `contentHash` → `pageId` candidates.
  - Require `resource` claim or accept `pageId` query to disambiguate when multiple pages share the same hash.
  - Call `getUserAccessLevel` for each candidate, allow if any returns `canView=true`.

- **Optimize / Ingest / Reprocess**
  - Require `files:optimize` or `files:ingest` scope.
  - Resolve page via `file_pages` then call RBAC helpers to ensure the user can edit or manage the page.
  - When job results update DB (`apps/processor/src/db.ts`), ensure only authorized workers perform updates (they should run with a machine token representing the system, not a user).

### 3.6 Background Workers & Queues
- Queue jobs should carry `pageId`, `fileId`, and `initiatedBy` (user id) for auditing.
- Worker actions (text extraction, optimization) run as a system principal; log the initiating user for traceability but gate DB writes by system-level credentials.
- If jobs need to re-validate permissions (e.g., long-running tasks), fetch `getUserAccessLevel` at execution time and abort if access is revoked.

### 3.7 Observability & Security
- Emit structured logs from processor endpoints: `userId`, `pageId`, `driveId`, `contentHash`, `action`, `scope`, `result`.
- Expose metrics: auth failures, permission denials, dedupe attempts, job queue sizes.
- Implement replay protection for service tokens (`jti` cache with short TTL).
- Penetration tests: attempt cross-drive access, dedupe from unauthorized pages, reprocess after revocation.

### 3.8 Drive Roles Roadmap
- Once `driveMembers.role` gains semantics beyond owner-only, derive page-level defaults:
  - `ADMIN` inherits edit/share on all pages unless overridden.
  - `MEMBER` inherits view (and optionally edit) per drive settings.
- Store drive-level policies in a dedicated table and incorporate them into the shared permission helper so processor benefits automatically.

## 4. Migration Plan

### Phase 0 – Stabilize / Roll Back (Optional)
- Disable current tenant enforcement (`PROCESSOR_AUTH_REQUIRED=false`) or revert the recent merge to stop blocking users.
- Announce freeze while redesign is implemented.

### Phase 1 – Shared Permission Module
- Extract `packages/lib/src/permissions-cached.ts` and its dependencies (cache, logger) into a new internal package consumable by processor (`@pagespace/permissions`).
- Wire processor to use the shared module (verify DB + Redis connection configs).
- Add contract tests to ensure permission checks match web behavior.

### Phase 2 – Metadata Tables & Drizzle Models
- Define Drizzle schema + migrations for `files`, `file_pages`, optional `file_jobs`.
- Backfill existing pages where `pages.filePath` is set:
  - Insert rows into `files` (one per unique hash) and `file_pages` (page ↔ hash).
  - Derive `drive_id` from the page record.
- Provide a recon script to re-run as needed during rollout.

### Phase 3 – Service Token Contract
- Implement a shared token issuer in `packages/lib/src/auth-utils.ts` that produces resource-scoped tokens.
- Update web APIs to request tokens with `resource=pageId`, `scope` specific to the operation.
- Add token verifier middleware to processor enforcing issuer/audience/resource/scope.
- Introduce replay cache + structured error responses.

### Phase 4 – Processor Endpoint Refactor
- Refactor upload/download/serve/optimize/ingest routes to:
  - Resolve page via `file_pages`.
  - Run shared permission checks.
  - Record access events.
- Remove `tenantHasAccess` checks; delete JSON-metadata tenant enforcement.
- Update queue payloads to include `pageId` and `initiatedBy`.

### Phase 5 – Storage & Backfill Cleanup
- Migrate metadata from JSON files into DB rows; remove `metadata.tenants` reliance.
- Optionally move files into object storage; update `ContentStore` to use DB for metadata and S3/GCS for blobs.
- Add a watchdog to detect orphaned hashes (files without page links) for cleanup.

### Phase 6 – Observability & Hardening
- Add audit logging and metrics exporters (OpenTelemetry or structured logs shipped to ELK).
- Implement automated tests:
  - Positive: owner access, collaborator access, dedup uploads, post-revocation denial.
  - Negative: forged tokens, expired tokens, scope mismatch, unauthorized dedup.
- Conduct load tests to ensure DB lookups + caching keep latency acceptable (<50 ms per check under load).

### Phase 7 – Deprecation & Documentation
- Remove legacy `tenantId` references from web + processor.
- Update developer docs (`FILE_UPLOAD_ARCHITECTURE.md`, `security-remediation-plan.md`) to reflect new flow.
- Communicate rollout plan: feature flags, timeline, rollback strategy.

## 5. Risks & Mitigations
| Risk | Impact | Mitigation |
|------|--------|------------|
| Migration script misses pages/files | Users lose access to legacy uploads | Dry-run scripts in staging; compare counts between `pages` and `file_pages`; maintain fallback to JSON metadata until parity verified |
| Cross-service dependency drift | Processor deploys break when permission schema changes | Shared package versioning + integration tests; CI pipeline that runs processor tests against latest schema |
| Token replay or leakage | Unauthorized access to files | Short TTL (≤5 min), `jti` replay cache, rotate signing keys, enforce TLS |
| Performance regressions from DB lookups | Latency spikes on high-traffic routes | Redis-backed cache (existing `PermissionCache`), batch queries for multi-file operations |
| Queue jobs running after access revoked | Data exposure post-share removal | Re-check permissions for long jobs, cancel/skip when revoked, log incidents |
| Object storage migration complexity | Downtime or data inconsistency | Phase migration (write to both disk + object store, read with fallback) |

## 6. Open Questions
1. Should drive-level roles (ADMIN/MEMBER) inherit default permissions, or remain manual per-page grants?
2. Do we want presigned URLs directly from object storage for large downloads, or keep the processor as proxy?
3. How strict should scope mapping be (`files:read` vs `files:download` vs `files:preview`)?
4. Are system-to-processor calls (e.g., PgBoss workers) authenticated via separate machine credentials or reuse the same JWT issuer with `sub=system`?
5. What is the retention policy for orphaned files or pages deleted while files still exist?

## 7. Implementation Checklist (tl;dr)
- [ ] Create shared permission/token packages and wire processor.
- [ ] Add `files` + `file_pages` schema + backfill scripts.
- [ ] Update service token issuance + verification with resource & scope.
- [ ] Refactor processor endpoints to use shared RBAC and DB metadata.
- [ ] Migrate metadata from JSON to DB, decommission `tenantHasAccess`.
- [ ] Instrument logging/metrics and add integration/penetration tests.
- [ ] Update docs + rollout plan.

## 8. Engineering Practices for the Redesign
- **Architecture discipline**
  - Keep services stateless; inject dependencies (DB, cache, storage clients) so tests can substitute fakes.
  - Encapsulate shared RBAC + token logic in versioned packages; avoid copy/paste between services.
  - Treat migrations and backfills as first-class code with rollback paths and automated verification scripts.
- **Code quality & maintainability**
  - Enforce strict TypeScript settings (`noImplicitAny`, `exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`).
  - Adhere to functional boundaries: middleware for auth, route handlers for orchestration, domain services for business rules.
  - Prefer pure functions and deterministic helpers; avoid hidden state in singletons beyond the existing caches.
  - Document invariants in code comments where not self-evident (e.g., hash normalization, idempotency requirements).
- **Security-first mindset**
  - Zero plaintext secrets in code or logs; use typed config loaders that validate presence/entropy at startup.
  - Every external input (headers, params, JSON) must be schema-validated (`zod`/`valibot`) before use.
  - Default-deny authorization: fail closed on cache misses or ambiguous resource lookups; explicitly log denials.
  - Rotate signing keys regularly; support key IDs (`kid`) in JWT headers for seamless rotation.
  - Harden Express with standard middlewares (helmet, rate limits, request size caps) and audit dependencies for CVEs before release.
- **Reliability & scalability**
  - Make every storage/DB mutation idempotent; include correlation IDs to retry safely.
  - Wrap external calls (DB, Redis, storage) with timeouts and circuit breakers; expose fallback metrics.
  - Parallelize CPU-heavy work via worker pools/queue concurrency, not blocking request threads.
  - Use structured logging (`pino`/`winston`) with JSON output; include trace IDs to join logs across services.
- **Testing & verification**
  - Require unit tests for permission helpers, token issuers/verifiers, and metadata resolvers.
  - Add integration tests that spin up Postgres + Redis containers to exercise upload→download flows end-to-end.
  - Gate merges on `pnpm lint`, `pnpm typecheck`, and targeted test suites for web + processor packages.
  - Incorporate security tests (jwt tampering, replay attempts, permission revocation) into CI.
- **Operational excellence**
  - Ship OpenTelemetry traces for key spans (auth check, RBAC lookup, storage fetch) to detect regressions.
  - Surface SLOs (p95 latency, auth error rate) in dashboards; page on sustained violations.
  - Automate rollouts with staged deployments and health checks; keep one-click rollback scripts.
  - Maintain runbooks for backfills, secret rotation, and incident response tied to this architecture.

These guidelines are non-negotiable: no temporary shortcuts, feature flags, or TODOs should reach main without a concrete removal plan. Aim for production-grade quality at every iteration.

## 9. Build & Packaging Alignment (Added after initial spike)

The first pass at wiring the processor into RBAC was developed against the TypeScript sources directly. Docker images—and any production runtime—only execute compiled JavaScript, so imports such as `@pagespace/lib/permissions-cached` failed inside the container (`SyntaxError: Unexpected token ':'`). To prevent a repeat, we must fold the following into the plan:

- **Restore clean package baselines:** revert ad-hoc tweaks in `packages/lib` and ensure no stray `dist/` artifacts are tracked. All packages should declare a consistent `build` script that emits JS + DTS into `dist/`.
- **Workspace build graph:** update Turbo so `@pagespace/lib`, `@pagespace/db`, etc. run their `pnpm build` before any app (`@pagespace/processor`, `realtime`, `web`) compiles. Apps should consume the compiled `dist/` outputs.
- **Exports & tsconfig updates:** adjust each shared package to export from `dist/…` (with matching `types`) and expose the same entry points for both Node and browser targets. TypeScript configs should reference those compiled modules when packaging.
- **Dockerfile alignment:** modify the processor Dockerfile (and other service images as needed) to run the workspace builds prior to `pnpm --filter @pagespace/processor build`, and only copy compiled output into the runtime layer.
- **Validation:** after restructuring, run `pnpm build` locally and `docker compose up` to confirm migrations, processor start-up, and RBAC behaviour work end to end.

Only once the build pipeline is green should we continue with the remaining TODOs (backfilling `file_pages`, removing JSON metadata reads, etc.). This safeguards production deployments and keeps the processor images reproducible.
