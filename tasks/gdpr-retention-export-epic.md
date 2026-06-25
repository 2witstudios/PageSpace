# GDPR Retention & Export Epic

**Status**: 📋 PLANNED
**Goal**: Close GDPR storage-limitation (Art 5(1)(e)) and portability (Art 20) gaps — make retention windows configurable, add the activity_logs hot→cold tiering writer, and give the data export a manifest + a documented portable format.

## Overview

Because tenant deployments cannot currently configure retention (windows are hardcoded in route handlers), the activity_logs hot/cold tier is designed but has no writer (so the active view never narrows and query cost grows forever), and the export bundle ships raw JSON with no manifest or standard format (hurting portability), this epic makes every retention window env-driven, ships the `isArchived` flip job (chain-safe, batched, HMAC-validated), and adds an export `manifest.json` plus a documented schema.org-based portable format. Every leaf is satisfiable only by a failing test written first and business logic living in a pure function; side effects (DB/Drizzle, archiver) sit at thin imperative edges.

---

## Phase 1 — Configurable AI-usage retention (#918)

### AI-usage retention window helper

Add a pure, env-driven helper for the AI-usage-log purge window, mirroring the existing `RETENTION_*` config pattern.

**Requirements**:
- Given no `RETENTION_AI_USAGE_LOGS_DAYS` env var, should return the default of 90 days from a pure `getAiUsageLogsRetentionDays()` function (proven by a test written first).
- Given a valid positive integer in `RETENTION_AI_USAGE_LOGS_DAYS`, should return that value.
- Given a zero, negative, non-numeric, or empty `RETENTION_AI_USAGE_LOGS_DAYS`, should fall back to 90.

### Wire purge cron to the configurable window

Replace the hardcoded 90-day literal in the purge-ai-usage-logs route with the pure helper + `getRetentionCutoff`.

**Requirements**:
- Given the route runs, should derive the cutoff from `getAiUsageLogsRetentionDays()` (not a hardcoded literal), verified by a route test that overrides the env var and asserts `purgeAiUsageLogs` is called with the matching cutoff.
- Given `RETENTION_AI_USAGE_LOGS_DAYS` is documented in `.env.example`, should sit alongside the other monitoring-table retention vars.

---

## Phase 2 — activity_logs hot→cold tiering writer (#984)

### Archival config + loop-control pure functions

Add pure config parsing and a pure loop-control predicate for the archival job.

**Requirements**:
- Given no env vars, should return defaults `{ archiveDays: 365, batchSize: 1000, maxRunMs: 25000 }` from a pure `getActivityLogArchivalConfig()` (test first).
- Given valid `ACTIVITY_LOGS_ARCHIVE_DAYS` / `_BATCH_SIZE` / `_MAX_RUN_MS`, should use them; given invalid/zero/negative/empty values, should fall back to each default.
- Given a drained batch (`lastBatchSize < batchSize`), should stop via a pure `shouldContinueArchiving` predicate.
- Given elapsed wall-clock `>= maxRunMs`, should stop; otherwise should continue.

### Archival edge (isArchived flip, batched, chain-safe)

Add the thin imperative `archiveActivityLogs(database, opts)` that selects aged unarchived rows in batches and flips only `isArchived`.

**Requirements**:
- Given rows older than the cutoff with `isArchived = false`, should set `isArchived = true` in batches bounded by `batchSize`, returning `{ table: 'activity_logs', archived, batches }`.
- Given the update payload, should contain ONLY `{ isArchived: true }` and never any hash-chain field (`previousLogHash`, `logHash`, `chainSeed`, `chainSeq`) — asserted by a test inspecting the `set()` argument.
- Given an empty first batch, should perform zero updates and return `archived: 0`.
- Given the per-run wall-clock budget is exhausted mid-run, should stop early without losing the already-archived count.

### Archive cron route (HMAC + before/after chain check)

Add `apps/web/src/app/api/cron/archive-activity-logs/route.ts`, HMAC-validated, calling the edge and doing a defense-in-depth chain integrity check.

**Requirements**:
- Given a request failing `validateSignedCronRequest`, should return that auth error and never archive (test first).
- Given a successful run, should call `archiveActivityLogs` and emit a `data.update` audit event with the archived count.
- Given the run completes, should report `quickIntegrityCheck` before/after results in the JSON response.

### Retention policy doc

Document the archival tier and its env vars.

**Requirements**:
- Given `docs/security/audit-log-retention-policy.md`, should contain an "Archival" section describing the `isArchived` flip job, its defaults, that it never deletes rows or touches the hash chain, and the `ACTIVITY_LOGS_ARCHIVE_*` env vars (also added to `.env.example`).

---

## Phase 3 — Export manifest (#915)

### Pure manifest builder

Add a pure `buildExportManifest(data, opts)` deriving a versioned schema + file inventory from `AllUserData`.

**Requirements**:
- Given `AllUserData` and an export date, should return a manifest object with `schemaVersion`, `exportedAt`, `generator`, and a `files` inventory listing each export file name, description, and record count (test first, no I/O).
- Given a collection section (e.g. `pages`), should report its exact array length as `recordCount`; given the singular `profile`, should report `recordCount: 1`; given a null `personalization`, should omit it from the inventory.

### Wire manifest into the export ZIP

Append `manifest.json` to the archive in the export route.

**Requirements**:
- Given an export is generated, should include `manifest.json` built by `buildExportManifest`, verified by a pure test on the builder (route is a thin edge appending the serialized result).

---

## Phase 4 — Documented portable format (#916)

### Pure portable transformer

Add a pure `toPortableExport(data)` mapping `AllUserData` onto a documented schema.org-aligned structure.

**Requirements**:
- Given `AllUserData`, should return an object with `@context: "https://schema.org"` and a `Person` mapping the profile, with pages mapped to `CreativeWork` and messages to `Message` (test first, deterministic, no I/O).
- Given any date field, should serialize as an ISO-8601 string for interoperability.
- Given an unknown/empty section, should produce an empty array rather than throwing.

### Format selection + wiring

Add a pure `parseExportFormat(param)` and wire a `?format=` switch into the route.

**Requirements**:
- Given no/`native`/unknown `format`, should resolve to `native` from pure `parseExportFormat`; given `portable`, should resolve to `portable` (test first).
- Given `format=portable`, the route should emit the schema.org `data.json` (plus manifest) instead of the native per-section files; given native, should keep current behavior.
- Given the portable format, should be documented in `docs/security/gdpr-export-format.md`.
