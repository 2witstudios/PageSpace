import type { AuditLogSource } from '../services/siem-adapter';
import type {
  ActivityLogHashableFields,
  SecurityAuditHashableFields,
} from '../services/siem-chain-hashers';
import { CURSOR_INIT_SENTINEL } from './siem-delivery-worker-constants';

/**
 * DB-side loaders for the SIEM chain verification preflight.
 *
 * These are the only pieces of preflight that actually touch the database.
 * The verifier (siem-chain-verifier.ts) and the hashers (siem-chain-hashers.ts)
 * are pure. This module exists so the worker can ask two questions at
 * preflight time:
 *
 *   1. "What is the anchor hash for this source?" — i.e. the logHash/eventHash
 *      of the row the cursor currently points at, which the first entry of
 *      the incoming batch must chain to.
 *
 *   2. "What is the full hashable row data for each entry in the batch?" —
 *      the SIEM worker's mapper drops fields that the write-side uses when
 *      computing the hash (contentSnapshot/previousValues/newValues for
 *      activity_logs; raw serviceId/resourceType/riskScore/etc. for
 *      security_audit_log, because the Wave 1 mapper folds and defaults them).
 *      Loading the hashable subset separately lets us verify without touching
 *      the mapper at all.
 */

interface PgClient {
  query(
    text: string,
    params?: unknown[]
  ): Promise<{ rows: Record<string, unknown>[]; rowCount: number | null }>;
}

/**
 * Load the anchor hash for a source — the logHash of the row identified
 * by cursor.lastDeliveredId. Returns null when:
 *   - lastDeliveredId is the CURSOR_INIT_SENTINEL (fresh cursor, nothing
 *     was ever delivered for this source → the caller skips verification)
 *   - the anchor row can no longer be found (pruned? deleted?) — we log a
 *     warn so an operator notices, but we don't halt delivery; a null
 *     anchor is treated the same as fresh init so the next batch ships.
 */
export async function loadAnchorHash(
  client: PgClient,
  source: AuditLogSource,
  lastDeliveredId: string
): Promise<string | null> {
  if (lastDeliveredId === CURSOR_INIT_SENTINEL) {
    return null;
  }

  const result =
    source === 'activity_logs'
      ? await client.query(
          'SELECT "logHash" FROM activity_logs WHERE id = $1',
          [lastDeliveredId]
        )
      : await client.query(
          'SELECT event_hash AS "logHash" FROM security_audit_log WHERE id = $1',
          [lastDeliveredId]
        );

  const row = result.rows[0] as { logHash: string | null } | undefined;
  if (!row) {
    console.warn(
      `[siem-delivery] Anchor row not found source=${source} id=${lastDeliveredId} — treating as fresh init`
    );
    return null;
  }

  return row.logHash;
}

/**
 * Bulk-load the hash-relevant subset of activity_logs rows by id. Uses
 * `WHERE id = ANY($1)` to send a single round-trip regardless of batch size.
 * The returned map preserves nothing about DB order — the caller reorders
 * via the original entry ids.
 */
export async function loadActivityLogHashableFields(
  client: PgClient,
  ids: string[]
): Promise<Map<string, ActivityLogHashableFields>> {
  if (ids.length === 0) {
    return new Map();
  }

  const result = await client.query(
    `SELECT id, timestamp, operation, "resourceType", "resourceId",
            "driveId", "pageId", "contentSnapshot", "previousValues",
            "newValues", metadata
     FROM activity_logs
     WHERE id = ANY($1)`,
    [ids]
  );

  const map = new Map<string, ActivityLogHashableFields>();
  for (const raw of result.rows) {
    const row = raw as {
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
    };
    map.set(row.id, {
      id: row.id,
      timestamp: row.timestamp,
      operation: row.operation,
      resourceType: row.resourceType,
      resourceId: row.resourceId,
      driveId: row.driveId,
      pageId: row.pageId,
      contentSnapshot: row.contentSnapshot,
      previousValues: row.previousValues,
      newValues: row.newValues,
      metadata: row.metadata,
    });
  }

  return map;
}

/**
 * Bulk-load the hash-relevant subset of security_audit_log rows by id.
 *
 * Deliberately pulls the RAW columns, not the Wave 1 mapper's AuditLogEntry
 * shape — that mapper substitutes defaults for null resourceType/resourceId
 * and folds fields into metadata, both of which would corrupt hash
 * recomputation. This loader stays coupled to the DB column names so the
 * formula in siem-chain-hashers.ts can mirror the write side byte-exactly.
 */
export async function loadSecurityAuditHashableFields(
  client: PgClient,
  ids: string[]
): Promise<Map<string, SecurityAuditHashableFields>> {
  if (ids.length === 0) {
    return new Map();
  }

  const result = await client.query(
    `SELECT id,
            event_type AS "eventType",
            service_id AS "serviceId",
            resource_type AS "resourceType",
            resource_id AS "resourceId",
            details,
            risk_score AS "riskScore",
            anomaly_flags AS "anomalyFlags",
            timestamp
     FROM security_audit_log
     WHERE id = ANY($1)`,
    [ids]
  );

  const map = new Map<string, SecurityAuditHashableFields>();
  for (const raw of result.rows) {
    const row = raw as {
      id: string;
      eventType: string;
      serviceId: string | null;
      resourceType: string | null;
      resourceId: string | null;
      details: Record<string, unknown> | null;
      riskScore: number | null;
      anomalyFlags: string[] | null;
      timestamp: Date;
    };
    map.set(row.id, {
      eventType: row.eventType,
      serviceId: row.serviceId,
      resourceType: row.resourceType,
      resourceId: row.resourceId,
      details: row.details,
      riskScore: row.riskScore,
      anomalyFlags: row.anomalyFlags,
      timestamp: row.timestamp,
    });
  }

  return map;
}
