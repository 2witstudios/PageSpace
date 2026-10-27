/**
 * Security Audit Hash Chain Verifier
 *
 * Verifies the integrity of the security audit log hash chain.
 * Each entry's eventHash is recomputed from stored fields and compared
 * to the stored value. Chain links (previousHash) are also validated.
 *
 * Modeled on the activity log hash-chain-verifier but uses:
 * - securityAuditLog table (not activityLogs)
 * - computeSecurityEventHash (not computeLogHash)
 * - 'genesis' as the chain start (no chainSeed concept)
 */

import { securityAuditLog } from '@pagespace/db/schema/security-audit';
import { asc, count, and, gte, lte, type SQL } from 'drizzle-orm';
import { loggers } from '../logging/logger-config';
import { computeSecurityEventHash, type AuditEvent } from './security-audit';
import { computeEmissionHash } from './emission-hash';
import { computeChainHash } from './chain-step';
import type { AdminDatabase } from '@pagespace/db/admin-db';
import type { SecurityAuditDatabase } from './security-audit-repository';
import { resolveAuditDbBinding } from './audit-db-binding';

export interface SecurityChainBreakPoint {
  entryId: string;
  timestamp: Date;
  position: number;
  storedHash: string;
  computedHash: string;
  previousHashUsed: string;
  description: string;
}

export interface SecurityChainVerificationResult {
  isValid: boolean;
  totalEntries: number;
  entriesVerified: number;
  validEntries: number;
  invalidEntries: number;
  breakPoint: SecurityChainBreakPoint | null;
  firstEntryId: string | null;
  lastEntryId: string | null;
  verificationStartedAt: Date;
  verificationCompletedAt: Date;
  durationMs: number;
}

export interface VerifySecurityChainOptions {
  limit?: number;
  fromTimestamp?: Date;
  toTimestamp?: Date;
  stopOnFirstBreak?: boolean;
  batchSize?: number;
}

export interface VerifySecurityChainDeps {
  /**
   * Drizzle client to read from — the main app db or the Admin PG client.
   * Defaults to the resolved audit binding (#890 Phase 2, leaf 5): the
   * Admin PG when dedicated, the main db under break-glass. Until the
   * backfill leaf migrates legacy rows, the default in dedicated mode
   * verifies only the post-cutover chain.
   */
  db?: SecurityAuditDatabase;
}

/**
 * Stored entry shape used for verification.
 */
interface StoredSecurityEntry {
  id: string;
  eventType: string;
  userId: string | null;
  sessionId: string | null;
  serviceId: string | null;
  resourceType: string | null;
  resourceId: string | null;
  ipAddress: string | null;
  userAgent: string | null;
  geoLocation: string | null;
  details: Record<string, unknown> | null;
  riskScore: number | null;
  anomalyFlags: string[] | null;
  timestamp: Date;
  previousHash: string;
  eventHash: string;
  /**
   * Chainer-era rows (#890 Phase 2) carry the emission hash; legacy rows
   * read as null (admin plane) or undefined (main plane, no such column).
   */
  emissionHash?: string | null;
}

export interface StoredEntryHashCheck {
  hashValid: boolean;
  /** The event hash this entry SHOULD carry — reported on break points. */
  computedHash: string;
  /** Human description of the mismatch; null when valid. */
  reason: string | null;
}

/**
 * Era-aware per-row hash verification (#890 Phase 2, leaf 5). Pure.
 *
 * Chainer-era rows (emission_hash present) are verified with chain-step
 * semantics: the emission hash is RECOMPUTED from the stored payload
 * (payload tamper detection), compared to the stored emission_hash (witness
 * column tamper detection), and event_hash must equal
 * H(emission_hash, previous_hash). Legacy rows (no emission_hash) keep the
 * original computeSecurityEventHash check. Chain LINKAGE (previousHash vs
 * the prior row's eventHash) is era-independent and stays with the caller.
 */
export function verifyStoredEntryHash(entry: StoredSecurityEntry): StoredEntryHashCheck {
  // Reconstruct the hashed event from stored fields (PII excluded per #541)
  const event: AuditEvent = {
    eventType: entry.eventType as AuditEvent['eventType'],
    serviceId: entry.serviceId ?? undefined,
    resourceType: entry.resourceType ?? undefined,
    resourceId: entry.resourceId ?? undefined,
    details: entry.details ?? undefined,
    riskScore: entry.riskScore ?? undefined,
    anomalyFlags: entry.anomalyFlags ?? undefined,
  };

  if (entry.emissionHash !== null && entry.emissionHash !== undefined) {
    const recomputedEmission = computeEmissionHash(event, entry.timestamp);
    const expectedEventHash = computeChainHash(recomputedEmission, entry.previousHash);

    if (recomputedEmission !== entry.emissionHash) {
      return {
        hashValid: false,
        computedHash: expectedEventHash,
        reason:
          'Emission hash mismatch - entry data or the stored emission_hash may have been modified',
      };
    }
    if (expectedEventHash !== entry.eventHash) {
      return {
        hashValid: false,
        computedHash: expectedEventHash,
        reason:
          'Chain hash mismatch - event_hash does not equal H(emission_hash, previous_hash)',
      };
    }
    return { hashValid: true, computedHash: expectedEventHash, reason: null };
  }

  const computedHash = computeSecurityEventHash(event, entry.previousHash, entry.timestamp);
  return computedHash === entry.eventHash
    ? { hashValid: true, computedHash, reason: null }
    : {
        hashValid: false,
        computedHash,
        reason: 'Hash mismatch - entry data may have been modified',
      };
}

/**
 * Verify the integrity of the security audit log hash chain.
 *
 * For each entry:
 * 1. Reconstruct the AuditEvent from stored fields
 * 2. Recompute the hash using computeSecurityEventHash(event, previousHash, timestamp)
 * 3. Compare to stored eventHash
 * 4. Verify previousHash matches the prior entry's eventHash (chain-link check)
 */
export async function verifySecurityAuditChain(
  options: VerifySecurityChainOptions = {},
  deps: VerifySecurityChainDeps = {}
): Promise<SecurityChainVerificationResult> {
  const {
    limit,
    stopOnFirstBreak = true,
    batchSize = 1000,
  } = options;
  const db = deps.db ?? resolveAuditDbBinding().db;

  const verificationStartedAt = new Date();
  let totalEntries = 0;
  let entriesVerified = 0;
  let validEntries = 0;
  let invalidEntries = 0;
  let breakPoint: SecurityChainBreakPoint | null = null;
  let firstEntryId: string | null = null;
  let lastEntryId: string | null = null;
  let previousEntryHash: string | null = null;
  let position = 0;

  try {
    // Build filter conditions
    const conditions: SQL[] = [];
    if (options.fromTimestamp) {
      conditions.push(gte(securityAuditLog.timestamp, options.fromTimestamp));
    }
    if (options.toTimestamp) {
      conditions.push(lte(securityAuditLog.timestamp, options.toTimestamp));
    }

    // Get total count (needed for reporting when limit is used)
    const countResult = await db
      .select({ count: count() })
      .from(securityAuditLog)
      .where(conditions.length > 0 ? and(...conditions) : undefined);
    totalEntries = countResult[0]?.count ?? 0;

    if (totalEntries === 0) {
      const verificationCompletedAt = new Date();
      return {
        isValid: true,
        totalEntries: 0,
        entriesVerified: 0,
        validEntries: 0,
        invalidEntries: 0,
        breakPoint: null,
        firstEntryId: null,
        lastEntryId: null,
        verificationStartedAt,
        verificationCompletedAt,
        durationMs: verificationCompletedAt.getTime() - verificationStartedAt.getTime(),
      };
    }

    // Process in batches
    let offset = 0;
    let shouldContinue = true;

    while (shouldContinue) {
      const currentBatchSize = limit
        ? Math.min(batchSize, limit - entriesVerified)
        : batchSize;

      if (currentBatchSize <= 0) break;

      // Both union members expose query.securityAuditLog over the same table,
      // but their .d.ts signatures don't unify into a callable union when lib
      // builds against packages/db/dist. Narrow to the AdminDatabase view —
      // the least capable of the two (no relations) — which cannot widen what
      // this call can do.
      const entries = await (db as AdminDatabase).query.securityAuditLog.findMany({
        where: conditions.length > 0 ? and(...conditions) : undefined,
        orderBy: [asc(securityAuditLog.chainSeq)],
        offset,
        limit: currentBatchSize,
      });

      if (entries.length === 0) break;

      for (const rawEntry of entries) {
        const entry = rawEntry as StoredSecurityEntry;

        if (firstEntryId === null) {
          firstEntryId = entry.id;
        }
        lastEntryId = entry.id;

        // Era-aware hash check: chain-step semantics for chainer-era rows,
        // computeSecurityEventHash for legacy rows (#890 Phase 2, leaf 5).
        const hashCheck = verifyStoredEntryHash(entry);
        const computedHash = hashCheck.computedHash;
        const hashValid = hashCheck.hashValid;

        // Check chain-link validity (previousHash should match prior entry's eventHash)
        const chainLinkValid = previousEntryHash === null
          || entry.previousHash === previousEntryHash;

        const isValid = hashValid && chainLinkValid;

        if (isValid) {
          validEntries++;
          previousEntryHash = entry.eventHash;
        } else {
          invalidEntries++;

          if (!breakPoint) {
            const reason = !hashValid
              ? hashCheck.reason ?? 'Hash mismatch - entry data may have been modified'
              : 'Chain link broken - previousHash does not match prior entry eventHash';

            breakPoint = {
              entryId: entry.id,
              timestamp: entry.timestamp,
              position,
              storedHash: entry.eventHash,
              computedHash,
              previousHashUsed: entry.previousHash,
              description: `Security audit chain break at position ${position}. Entry ID: ${entry.id}. ${reason}`,
            };

            if (stopOnFirstBreak) {
              shouldContinue = false;
              break;
            }
          }

          previousEntryHash = entry.eventHash;
        }

        entriesVerified++;
        position++;

        if (limit && entriesVerified >= limit) {
          shouldContinue = false;
          break;
        }
      }

      offset += entries.length;

      if (entries.length < currentBatchSize) {
        shouldContinue = false;
      }
    }
  } catch (error) {
    loggers.security.error('[SecurityAuditChainVerifier] Verification failed:', { error });
    throw error;
  }

  const verificationCompletedAt = new Date();

  return {
    isValid: breakPoint === null && invalidEntries === 0,
    totalEntries,
    entriesVerified,
    validEntries,
    invalidEntries,
    breakPoint,
    firstEntryId,
    lastEntryId,
    verificationStartedAt,
    verificationCompletedAt,
    durationMs: verificationCompletedAt.getTime() - verificationStartedAt.getTime(),
  };
}
