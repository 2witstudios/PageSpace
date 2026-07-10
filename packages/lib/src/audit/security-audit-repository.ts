/**
 * Security Audit Repository
 *
 * Transactional append machinery for the tamper-evident security audit hash
 * chain: advisory-lock serialization, chain-head lookup, and insert.
 * Extracted verbatim from SecurityAuditService.logEvent (security-audit.ts)
 * so the backend is swappable by dependency injection — Phase 0 of the
 * database decomposition epic (#890). Zero behavior change: same lock key,
 * same chain_seq head query, same 'genesis' sentinel, same hash computation.
 */

import type { db as defaultDb } from '@pagespace/db/db';
import { sql } from '@pagespace/db/operators';
import { securityAuditLog } from '@pagespace/db/schema/security-audit';
import { deriveIndexKey } from '../encryption/blind-index';
import { encryptAuditIp } from '../encryption/audit-ip-crypto';
import { computeSecurityEventHash, type AuditEvent } from './security-audit';

/**
 * Advisory lock key for serializing hash chain writes. Fixed bigint derived
 * from the string 'security_audit_chain'. pg_advisory_xact_lock holds the
 * lock until the transaction commits/rolls back. Must match
 * SecurityAuditService.CHAIN_LOCK_KEY.
 */
export const SECURITY_AUDIT_CHAIN_LOCK_KEY = 8370291546;

/**
 * Derive the blind-index key from ENCRYPTION_KEY, or null when no usable key
 * is configured (e.g. dev/test) so audit IPs fall back to plaintext storage.
 */
function auditIndexKey(): Buffer | null {
  const master = process.env.ENCRYPTION_KEY ?? '';
  return master.length >= 32 ? deriveIndexKey(master) : null;
}

type ChainHeadExecutor = Pick<typeof defaultDb, 'execute'>;

async function fetchChainHead(executor: ChainHeadExecutor): Promise<string> {
  const lastRecord = await executor.execute(sql`
    SELECT event_hash
    FROM security_audit_log
    ORDER BY chain_seq DESC
    LIMIT 1
  `);

  return (lastRecord.rows[0] as { event_hash: string } | undefined)?.event_hash ?? 'genesis';
}

export interface SecurityAuditRepositoryDeps {
  db: typeof defaultDb;
}

export interface AppendEventOptions {
  /** Override the event timestamp (default: `new Date()`). Mainly for tests. */
  now?: Date;
}

export interface SecurityAuditRepository {
  appendEvent(event: AuditEvent, opts?: AppendEventOptions): Promise<void>;
  readChainHead(): Promise<string>;
}

/**
 * Build a security audit repository backed by the given Drizzle client.
 */
export function createSecurityAuditRepository({ db }: SecurityAuditRepositoryDeps): SecurityAuditRepository {
  async function readChainHead(): Promise<string> {
    return fetchChainHead(db);
  }

  async function appendEvent(event: AuditEvent, opts: AppendEventOptions = {}): Promise<void> {
    const timestamp = opts.now ?? new Date();

    await db.transaction(async (tx) => {
      // Acquire advisory lock scoped to this transaction.
      // Blocks concurrent writers until this transaction completes.
      await tx.execute(sql`SELECT pg_advisory_xact_lock(${SECURITY_AUDIT_CHAIN_LOCK_KEY})`);

      // Read the latest hash — safe from races under the advisory lock
      const previousHash = await fetchChainHead(tx);

      const eventHash = computeSecurityEventHash(event, previousHash, timestamp);

      // GDPR #965/#969: encrypt the IP at rest + populate its blind index.
      // ipAddress is excluded from the event hash, so this is chain-safe.
      const { ipAddress: storedIp, ipBidx } = await encryptAuditIp(event.ipAddress, auditIndexKey());

      await tx.insert(securityAuditLog).values({
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
        previousHash,
        eventHash,
      });
    });
  }

  return { appendEvent, readChainHead };
}
