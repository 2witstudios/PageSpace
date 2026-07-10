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
 * (no RETURNING) — admin_app's grant is INSERT-only by design.
 *
 * NOT bound to production flow yet: the securityAudit singleton and
 * audit-log.ts stay on the advisory-lock repository until leaf 5 cuts over
 * (same staging precedent as Phase 0's readChainHead).
 */

import type { AdminDatabase } from '@pagespace/db/admin-db';
import { securityAuditIngest } from '@pagespace/db/admin-schema';
import { deriveIndexKey } from '../encryption/blind-index';
import { encryptAuditIp } from '../encryption/audit-ip-crypto';
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

export interface AuditIngestWriterDeps {
  db: AdminDatabase;
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
export function createAuditIngestWriter({ db }: AuditIngestWriterDeps): AuditIngestWriter {
  async function writeToIngest(event: AuditEvent, opts: WriteToIngestOptions = {}): Promise<void> {
    const timestamp = opts.now ?? new Date();

    const emissionHash = computeEmissionHash(event, timestamp);

    // GDPR #965/#969: encrypt the IP at rest + populate its blind index.
    // ipAddress is excluded from the emission hash, so this is chain-safe.
    const { ipAddress: storedIp, ipBidx } = await encryptAuditIp(event.ipAddress, auditIndexKey());

    await db.insert(securityAuditIngest).values({
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
  }

  return { writeToIngest };
}
