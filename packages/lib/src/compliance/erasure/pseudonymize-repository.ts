/**
 * Repository edges for Art 17(3)(b) audit pseudonymization (#985, #890 leaf 6).
 *
 * Each function applies the pure patch from `pseudonymize.ts` to the rows owned
 * by a user, after asserting the patch cannot touch a hash-chained column.
 * Returns the number of rows pseudonymized. The hash chain is NOT recomputed —
 * the patched columns are not hash inputs, so the chain stays valid by
 * construction (and the admin route verifies this before/after, per store).
 *
 * Activity logs live only in the main DB (their move is a later phase).
 * Security-audit rows are transitionally SPLIT across the Admin PG and the
 * main DB, so that function takes the target store explicitly — callers get
 * it from resolveSecurityAuditErasureTargets, which pairs each store with
 * the identity allowed to write it (eraser LOGIN on admin, app on main).
 */

import { db } from '@pagespace/db/db';
import { eq } from '@pagespace/db/operators';
import { activityLogs } from '@pagespace/db/schema/monitoring';
import { securityAuditLog } from '@pagespace/db/schema/security-audit';
import type { AdminDatabase } from '@pagespace/db/admin-db';
import type { SecurityAuditDatabase } from '../../audit/security-audit-repository';
import {
  ACTIVITY_LOG_HASHED_FIELDS,
  SECURITY_AUDIT_HASHED_FIELDS,
  buildActivityLogPseudonymizationPatch,
  buildSecurityAuditPseudonymizationPatch,
  assertPseudonymizationPatchSafe,
} from './pseudonymize';

export async function pseudonymizeActivityLogsForUser(userId: string): Promise<number> {
  const patch = buildActivityLogPseudonymizationPatch();
  assertPseudonymizationPatchSafe(patch, ACTIVITY_LOG_HASHED_FIELDS);

  const rows = await db
    .update(activityLogs)
    .set(patch)
    .where(eq(activityLogs.userId, userId))
    .returning({ id: activityLogs.id });

  return rows.length;
}

export interface SecurityAuditPseudonymizeDeps {
  /** The store to erase in — REQUIRED so no caller silently targets the wrong plane. */
  db: SecurityAuditDatabase;
}

export async function pseudonymizeSecurityAuditLogForUser(
  userId: string,
  deps: SecurityAuditPseudonymizeDeps,
): Promise<number> {
  const patch = buildSecurityAuditPseudonymizationPatch();
  assertPseudonymizationPatchSafe(patch, SECURITY_AUDIT_HASHED_FIELDS);

  // Same union-narrowing as the chain verifier (leaf 0 finding): the two
  // clients' generic signatures don't unify into a callable union against
  // packages/db/dist .d.ts. AdminDatabase is the least-capable member, so
  // the cast cannot widen what this UPDATE can do.
  const rows = await (deps.db as AdminDatabase)
    .update(securityAuditLog)
    .set(patch)
    .where(eq(securityAuditLog.userId, userId))
    .returning({ id: securityAuditLog.id });

  return rows.length;
}
