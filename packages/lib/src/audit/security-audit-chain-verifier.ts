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

import { db, securityAuditLog } from '@pagespace/db';
import { asc, count, and, gte, lte, type SQL } from 'drizzle-orm';
import { loggers } from '../logging/logger-config';
import { computeSecurityEventHash, type AuditEvent } from './security-audit';

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
  options: VerifySecurityChainOptions = {}
): Promise<SecurityChainVerificationResult> {
  const {
    limit,
    stopOnFirstBreak = true,
    batchSize = 1000,
  } = options;

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

      const entries = await db.query.securityAuditLog.findMany({
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

        // Reconstruct AuditEvent from stored fields (PII excluded from hash per #541)
        const event: AuditEvent = {
          eventType: entry.eventType as AuditEvent['eventType'],
          serviceId: entry.serviceId ?? undefined,
          resourceType: entry.resourceType ?? undefined,
          resourceId: entry.resourceId ?? undefined,
          details: entry.details ?? undefined,
          riskScore: entry.riskScore ?? undefined,
          anomalyFlags: entry.anomalyFlags ?? undefined,
        };

        // Recompute hash
        const computedHash = computeSecurityEventHash(
          event,
          entry.previousHash,
          entry.timestamp
        );

        // Check hash validity
        const hashValid = computedHash === entry.eventHash;

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
              ? 'Hash mismatch - entry data may have been modified'
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
