/**
 * Audit Ingest Writer — lock-free emission shell (#890 Phase 2, leaf 1).
 *
 * Replaces the advisory-lock append path for the request-side write:
 * encrypt the IP, compute the pure emission hash (emission-hash.ts), and do
 * ONE INSERT into security_audit_ingest on the Admin PG. No transaction, no
 * pg_advisory_xact_lock, no chain-head read — chaining (chain_seq +
 * chainHash) is the single-writer chainer's job (leaf 2).
 *
 * Fire-and-forget compatible: errors propagate to the caller; the audit()
 * wrapper in audit-log.ts already catches. The insert never reads back
 * (no RETURNING) — admin_app's grant is INSERT-only by design; the row id
 * is generated HERE (same cuid2 as the schema default) so the witness
 * co-stream can carry it without a read-back.
 *
 * Witness co-stream (leaf 4): after a successful INSERT, ONE structured
 * security-category log line carries the PII-free witness record
 * (co-stream.ts) to stdout → the log collector — the second independent
 * record the database credentials cannot touch. Best-effort by design:
 * a throwing logger never fails the write, and a failed insert is never
 * witnessed.
 *
 * NOT bound to production flow yet: the securityAudit singleton and
 * audit-log.ts stay on the advisory-lock repository until leaf 5 cuts over
 * (same staging precedent as Phase 0's readChainHead).
 */

import { createId } from '@paralleldrive/cuid2';
import type { AdminDatabase } from '@pagespace/db/admin-db';
import { securityAuditIngest } from '@pagespace/db/admin-schema';
import { deriveIndexKey } from '../encryption/blind-index';
import { encryptAuditIp } from '../encryption/audit-ip-crypto';
import { loggers } from '../logging/logger-config';
import { buildCoStreamRecord, CO_STREAM_LOG_MESSAGE, type CoStreamRecord } from './co-stream';
import { computeEmissionHash } from './emission-hash';
import type { AuditEvent } from './security-audit';

/**
 * Derive the blind-index key from ENCRYPTION_KEY, or null when no usable key
 * is configured (e.g. dev/test) so audit IPs fall back to plaintext storage.
 * Mirrors security-audit-repository.ts — the emission path must encrypt
 * exactly like the append path it replaces.
 */
function auditIndexKey(): Buffer | null {
  const master = process.env.ENCRYPTION_KEY ?? '';
  return master.length >= 32 ? deriveIndexKey(master) : null;
}

/** The one logger surface the co-stream needs — LogInput-compatible metadata. */
export interface CoStreamLogger {
  info(message: string, metadata?: CoStreamRecord): void;
}

export interface AuditIngestWriterDeps {
  db: AdminDatabase;
  /**
   * Structured logger for the witness line. Defaults to the security
   * category of the shared logger, whose LOG_DESTINATION semantics put the
   * line on stdout under both 'stdout' (immediate) and 'both' (flushed).
   */
  coStreamLogger?: CoStreamLogger;
}

export interface WriteToIngestOptions {
  /** Override the event timestamp (default: `new Date()`). Mainly for tests. */
  now?: Date;
}

export interface AuditIngestWriter {
  writeToIngest(event: AuditEvent, opts?: WriteToIngestOptions): Promise<void>;
}

/**
 * Build an audit ingest writer backed by the given Admin PG client.
 */
export function createAuditIngestWriter({
  db,
  coStreamLogger = loggers.security,
}: AuditIngestWriterDeps): AuditIngestWriter {
  async function writeToIngest(event: AuditEvent, opts: WriteToIngestOptions = {}): Promise<void> {
    const timestamp = opts.now ?? new Date();

    const emissionHash = computeEmissionHash(event, timestamp);

    // Generated here instead of by the column default: the co-stream record
    // must carry the row id, and INSERT-only grants forbid a read-back.
    const eventId = createId();

    // GDPR #965/#969: encrypt the IP at rest + populate its blind index.
    // ipAddress is excluded from the emission hash, so this is chain-safe.
    const { ipAddress: storedIp, ipBidx } = await encryptAuditIp(event.ipAddress, auditIndexKey());

    await db.insert(securityAuditIngest).values({
      id: eventId,
      eventType: event.eventType,
      userId: event.userId,
      sessionId: event.sessionId,
      serviceId: event.serviceId,
      resourceType: event.resourceType,
      resourceId: event.resourceId,
      ipAddress: storedIp,
      ipBidx,
      userAgent: event.userAgent,
      geoLocation: event.geoLocation,
      details: event.details,
      riskScore: event.riskScore,
      anomalyFlags: event.anomalyFlags,
      timestamp,
      emissionHash,
    });

    // Witness co-stream: only after the store accepted the event, and never
    // able to fail the write — a lost witness line is a collector gap the
    // reconciliation reports, not a lost audit event.
    try {
      coStreamLogger.info(
        CO_STREAM_LOG_MESSAGE,
        buildCoStreamRecord({ eventId, emissionHash, eventType: event.eventType, emittedAt: timestamp }),
      );
    } catch {
      // Best-effort witness — log-internal errors are swallowed by design.
    }
  }

  return { writeToIngest };
}
