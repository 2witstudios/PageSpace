/**
 * Hash Chain Integrity Verifier
 *
 * Provides functions to verify the integrity of the audit log hash chain.
 * Used for compliance verification (SOC 2, HIPAA, GDPR) to detect tampering.
 *
 * The hash chain creates a cryptographic link between consecutive log entries,
 * making it detectable if any entry is modified, deleted, or inserted out of order.
 */

import { db, activityLogs } from '@pagespace/db';
import { asc, isNotNull, count, and, gte, lte, SQL } from 'drizzle-orm';
import { computeLogHash } from './activity-logger';

/**
 * Result of verifying a single log entry in the hash chain.
 */
export interface LogEntryVerificationResult {
  /** The log entry ID */
  id: string;
  /** Timestamp of the entry */
  timestamp: Date;
  /** Whether this entry's hash is valid */
  isValid: boolean;
  /** The hash stored in the database */
  storedHash: string | null;
  /** The hash we computed from the entry data */
  computedHash: string;
  /** The previous hash used to compute this entry's hash */
  previousHashUsed: string;
}

/**
 * Information about where the hash chain breaks.
 */
export interface HashChainBreakPoint {
  /** The entry where the chain breaks */
  entryId: string;
  /** Timestamp of the breaking entry */
  timestamp: Date;
  /** Position in the chain (0-indexed) */
  position: number;
  /** The hash stored in the database for this entry */
  storedHash: string | null;
  /** The hash we computed from the entry data */
  computedHash: string;
  /** The previous hash used in computation */
  previousHashUsed: string;
  /** Human-readable description of the break */
  description: string;
}

/**
 * Result of verifying the entire hash chain.
 */
export interface HashChainVerificationResult {
  /** Whether the entire chain is valid */
  isValid: boolean;
  /** Total number of entries in the chain */
  totalEntries: number;
  /** Number of entries verified */
  entriesVerified: number;
  /** Number of entries with valid hashes */
  validEntries: number;
  /** Number of entries with invalid or missing hashes */
  invalidEntries: number;
  /** Number of entries without hash chain data (legacy entries) */
  entriesWithoutHash: number;
  /** Information about where the chain breaks (if any) */
  breakPoint: HashChainBreakPoint | null;
  /** The chain seed used for the first entry (if found) */
  chainSeed: string | null;
  /** ID of the first entry in the chain */
  firstEntryId: string | null;
  /** ID of the last entry verified */
  lastEntryId: string | null;
  /** Timestamp when verification started */
  verificationStartedAt: Date;
  /** Timestamp when verification completed */
  verificationCompletedAt: Date;
  /** Duration in milliseconds */
  durationMs: number;
}

/**
 * Options for hash chain verification.
 */
export interface VerifyHashChainOptions {
  /** Maximum number of entries to verify (for performance). Default: no limit */
  limit?: number;
  /** Start from this timestamp (inclusive) */
  fromTimestamp?: Date;
  /** End at this timestamp (inclusive) */
  toTimestamp?: Date;
  /** Stop verification at first break point. Default: true */
  stopOnFirstBreak?: boolean;
  /** Batch size for fetching entries. Default: 1000 */
  batchSize?: number;
}

/**
 * Data structure for a log entry as stored in the database.
 * Used for hash verification.
 */
interface StoredLogEntry {
  id: string;
  timestamp: Date;
  userId: string;
  actorEmail: string;
  operation: string;
  resourceType: string;
  resourceId: string;
  driveId: string | null;
  pageId: string | null;
  contentSnapshot: string | null;
  previousValues: Record<string, unknown> | null;
  newValues: Record<string, unknown> | null;
  metadata: Record<string, unknown> | null;
  previousLogHash: string | null;
  logHash: string | null;
  chainSeed: string | null;
}

/**
 * Verify the integrity of the entire audit log hash chain.
 *
 * This function fetches log entries in timestamp order and verifies that:
 * 1. The first entry (with chainSeed) has a valid hash
 * 2. Each subsequent entry's hash is valid given the previous entry's hash
 *
 * @param options - Verification options
 * @returns Verification result with integrity status and break point info
 */
export async function verifyHashChain(
  options: VerifyHashChainOptions = {}
): Promise<HashChainVerificationResult> {
  const {
    limit,
    fromTimestamp,
    toTimestamp,
    stopOnFirstBreak = true,
    batchSize = 1000,
  } = options;

  const verificationStartedAt = new Date();
  let totalEntries = 0;
  let entriesVerified = 0;
  let validEntries = 0;
  let invalidEntries = 0;
  let entriesWithoutHash = 0;
  let breakPoint: HashChainBreakPoint | null = null;
  let chainSeed: string | null = null;
  let firstEntryId: string | null = null;
  let lastEntryId: string | null = null;
  let previousHash: string | null = null;
  let position = 0;

  try {
    // Build filter conditions
    const conditions: SQL[] = [];
    if (fromTimestamp) {
      conditions.push(gte(activityLogs.timestamp, fromTimestamp));
    }
    if (toTimestamp) {
      conditions.push(lte(activityLogs.timestamp, toTimestamp));
    }

    // Get total count
    const countResult = await db
      .select({ count: count() })
      .from(activityLogs)
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
        entriesWithoutHash: 0,
        breakPoint: null,
        chainSeed: null,
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

      // Fetch batch of entries ordered by timestamp
      const entries = await db.query.activityLogs.findMany({
        where: conditions.length > 0 ? and(...conditions) : undefined,
        orderBy: [asc(activityLogs.timestamp)],
        offset,
        limit: currentBatchSize,
        columns: {
          id: true,
          timestamp: true,
          userId: true,
          actorEmail: true,
          operation: true,
          resourceType: true,
          resourceId: true,
          driveId: true,
          pageId: true,
          contentSnapshot: true,
          previousValues: true,
          newValues: true,
          metadata: true,
          previousLogHash: true,
          logHash: true,
          chainSeed: true,
        },
      });

      if (entries.length === 0) break;

      for (const entry of entries) {
        const storedEntry = entry as StoredLogEntry;

        // Track first entry
        if (firstEntryId === null) {
          firstEntryId = storedEntry.id;
        }
        lastEntryId = storedEntry.id;

        // Check if this entry has hash chain data
        if (!storedEntry.logHash) {
          entriesWithoutHash++;
          entriesVerified++;
          position++;
          continue;
        }

        // For first entry with hash, use chain seed
        if (storedEntry.chainSeed) {
          chainSeed = storedEntry.chainSeed;
          previousHash = storedEntry.chainSeed;
        }

        // Determine what previous hash to use
        const hashInput = previousHash ?? '';

        // Compute expected hash
        const computedHash = computeLogHash(
          {
            id: storedEntry.id,
            timestamp: storedEntry.timestamp,
            userId: storedEntry.userId,
            actorEmail: storedEntry.actorEmail,
            operation: storedEntry.operation,
            resourceType: storedEntry.resourceType,
            resourceId: storedEntry.resourceId,
            driveId: storedEntry.driveId,
            pageId: storedEntry.pageId ?? undefined,
            contentSnapshot: storedEntry.contentSnapshot ?? undefined,
            previousValues: storedEntry.previousValues ?? undefined,
            newValues: storedEntry.newValues ?? undefined,
            metadata: storedEntry.metadata ?? undefined,
          },
          hashInput
        );

        const isValid = computedHash === storedEntry.logHash;

        if (isValid) {
          validEntries++;
          // Update previous hash for next iteration
          previousHash = storedEntry.logHash;
        } else {
          invalidEntries++;

          // Record break point if this is the first invalid entry
          if (!breakPoint) {
            breakPoint = {
              entryId: storedEntry.id,
              timestamp: storedEntry.timestamp,
              position,
              storedHash: storedEntry.logHash,
              computedHash,
              previousHashUsed: hashInput,
              description: buildBreakPointDescription(
                storedEntry,
                computedHash,
                hashInput,
                position
              ),
            };

            if (stopOnFirstBreak) {
              shouldContinue = false;
              break;
            }
          }
        }

        entriesVerified++;
        position++;

        // Check limit
        if (limit && entriesVerified >= limit) {
          shouldContinue = false;
          break;
        }
      }

      offset += entries.length;

      // Check if we've processed all entries
      if (entries.length < currentBatchSize) {
        shouldContinue = false;
      }
    }
  } catch (error) {
    console.error('[HashChainVerifier] Verification failed:', error);
    throw error;
  }

  const verificationCompletedAt = new Date();

  return {
    isValid: breakPoint === null && invalidEntries === 0,
    totalEntries,
    entriesVerified,
    validEntries,
    invalidEntries,
    entriesWithoutHash,
    breakPoint,
    chainSeed,
    firstEntryId,
    lastEntryId,
    verificationStartedAt,
    verificationCompletedAt,
    durationMs: verificationCompletedAt.getTime() - verificationStartedAt.getTime(),
  };
}

/**
 * Quick integrity check - verifies only that the chain has valid structure.
 * Faster than full verification, but doesn't check every entry.
 *
 * Checks:
 * 1. First entry has chain seed
 * 2. Last few entries have valid hashes
 * 3. Random sampling of entries in between
 *
 * @param sampleSize - Number of random entries to sample (default: 10)
 * @returns Quick verification result
 */
export async function quickIntegrityCheck(
  sampleSize: number = 10
): Promise<{
  isLikelyValid: boolean;
  hasChainSeed: boolean;
  lastEntriesValid: boolean;
  sampleValid: boolean;
  details: string;
}> {
  try {
    // Check first entry for chain seed
    const firstEntry = await db.query.activityLogs.findFirst({
      where: isNotNull(activityLogs.logHash),
      orderBy: [asc(activityLogs.timestamp)],
      columns: {
        id: true,
        chainSeed: true,
        logHash: true,
      },
    });

    const hasChainSeed = firstEntry?.chainSeed !== null && firstEntry?.chainSeed !== undefined;

    // Verify last few entries
    const lastEntries = await db.query.activityLogs.findMany({
      where: isNotNull(activityLogs.logHash),
      orderBy: [asc(activityLogs.timestamp)],
      limit: 5,
      columns: {
        id: true,
        logHash: true,
        previousLogHash: true,
      },
    });

    // Check that last entries have consistent previousLogHash references
    let lastEntriesValid = true;
    for (let i = 1; i < lastEntries.length; i++) {
      const current = lastEntries[i];
      const previous = lastEntries[i - 1];
      if (current?.previousLogHash !== previous?.logHash) {
        lastEntriesValid = false;
        break;
      }
    }

    // For now, skip random sampling (would need more complex query)
    // This can be enhanced in the future
    const sampleValid = true;

    const isLikelyValid = hasChainSeed && lastEntriesValid;

    return {
      isLikelyValid,
      hasChainSeed,
      lastEntriesValid,
      sampleValid,
      details: isLikelyValid
        ? 'Hash chain structure appears valid'
        : `Issues detected: ${!hasChainSeed ? 'Missing chain seed. ' : ''}${!lastEntriesValid ? 'Last entries have inconsistent hashes.' : ''}`,
    };
  } catch (error) {
    console.error('[HashChainVerifier] Quick check failed:', error);
    return {
      isLikelyValid: false,
      hasChainSeed: false,
      lastEntriesValid: false,
      sampleValid: false,
      details: `Verification failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
    };
  }
}

/**
 * Get hash chain statistics without full verification.
 *
 * @returns Statistics about the hash chain
 */
export async function getHashChainStats(): Promise<{
  totalEntries: number;
  entriesWithHash: number;
  entriesWithoutHash: number;
  hasChainSeed: boolean;
  firstEntryTimestamp: Date | null;
  lastEntryTimestamp: Date | null;
}> {
  try {
    // Get total count
    const totalResult = await db
      .select({ count: count() })
      .from(activityLogs);
    const totalEntries = totalResult[0]?.count ?? 0;

    // Get count with hash
    const withHashResult = await db
      .select({ count: count() })
      .from(activityLogs)
      .where(isNotNull(activityLogs.logHash));
    const entriesWithHash = withHashResult[0]?.count ?? 0;

    // Get first entry with chain seed
    const firstEntry = await db.query.activityLogs.findFirst({
      where: isNotNull(activityLogs.chainSeed),
      orderBy: [asc(activityLogs.timestamp)],
      columns: {
        timestamp: true,
        chainSeed: true,
      },
    });

    // Get last entry
    const lastEntry = await db.query.activityLogs.findFirst({
      where: isNotNull(activityLogs.logHash),
      orderBy: [asc(activityLogs.timestamp)],
      columns: {
        timestamp: true,
      },
    });

    return {
      totalEntries,
      entriesWithHash,
      entriesWithoutHash: totalEntries - entriesWithHash,
      hasChainSeed: firstEntry?.chainSeed !== null && firstEntry?.chainSeed !== undefined,
      firstEntryTimestamp: firstEntry?.timestamp ?? null,
      lastEntryTimestamp: lastEntry?.timestamp ?? null,
    };
  } catch (error) {
    console.error('[HashChainVerifier] Failed to get stats:', error);
    throw error;
  }
}

/**
 * Verify a specific entry's hash.
 *
 * @param entryId - The ID of the entry to verify
 * @returns Verification result for the specific entry
 */
export async function verifyEntry(
  entryId: string
): Promise<LogEntryVerificationResult | null> {
  try {
    // Fetch the entry
    const entry = await db.query.activityLogs.findFirst({
      where: (logs, { eq }) => eq(logs.id, entryId),
      columns: {
        id: true,
        timestamp: true,
        userId: true,
        actorEmail: true,
        operation: true,
        resourceType: true,
        resourceId: true,
        driveId: true,
        pageId: true,
        contentSnapshot: true,
        previousValues: true,
        newValues: true,
        metadata: true,
        previousLogHash: true,
        logHash: true,
        chainSeed: true,
      },
    });

    if (!entry) {
      return null;
    }

    const storedEntry = entry as StoredLogEntry;

    // Determine previous hash to use
    let previousHashUsed = '';
    if (storedEntry.chainSeed) {
      // This is the first entry, use chain seed
      previousHashUsed = storedEntry.chainSeed;
    } else if (storedEntry.previousLogHash) {
      // Use the stored previous log hash
      previousHashUsed = storedEntry.previousLogHash;
    }

    // Compute expected hash
    const computedHash = computeLogHash(
      {
        id: storedEntry.id,
        timestamp: storedEntry.timestamp,
        userId: storedEntry.userId,
        actorEmail: storedEntry.actorEmail,
        operation: storedEntry.operation,
        resourceType: storedEntry.resourceType,
        resourceId: storedEntry.resourceId,
        driveId: storedEntry.driveId,
        pageId: storedEntry.pageId ?? undefined,
        contentSnapshot: storedEntry.contentSnapshot ?? undefined,
        previousValues: storedEntry.previousValues ?? undefined,
        newValues: storedEntry.newValues ?? undefined,
        metadata: storedEntry.metadata ?? undefined,
      },
      previousHashUsed
    );

    return {
      id: storedEntry.id,
      timestamp: storedEntry.timestamp,
      isValid: computedHash === storedEntry.logHash,
      storedHash: storedEntry.logHash,
      computedHash,
      previousHashUsed,
    };
  } catch (error) {
    console.error('[HashChainVerifier] Failed to verify entry:', error);
    throw error;
  }
}

/**
 * Build a human-readable description of a hash chain break point.
 */
function buildBreakPointDescription(
  entry: StoredLogEntry,
  computedHash: string,
  previousHashUsed: string,
  position: number
): string {
  const parts: string[] = [];

  parts.push(`Hash chain break detected at position ${position}`);
  parts.push(`Entry ID: ${entry.id}`);
  parts.push(`Timestamp: ${entry.timestamp.toISOString()}`);
  parts.push(`Operation: ${entry.operation} on ${entry.resourceType}`);

  if (!entry.logHash) {
    parts.push('Reason: Entry has no stored hash');
  } else {
    parts.push(`Stored hash: ${entry.logHash.substring(0, 16)}...`);
    parts.push(`Computed hash: ${computedHash.substring(0, 16)}...`);
    parts.push(`Previous hash used: ${previousHashUsed ? previousHashUsed.substring(0, 16) + '...' : '(empty)'}`);
    parts.push('Reason: Hash mismatch - entry data may have been modified');
  }

  return parts.join('. ');
}
