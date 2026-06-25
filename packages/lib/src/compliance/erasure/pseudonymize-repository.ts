/**
 * Repository edges for Art 17(3)(b) audit pseudonymization (#985).
 *
 * Each function applies the pure patch from `pseudonymize.ts` to the rows owned
 * by a user, after asserting the patch cannot touch a hash-chained column.
 * Returns the number of rows pseudonymized. The hash chain is NOT recomputed —
 * the patched columns are not hash inputs, so the chain stays valid by
 * construction (and the admin route verifies this before/after).
 */

import { db } from '@pagespace/db/db';
import { eq } from '@pagespace/db/operators';
import { activityLogs } from '@pagespace/db/schema/monitoring';
import { securityAuditLog } from '@pagespace/db/schema/security-audit';
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

export async function pseudonymizeSecurityAuditLogForUser(userId: string): Promise<number> {
  const patch = buildSecurityAuditPseudonymizationPatch();
  assertPseudonymizationPatchSafe(patch, SECURITY_AUDIT_HASHED_FIELDS);

  const rows = await db
    .update(securityAuditLog)
    .set(patch)
    .where(eq(securityAuditLog.userId, userId))
    .returning({ id: securityAuditLog.id });

  return rows.length;
}
