import { createHash } from 'crypto';

// Mirrors the stableStringify helper in packages/lib — sorts object keys at
// every depth so key insertion order (e.g. Postgres JSONB round-trip) never
// changes the serialized output.
function stableStringify(value: unknown): string {
  return JSON.stringify(value, (_, v) =>
    v !== null && typeof v === 'object' && !Array.isArray(v)
      ? Object.fromEntries(Object.keys(v).sort().map(k => [k, v[k]]))
      : v
  );
}

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
 *   1. Build hashable object with the same field set (PII excluded).
 *   2. stableStringify — sorts keys at every depth for deterministic output.
 *   3. SHA-256 of `previousHash + serialized`.
 */
export function recomputeActivityLogHash(
  data: ActivityLogHashableFields,
  previousHash: string
): string {
  const serialized = stableStringify({
    contentSnapshot: data.contentSnapshot ?? null,
    driveId: data.driveId,
    id: data.id,
    metadata: data.metadata ?? null,
    newValues: data.newValues ?? null,
    operation: data.operation,
    pageId: data.pageId ?? null,
    previousValues: data.previousValues ?? null,
    resourceId: data.resourceId,
    resourceType: data.resourceType,
    timestamp: data.timestamp.toISOString(),
  });

  return createHash('sha256').update(previousHash + serialized).digest('hex');
}

/**
 * Recompute the expected `eventHash` for a security_audit_log entry.
 *
 * Mirrors computeSecurityEventHash in security-audit.ts:
 *   - stableStringify sorts keys at every depth (including inside `details`).
 *   - SHA-256 of the serialized object; `previousHash` is a field INSIDE the
 *     serialized object, not prepended like activity_logs.
 *   - Nullable DB columns normalize to null (not undefined) — the write side
 *     uses `?? null` so JSON.stringify includes them explicitly.
 */
export function recomputeSecurityAuditHash(
  data: SecurityAuditHashableFields,
  previousHash: string
): string {
  const serialized = stableStringify({
    anomalyFlags: data.anomalyFlags ?? null,
    details: data.details ?? null,
    eventType: data.eventType,
    previousHash,
    resourceId: data.resourceId ?? null,
    resourceType: data.resourceType ?? null,
    riskScore: data.riskScore ?? null,
    serviceId: data.serviceId ?? null,
    timestamp: data.timestamp.toISOString(),
  });

  return createHash('sha256').update(serialized).digest('hex');
}
