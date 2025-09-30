# Processor RBAC Redesign – Implementation Report

## Overview
This document captures the portions of the processor RBAC redesign that have been implemented in the codebase and explains the resulting architecture. The intent follows the goals outlined in `processor-rbac-redesign.md`, focusing on hardened service authentication, shared RBAC enforcement, and database-backed file metadata.

## Service-to-Service Authentication
- `packages/lib/src/services/service-auth.ts` now owns service token issuance and verification. Tokens embed `sub`, `service`, `scopes`, optional `resource` fields, and are signed with the shared `SERVICE_JWT_SECRET`. Helpers exported include `createServiceToken`, `verifyServiceToken`, `authenticateServiceToken`, `decodeServiceTokenHeader`, `hasScope`, and `assertScope`.
- The web app mints tokens for processor calls through `createServiceToken` when forwarding uploads. See `apps/web/src/app/api/upload/route.ts` (lines 154-170) where the upload handler issues a scoped token (`files:write`) before streaming the file to the processor.
- Processor requests are authenticated by middleware in `apps/processor/src/middleware/auth.ts`. The middleware verifies the token, materialises a `serviceAuth` context on the request, and infers per-route scopes (upload/write, optimize/read, ingest, queue access). `requireScope` is re-used to guard individual routes so that only the declared scope list is honored.

## Permission Resolution via Shared RBAC
- Processor code now delegates to the shared cached permission helpers in `@pagespace/lib`. `apps/processor/src/services/rbac.ts` uses `getUserAccessLevel` from `packages/lib/src/permissions-cached.ts` to answer "view" and "edit" decisions for a given `contentHash`.
- File ↔ page relationships are resolved through the database: `apps/processor/src/services/file-links.ts` queries `file_pages` joined to `pages` to determine where a hash is linked. The same module exposes an idempotent `ensureFileLinked` helper for future use when processors need to write link metadata themselves.
- All processor APIs that return or mutate file data call `assertFileAccess` to enforce RBAC, e.g. the serve endpoints (`apps/processor/src/api/serve.ts`), optimize routes (`apps/processor/src/api/optimize.ts`), ingest requeueing (`apps/processor/src/api/ingest.ts`), and validation middleware (`apps/processor/src/middleware/validation.ts`).

## Persistent File Metadata & Deduplication
- New Drizzle models back file metadata. `packages/db/src/schema/storage.ts` defines `files` (content-hash primary key with drive, size, mime type, creator, timestamps) and `file_pages` (compound PK with unique `pageId` and foreign keys to `files`, `pages`, and `users`).
- The web upload handler now persists page, file, and linkage data atomically. In `apps/web/src/app/api/upload/route.ts` (lines 175-332) the handler creates the page, upserts into `files`, and records/update links in `file_pages` inside a single transaction, ensuring the `file_pages_fileId_files_id_fk` constraint is satisfied even during deduplicated uploads.
- Dedupe behaviour remains in the processor: `apps/processor/src/api/upload.ts` (lines 120-214) hashes the temporary file, skips re-upload if the content already exists, records metadata via `contentStore.appendUploadMetadata`, and still enqueues ingestion jobs. The processor does not yet call back into the database to create `file_pages`; that responsibility lives with the web handler after receiving the processor response.

## Processor API Behaviour
- Upload endpoints (`apps/processor/src/api/upload.ts`) require authenticated tokens, enforce per-scope rules (disallowing impersonation unless `files:write:any` is present), and queue ingestion jobs through PgBoss (`queueManager`).
- Serve routes (`apps/processor/src/api/serve.ts`) validate hashes, enforce `assertFileAccess`, and proxy cached assets. Metadata reads still consult the legacy `metadata.json` file to infer content type and original name; this is a future cleanup candidate.
- Ingestion routes (`apps/processor/src/api/ingest.ts`) and optimization routes (`apps/processor/src/api/optimize.ts`) rely on the same RBAC helpers and ensure only authorised users can trigger background processing.

## Web Application Changes
- The upload route now coordinates with processor authentication and RBAC, issuing service tokens, storing newly created pages/files, and updating storage accounting via `updateStorageUsage`. Error paths release semaphore slots consistently to avoid orphaned counters.
- Upload responses distinguish deduplicated vs fresh uploads and continue to surface storage quota details (`apps/web/src/app/api/upload/route.ts`, lines 333-395).

## Build & Packaging Alignment
- Shared packages now build to `dist/` and export compiled modules:
  - `packages/lib/package.json` points `main`/`types` to `dist` and enumerates explicit export maps. `packages/lib/tsconfig.build.json` compiles CommonJS output that depends on the compiled `@pagespace/db` package.
  - `packages/db/package.json` exposes a `build` script that emits runtime JS and types under `dist/` (see `packages/db/tsconfig.build.json`).
- The processor Dockerfile (`apps/processor/Dockerfile`, lines 32-35) builds `@pagespace/db` and `@pagespace/lib` before compiling the service so runtime containers never load raw TypeScript.
- Processor TypeScript config (`apps/processor/tsconfig.json`) now resolves shared workspace imports from `dist/*`, ensuring runtime parity with the compiled bundles.

## Follow-ups & Known Gaps
- Processor still reads legacy `metadata.json` files for content type/original name in serve routes; once DB metadata is backfilled, this should pivot to the structured schema.
- `getUserDriveAccess` (outlined in the plan) is not yet wired into processor flows; access checks remain page-centric via `getUserAccessLevel`.
- `ensureFileLinked` in `apps/processor/src/services/file-links.ts` is prepared but unused. Today, the web tier maintains `file_pages`. Moving this responsibility to the processor would close the loop for multi-client uploads.
- Token replay protection (`jti` caches) and key rotation support described in the plan remain future enhancements.
- Integration and penetration tests described in the plan have not yet been added; manual testing verified the happy-path upload/ingest flow.

## Conclusion
The processor now authenticates every request with scoped service tokens, resolves permissions through the shared cached RBAC layer, and records file metadata in Postgres instead of transient JSON. Deduped uploads respect page-level access and no longer violate referential integrity. Remaining work concentrates on eliminating residual filesystem metadata, broadening drive-scoped access checks, and rounding out the operational hardening tasks documented in the original redesign plan.
