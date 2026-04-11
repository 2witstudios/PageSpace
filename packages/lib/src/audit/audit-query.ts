/**
 * Standalone audit query function.
 *
 * Extracts the query logic from SecurityAuditService into a plain function
 * so callers don't need a class instance or initialization ceremony.
 */

import { db, securityAuditLog, desc, and, gte, lte, eq } from '@pagespace/db';
import type { SelectSecurityAuditLog } from '@pagespace/db';
import type { QueryEventsOptions } from './security-audit';

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
    conditions.push(eq(securityAuditLog.ipAddress, options.ipAddress));
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

  if (options.limit) {
    return baseQuery.limit(options.limit);
  }

  return baseQuery;
}
