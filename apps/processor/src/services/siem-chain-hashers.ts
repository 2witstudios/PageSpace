import { createHash } from 'crypto';

/**
 * Per-source hash recomputation strategies for the SIEM delivery preflight.
 *
 * These functions are the READ-SIDE mirror of the write-side hash formulas in:
 *   - packages/lib/src/monitoring/activity-logger.ts
 *       serializeLogDataForHash / computeLogHash
 *   - packages/lib/src/audit/security-audit.ts
 *       computeSecurityEventHash
 *
 * Byte-exact equality with the write-side is a hard requirement — any
 * whitespace, key-order, or type-coercion drift would cause false tamper
 * alerts that halt SIEM delivery. The colocated test file covers this via
 * round-trip tests against the real lib functions. If the write-side ever
 * adds or removes a hashed field, those tests will fail and this module
 * must be updated to match.
 *
 * Both formulas deliberately exclude GDPR-erasable PII fields (userId,
 * actorEmail, sessionId, ipAddress, userAgent, geoLocation — varies by
 * source) so the hash chain stays verifiable after right-to-erasure. See #541.
 */

/**
 * Fields from activity_logs that participate in its hash formula. This is
 * the set that serializeLogDataForHash in packages/lib consumes — PII is
 * excluded. The caller (siem-anchor-loader) loads these from the database
 * at preflight time because the SIEM worker's mapper only pulls a subset
 * into AuditLogEntry.
 */
export interface ActivityLogHashableFields {
  id: string;
  timestamp: Date;
  operation: string;
  resourceType: string;
  resourceId: string;
  driveId: string | null;
  pageId: string | null;
  contentSnapshot: string | null;
  previousValues: Record<string, unknown> | null;
  newValues: Record<string, unknown> | null;
  metadata: Record<string, unknown> | null;
}

/**
 * Fields from security_audit_log that participate in its hash formula. PII
 * is excluded. The caller loads these from the database at preflight time
 * because Wave 1's mapper folds riskScore/anomalyFlags/details into
 * AuditLogEntry.metadata in a way that isn't cleanly reversible (the mapper
 * also substitutes defaults for null resourceType/resourceId, which would
 * break hash recomputation).
 */
export interface SecurityAuditHashableFields {
  eventType: string;
  serviceId: string | null;
  resourceType: string | null;
  resourceId: string | null;
  details: Record<string, unknown> | null;
  riskScore: number | null;
  anomalyFlags: string[] | null;
  timestamp: Date;
}

/**
 * Recompute the expected `logHash` for an activity_logs entry.
 *
 * Mirrors serializeLogDataForHash + computeLogHash in activity-logger.ts:
 *   1. Build a hashable object with fields in the exact same key set the
 *      write side uses, coercing undefined → null the same way.
 *   2. JSON.stringify with sorted keys (deterministic output).
 *   3. SHA-256 of `previousHash + serialized`.
 *
 * IMPORTANT: the order of property writes in `hashableObject` does not
 * matter because JSON.stringify is called with a sorted replacer-array
 * argument; it's the sorted-keys guarantee that makes this deterministic.
 */
export function recomputeActivityLogHash(
  data: ActivityLogHashableFields,
  previousHash: string
): string {
  const hashableObject = {
    id: data.id,
    timestamp: data.timestamp.toISOString(),
    operation: data.operation,
    resourceType: data.resourceType,
    resourceId: data.resourceId,
    driveId: data.driveId,
    pageId: data.pageId ?? null,
    contentSnapshot: data.contentSnapshot ?? null,
    previousValues: data.previousValues ?? null,
    newValues: data.newValues ?? null,
    metadata: data.metadata ?? null,
  };

  const serialized = JSON.stringify(
    hashableObject,
    Object.keys(hashableObject).sort()
  );

  return createHash('sha256').update(previousHash + serialized).digest('hex');
}

/**
 * Recompute the expected `eventHash` for a security_audit_log entry.
 *
 * Mirrors computeSecurityEventHash in security-audit.ts:
 *   - Flat JSON.stringify (no sorted-keys replacer — V8 insertion order is
 *     relied on by the write side).
 *   - SHA-256 of the serialized object; `previousHash` is a field INSIDE the
 *     serialized object, not prepended like activity_logs.
 *
 * Nullable fields map back to undefined so JSON.stringify omits them — the
 * write-side AuditEvent uses optional fields, so `undefined` at write time
 * becomes column-null in the DB. Reconstructing as `undefined` restores the
 * original serialized shape. The key order here MUST match the write-side
 * object literal exactly.
 */
export function recomputeSecurityAuditHash(
  data: SecurityAuditHashableFields,
  previousHash: string
): string {
  const serialized = JSON.stringify({
    eventType: data.eventType,
    serviceId: data.serviceId ?? undefined,
    resourceType: data.resourceType ?? undefined,
    resourceId: data.resourceId ?? undefined,
    details: data.details ?? undefined,
    riskScore: data.riskScore ?? undefined,
    anomalyFlags: data.anomalyFlags ?? undefined,
    timestamp: data.timestamp.toISOString(),
    previousHash,
  });

  return createHash('sha256').update(serialized).digest('hex');
}
