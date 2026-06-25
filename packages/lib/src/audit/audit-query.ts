/**
 * Standalone audit query function.
 *
 * Extracts the query logic from SecurityAuditService into a plain function
 * so callers don't need a class instance or initialization ceremony.
 */

import { db } from '@pagespace/db/db';
import { desc, and, or, gte, lte, eq } from '@pagespace/db/operators';
import { securityAuditLog } from '@pagespace/db/schema/security-audit';
import type { SelectSecurityAuditLog } from '@pagespace/db/schema/security-audit';
import type { QueryEventsOptions } from './security-audit';
import { deriveIndexKey } from '../encryption/blind-index';
import { auditIpBlindIndex } from '../encryption/audit-ip-crypto';
import { decryptField } from '../encryption/field-crypto';

/**
 * Query audit events with filtering options.
 * Standalone equivalent of SecurityAuditService.queryEvents().
 */
export async function queryAuditEvents(
  options: QueryEventsOptions
): Promise<SelectSecurityAuditLog[]> {
  const conditions = [];

  if (options.userId) {
    conditions.push(eq(securityAuditLog.userId, options.userId));
  }

  if (options.eventType) {
    conditions.push(eq(securityAuditLog.eventType, options.eventType));
  }

  if (options.resourceType) {
    conditions.push(eq(securityAuditLog.resourceType, options.resourceType));
  }

  if (options.resourceId) {
    conditions.push(eq(securityAuditLog.resourceId, options.resourceId));
  }

  if (options.ipAddress) {
    // Match both encrypted rows (by blind index) and legacy plaintext rows.
    const master = process.env.ENCRYPTION_KEY ?? '';
    if (master.length >= 32) {
      const bidx = auditIpBlindIndex(options.ipAddress, deriveIndexKey(master));
      conditions.push(
        or(
          eq(securityAuditLog.ipBidx, bidx),
          eq(securityAuditLog.ipAddress, options.ipAddress),
        )!,
      );
    } else {
      conditions.push(eq(securityAuditLog.ipAddress, options.ipAddress));
    }
  }

  if (options.fromTimestamp) {
    conditions.push(gte(securityAuditLog.timestamp, options.fromTimestamp));
  }

  if (options.toTimestamp) {
    conditions.push(lte(securityAuditLog.timestamp, options.toTimestamp));
  }

  const baseQuery = db
    .select()
    .from(securityAuditLog)
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(desc(securityAuditLog.timestamp));

  let rows: SelectSecurityAuditLog[];
  if (options.limit !== undefined) {
    if (!Number.isInteger(options.limit) || options.limit < 0) {
      throw new Error('limit must be a non-negative integer');
    }
    rows = await baseQuery.limit(options.limit);
  } else {
    rows = await baseQuery;
  }

  // Decrypt the at-rest IP for display. `decryptField` passes legacy plaintext
  // and null through unchanged, so mixed encrypted/plaintext rows both work.
  return Promise.all(
    rows.map(async (row) => ({ ...row, ipAddress: await decryptField(row.ipAddress) })),
  );
}
