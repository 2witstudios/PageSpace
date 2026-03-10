/**
 * Hash Chain Utilities - Tamper-evident audit logging
 *
 * SHA-256 hash chains for audit log integrity (SOC 2, HIPAA, GDPR compliance).
 * Each entry's hash includes the previous entry's hash, creating a cryptographic
 * chain that detects modification, deletion, or insertion out of order.
 */

import { db, activityLogs } from '@pagespace/db';
import { createHash, randomBytes } from 'crypto';
import { desc, isNotNull } from 'drizzle-orm';

/**
 * Hash chain data for a log entry.
 */
export interface HashChainData {
  /** Hash of the previous log entry (null for first entry in chain) */
  previousLogHash: string | null;
  /** SHA-256 hash of the current entry */
  logHash: string;
  /** Initial seed for hash chain verification (only set on first entry) */
  chainSeed: string | null;
}

/**
 * Data used to compute the hash of a log entry.
 */
export interface HashableLogData {
  id: string;
  timestamp: Date;
  userId: string;
  actorEmail: string;
  operation: string;
  resourceType: string;
  resourceId: string;
  driveId: string | null;
  pageId?: string;
  contentSnapshot?: string;
  previousValues?: Record<string, unknown>;
  newValues?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
}

/**
 * Generate a cryptographically secure random chain seed.
 * @returns 32-byte hex-encoded random seed
 */
export function generateChainSeed(): string {
  return randomBytes(32).toString('hex');
}

/**
 * Compute SHA-256 hash of data combined with previous hash.
 *
 * @param data - Serialized log entry data to hash
 * @param previousHash - Hash of the previous log entry (empty string for first entry)
 * @returns SHA-256 hash as hex string
 */
export function computeHash(data: string, previousHash: string): string {
  return createHash('sha256')
    .update(previousHash + data)
    .digest('hex');
}

/**
 * Serialize log entry data for hashing.
 * Creates a deterministic JSON string from the hashable fields.
 *
 * @param data - Log entry data to serialize
 * @returns Deterministic JSON string
 */
export function serializeLogDataForHash(data: HashableLogData): string {
  const hashableObject = {
    id: data.id,
    timestamp: data.timestamp.toISOString(),
    userId: data.userId,
    actorEmail: data.actorEmail,
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

  return JSON.stringify(hashableObject, Object.keys(hashableObject).sort());
}

/**
 * Compute hash for a log entry given its data and the previous hash.
 *
 * @param data - Log entry data
 * @param previousHash - Hash of the previous entry (empty string for first entry)
 * @returns SHA-256 hash of the entry
 */
export function computeLogHash(data: HashableLogData, previousHash: string): string {
  const serialized = serializeLogDataForHash(data);
  return computeHash(serialized, previousHash);
}

/**
 * Get the latest log hash from the database.
 * Returns null if no entries exist (starting a new chain).
 *
 * @returns Object containing the latest log hash and whether this is the first entry
 */
export async function getLatestLogHash(): Promise<{
  previousHash: string | null;
  isFirstEntry: boolean;
}> {
  try {
    const latestEntry = await db.query.activityLogs.findFirst({
      where: isNotNull(activityLogs.logHash),
      orderBy: [desc(activityLogs.timestamp)],
      columns: { logHash: true },
    });

    if (!latestEntry?.logHash) {
      return { previousHash: null, isFirstEntry: true };
    }

    return { previousHash: latestEntry.logHash, isFirstEntry: false };
  } catch (error) {
    console.error('[HashChain] Failed to get latest log hash:', error);
    return { previousHash: null, isFirstEntry: false };
  }
}

/**
 * Get the latest log hash within a transaction.
 *
 * @param tx - Database transaction
 * @returns Object containing the latest log hash and whether this is the first entry
 */
export async function getLatestLogHashWithTx(tx: typeof db): Promise<{
  previousHash: string | null;
  isFirstEntry: boolean;
}> {
  try {
    const latestEntry = await tx.query.activityLogs.findFirst({
      where: isNotNull(activityLogs.logHash),
      orderBy: [desc(activityLogs.timestamp)],
      columns: { logHash: true },
    });

    if (!latestEntry?.logHash) {
      return { previousHash: null, isFirstEntry: true };
    }

    return { previousHash: latestEntry.logHash, isFirstEntry: false };
  } catch (error) {
    console.error('[HashChain] Failed to get latest log hash in tx:', error);
    return { previousHash: null, isFirstEntry: false };
  }
}

/**
 * Compute complete hash chain data for a new log entry.
 *
 * @param logData - The log entry data to compute hash for
 * @param previousHash - Hash of the previous entry (null for first entry)
 * @param isFirstEntry - Whether this is the first entry in the chain
 * @returns Complete hash chain data for storage
 */
export function computeHashChainData(
  logData: HashableLogData,
  previousHash: string | null,
  isFirstEntry: boolean
): HashChainData {
  const chainSeed = isFirstEntry ? generateChainSeed() : null;
  const hashInput = isFirstEntry ? chainSeed! : (previousHash ?? '');

  const logHash = computeLogHash(logData, hashInput);

  return {
    previousLogHash: previousHash,
    logHash,
    chainSeed,
  };
}

/**
 * Verify that a log entry's hash is valid given its data and previous hash.
 *
 * @param logData - The log entry data
 * @param expectedHash - The hash stored in the entry
 * @param previousHash - Hash of the previous entry (or chain seed for first entry)
 * @returns true if the hash is valid
 */
export function verifyLogHash(
  logData: HashableLogData,
  expectedHash: string,
  previousHash: string
): boolean {
  const computedHash = computeLogHash(logData, previousHash);
  return computedHash === expectedHash;
}
