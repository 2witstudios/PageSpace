/**
 * Audit DB binding — the resolved-mode call site for every default audit
 * read/write path (#890 Phase 2, leaf 5 — runtime cutover).
 *
 * One decision, taken lazily once per process:
 *
 *   dedicated   → the Admin PG client (trust plane). Writes go through the
 *                 lock-free ingest writer; reads (queries, chain verifier,
 *                 cron) hit the admin store.
 *   break-glass → the MAIN db client, i.e. the pre-cutover legacy path,
 *                 both writes (advisory-lock chained append) and reads, with
 *                 LOUD observability at the write bind point.
 *   main-db     → the MAIN db client too, but SILENT — the pre-trust-plane
 *                 default for deployments that never adopted the Admin PG.
 *                 Identical DB target to break-glass; the difference is
 *                 purely observability (see security-audit.ts).
 *   fail        → throw the actionable reason. A process that DECLARED the
 *                 trust plane required (AUDIT_TRUST_PLANE_REQUIRED) but did
 *                 not configure it must not write or read audit data as if
 *                 nothing were wrong.
 *
 * Both main-DB bindings deliberately use the plain `db` client, NOT
 * getAdminDb()'s main-pool client: that one is admin-schema-typed and maps
 * emission_hash (admin migration 0005, admin plane only), so its generated
 * SELECTs would 42703 against the main-plane table.
 *
 * Break-glass OBSERVABILITY (security event + alert) is owned by the write
 * bind point in security-audit.ts — this module only decides and reports.
 */

import { db as mainDb } from '@pagespace/db/db';
import { getAdminDb, getAdminDbMode, type AdminDatabase } from '@pagespace/db/admin-db';

export type AuditDbBinding =
  | { mode: 'dedicated'; reason: string; db: AdminDatabase }
  | { mode: 'break-glass'; reason: string; db: typeof mainDb }
  | { mode: 'main-db'; reason: string; db: typeof mainDb };

let cached: AuditDbBinding | null = null;

/**
 * Resolve (and cache) the audit DB binding for this process.
 * Throws in fail mode — every call, never caching the failure.
 */
export function resolveAuditDbBinding(): AuditDbBinding {
  if (cached) return cached;

  const decision = getAdminDbMode();
  switch (decision.mode) {
    case 'dedicated':
      cached = { mode: 'dedicated', reason: decision.reason, db: getAdminDb() };
      return cached;
    case 'break-glass':
      cached = { mode: 'break-glass', reason: decision.reason, db: mainDb };
      return cached;
    case 'main-db':
      cached = { mode: 'main-db', reason: decision.reason, db: mainDb };
      return cached;
    case 'fail':
      throw new Error(`audit db binding failed: ${decision.reason}`);
  }
}

/** Test hook: clear the cached binding so mode changes are re-observed. */
export function resetAuditDbBindingForTests(): void {
  cached = null;
}
