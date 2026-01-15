/**
 * Activity Logger - Enterprise-grade audit trail for PageSpace
 *
 * Fire-and-forget async logging with zero performance impact.
 * Designed for auditability with future rollback support.
 * Includes hash chain computation for tamper-evidence (SOC 2, HIPAA, GDPR compliance).
 */

import { db, activityLogs, users, eq } from '@pagespace/db';
import { createId } from '@paralleldrive/cuid2';
import { createHash, randomBytes } from 'crypto';
import { desc, isNotNull } from 'drizzle-orm';

/**
 * Actor info for audit logging - snapshotted at write time
 */
export interface ActorInfo {
  actorEmail: string;
  actorDisplayName?: string;
}

/**
 * Fetch actor info from database for audit logging.
 * Returns email and display name for the given user ID.
 * Falls back to 'unknown@system' if user not found (shouldn't happen).
 */
export async function getActorInfo(userId: string): Promise<ActorInfo> {
  try {
    const user = await db.query.users.findFirst({
      where: eq(users.id, userId),
      columns: { email: true, name: true },
    });

    if (!user) {
      console.warn(`[ActivityLogger] User ${userId} not found for actor info`);
      return { actorEmail: 'unknown@system' };
    }

    return {
      actorEmail: user.email,
      actorDisplayName: user.name ?? undefined,
    };
  } catch (error) {
    console.error('[ActivityLogger] Failed to fetch actor info:', error);
    return { actorEmail: 'unknown@system' };
  }
}

// =============================================================================
// HASH CHAIN COMPUTATION UTILITIES
// =============================================================================
// These utilities provide tamper-evident audit logging using SHA-256 hash chains.
// Each log entry's hash includes the previous entry's hash, creating a chain
// that makes it cryptographically detectable if any entry is modified or deleted.

/**
 * Hash chain data for a log entry.
 * Contains all fields needed to store hash chain metadata.
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
 * Includes immutable fields that define the entry's content.
 */
interface HashableLogData {
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
 * Used to initialize a new hash chain.
 * @returns 32-byte hex-encoded random seed
 */
export function generateChainSeed(): string {
  return randomBytes(32).toString('hex');
}

/**
 * Compute SHA-256 hash of data combined with previous hash.
 * This creates the cryptographic chain linking each entry to its predecessor.
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
 * Uses sorted keys to ensure consistent hash computation.
 *
 * @param data - Log entry data to serialize
 * @returns Deterministic JSON string
 */
export function serializeLogDataForHash(data: HashableLogData): string {
  // Create object with sorted keys for deterministic serialization
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

  // JSON.stringify with sorted keys for deterministic output
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
 * Used to fetch the previous hash when inserting a new entry.
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
    console.error('[ActivityLogger] Failed to get latest log hash:', error);
    // Return null on error - allows logging to continue without hash chain
    // The hash chain can be repaired later if needed
    return { previousHash: null, isFirstEntry: false };
  }
}

/**
 * Get the latest log hash within a transaction.
 * Used for atomic hash chain computation during transactional inserts.
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
    console.error('[ActivityLogger] Failed to get latest log hash in tx:', error);
    return { previousHash: null, isFirstEntry: false };
  }
}

/**
 * Compute complete hash chain data for a new log entry.
 * Handles both first entries (with chain seed) and subsequent entries.
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
  // For first entry, generate chain seed and use it as the previous hash basis
  const chainSeed = isFirstEntry ? generateChainSeed() : null;
  const hashInput = isFirstEntry ? chainSeed! : (previousHash ?? '');

  // Compute the hash of this entry
  const logHash = computeLogHash(logData, hashInput);

  return {
    previousLogHash: previousHash,
    logHash,
    chainSeed,
  };
}

/**
 * Verify that a log entry's hash is valid given its data and previous hash.
 * Used for integrity checking.
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

// =============================================================================
// END HASH CHAIN COMPUTATION UTILITIES
// =============================================================================

// Type definitions matching the database schema
export type ActivityOperation =
  | 'create'
  | 'update'
  | 'delete'
  | 'restore'
  | 'reorder'
  | 'permission_grant'
  | 'permission_update'
  | 'permission_revoke'
  | 'trash'
  | 'move'
  | 'agent_config_update'
  // Membership operations
  | 'member_add'
  | 'member_remove'
  | 'member_role_change'
  // Authentication/Security operations
  | 'login'
  | 'logout'
  | 'signup'
  | 'password_change'
  | 'email_change'
  | 'token_create'
  | 'token_revoke'
  // File operations
  | 'upload'
  | 'convert'
  // Account operations
  | 'account_delete'
  | 'profile_update'
  | 'avatar_update'
  // Message operations (Tier 1)
  | 'message_update'
  | 'message_delete'
  // Role operations (Tier 1)
  | 'role_reorder'
  // Drive ownership operations (Tier 1)
  | 'ownership_transfer'
  // Version history operations
  | 'rollback'
  // AI conversation undo operations
  | 'conversation_undo'
  | 'conversation_undo_with_changes';

export type ActivityResourceType =
  | 'page'
  | 'drive'
  | 'permission'
  | 'agent'
  | 'user'
  | 'member'
  | 'role'
  | 'file'
  | 'token'
  | 'device'
  // Message resource (Tier 1)
  | 'message'
  // AI conversation resource
  | 'conversation';

export interface ActivityLogInput {
  userId: string;
  operation: ActivityOperation;
  resourceType: ActivityResourceType;
  resourceId: string;
  resourceTitle?: string;
  driveId: string | null;
  pageId?: string;

  // Actor snapshot - denormalized for audit trail preservation after user deletion
  actorEmail: string;
  actorDisplayName?: string;

  // AI attribution
  isAiGenerated?: boolean;
  aiProvider?: string;
  aiModel?: string;
  aiConversationId?: string;

  // Content & change tracking
  contentSnapshot?: string;
  contentFormat?: 'text' | 'html' | 'json' | 'tiptap';
  contentRef?: string;
  contentSize?: number;
  updatedFields?: string[];
  previousValues?: Record<string, unknown>;
  newValues?: Record<string, unknown>;
  metadata?: Record<string, unknown>;

  // Deterministic stream metadata
  streamId?: string;
  streamSeq?: number;
  changeGroupId?: string;
  changeGroupType?: 'user' | 'ai' | 'automation' | 'system';
  stateHashBefore?: string;
  stateHashAfter?: string;

  // Rollback support - denormalized source info for audit trail preservation
  rollbackFromActivityId?: string;
  rollbackSourceOperation?: ActivityOperation;
  rollbackSourceTimestamp?: Date;
  rollbackSourceTitle?: string;
}

/**
 * Maximum size for content snapshots (1MB)
 * Larger content will be truncated with a marker indicating it was too large
 */
const MAX_CONTENT_SNAPSHOT_SIZE = 1024 * 1024; // 1MB

/**
 * Broadcast hook for real-time activity updates.
 * Set by the web app to broadcast activity events to connected clients.
 */
type ActivityBroadcastHook = (payload: {
  activityId: string;
  operation: string;
  resourceType: string;
  resourceId: string;
  driveId: string | null;
  pageId: string | null;
  userId: string;
  timestamp: string;
}) => Promise<void>;

let activityBroadcastHook: ActivityBroadcastHook | null = null;

/**
 * Set the activity broadcast hook.
 * Called by the web app at startup to enable real-time activity updates.
 */
export function setActivityBroadcastHook(hook: ActivityBroadcastHook | null): void {
  activityBroadcastHook = hook;
}

function prepareActivityInsert(input: ActivityLogInput) {
  let contentSnapshot = input.contentSnapshot;
  let metadata = input.metadata;

  if (contentSnapshot && contentSnapshot.length > MAX_CONTENT_SNAPSHOT_SIZE) {
    const originalSnapshotSize = contentSnapshot.length;
    console.warn('[ActivityLogger] Content snapshot too large, skipping snapshot', {
      resourceId: input.resourceId,
      resourceType: input.resourceType,
      snapshotSize: originalSnapshotSize,
      maxSize: MAX_CONTENT_SNAPSHOT_SIZE,
    });
    contentSnapshot = undefined;
    metadata = {
      ...input.metadata,
      contentSnapshotSkipped: true,
      originalSnapshotSize,
    };
  }

  return {
    id: createId(),
    timestamp: new Date(),
    userId: input.userId,
    actorEmail: input.actorEmail,
    actorDisplayName: input.actorDisplayName,
    operation: input.operation,
    resourceType: input.resourceType,
    resourceId: input.resourceId,
    resourceTitle: input.resourceTitle,
    driveId: input.driveId,
    pageId: input.pageId,
    isAiGenerated: input.isAiGenerated ?? false,
    aiProvider: input.aiProvider,
    aiModel: input.aiModel,
    aiConversationId: input.aiConversationId,
    contentSnapshot,
    contentFormat: input.contentFormat,
    contentRef: input.contentRef,
    contentSize: input.contentSize,
    updatedFields: input.updatedFields,
    previousValues: input.previousValues,
    newValues: input.newValues,
    metadata,
    streamId: input.streamId,
    streamSeq: input.streamSeq,
    changeGroupId: input.changeGroupId,
    changeGroupType: input.changeGroupType,
    stateHashBefore: input.stateHashBefore,
    stateHashAfter: input.stateHashAfter,
    rollbackFromActivityId: input.rollbackFromActivityId,
    rollbackSourceOperation: input.rollbackSourceOperation,
    rollbackSourceTimestamp: input.rollbackSourceTimestamp,
    rollbackSourceTitle: input.rollbackSourceTitle,
    isArchived: false,
  };
}

/**
 * Log an activity event to the database.
 * Fire-and-forget pattern - never blocks the caller.
 * Also broadcasts the activity for real-time updates if a hook is configured.
 * Computes hash chain data for tamper-evident audit logging.
 */
export async function logActivity(input: ActivityLogInput): Promise<void> {
  const insertActivityLog = async (pageId: string | undefined) => {
    const values = prepareActivityInsert({ ...input, pageId });

    // Get the latest log hash to chain this entry
    const { previousHash, isFirstEntry } = await getLatestLogHash();

    // Compute hash chain data for this entry
    const hashChainData = computeHashChainData(
      {
        id: values.id,
        timestamp: values.timestamp,
        userId: values.userId,
        actorEmail: values.actorEmail,
        operation: values.operation,
        resourceType: values.resourceType,
        resourceId: values.resourceId,
        driveId: values.driveId,
        pageId: values.pageId,
        contentSnapshot: values.contentSnapshot,
        previousValues: values.previousValues,
        newValues: values.newValues,
        metadata: values.metadata,
      },
      previousHash,
      isFirstEntry
    );

    // Insert with hash chain fields
    await db.insert(activityLogs).values({
      ...values,
      previousLogHash: hashChainData.previousLogHash,
      logHash: hashChainData.logHash,
      chainSeed: hashChainData.chainSeed,
    });

    // Broadcast for real-time updates (fire and forget)
    if (activityBroadcastHook) {
      activityBroadcastHook({
        activityId: values.id,
        operation: values.operation,
        resourceType: values.resourceType,
        resourceId: values.resourceId,
        driveId: values.driveId ?? null,
        pageId: values.pageId ?? null,
        userId: values.userId,
        timestamp: values.timestamp.toISOString(),
      }).catch(() => {
        // Broadcast failure shouldn't break anything
      });
    }
  };

  try {
    await insertActivityLog(input.pageId);
  } catch (error) {
    // Check for FK constraint violation on pageId (page was deleted during async logging)
    const isPageIdFkError =
      error instanceof Error &&
      'code' in error &&
      (error as { code: string }).code === '23503' &&
      'constraint' in error &&
      (error as { constraint: string }).constraint === 'activity_logs_pageId_pages_id_fk';

    if (isPageIdFkError && input.pageId) {
      // Retry without pageId - the page was deleted but we still want to log the activity
      try {
        await insertActivityLog(undefined);
        return;
      } catch (retryError) {
        console.error('[ActivityLogger] Failed to log activity after FK retry:', retryError);
        return;
      }
    }

    // Fire and forget - log error but don't throw
    console.error('[ActivityLogger] Failed to log activity:', error);
  }
}

/**
 * Log an activity event using an existing transaction.
 * Intended for deterministic, atomic writes.
 * Computes hash chain data within the transaction for consistency.
 * Note: Broadcast happens after insert but within the transaction scope.
 * The broadcast is debounced, so it will fire after the transaction commits.
 */
export async function logActivityWithTx(
  input: ActivityLogInput,
  tx: typeof db
): Promise<void> {
  const values = prepareActivityInsert(input);

  // Get the latest log hash within the transaction for atomic chain computation
  const { previousHash, isFirstEntry } = await getLatestLogHashWithTx(tx);

  // Compute hash chain data for this entry
  const hashChainData = computeHashChainData(
    {
      id: values.id,
      timestamp: values.timestamp,
      userId: values.userId,
      actorEmail: values.actorEmail,
      operation: values.operation,
      resourceType: values.resourceType,
      resourceId: values.resourceId,
      driveId: values.driveId,
      pageId: values.pageId,
      contentSnapshot: values.contentSnapshot,
      previousValues: values.previousValues,
      newValues: values.newValues,
      metadata: values.metadata,
    },
    previousHash,
    isFirstEntry
  );

  // Insert with hash chain fields
  await tx.insert(activityLogs).values({
    ...values,
    previousLogHash: hashChainData.previousLogHash,
    logHash: hashChainData.logHash,
    chainSeed: hashChainData.chainSeed,
  });

  // Broadcast for real-time updates (fire and forget, debounced)
  if (activityBroadcastHook) {
    activityBroadcastHook({
      activityId: values.id,
      operation: values.operation,
      resourceType: values.resourceType,
      resourceId: values.resourceId,
      driveId: values.driveId ?? null,
      pageId: values.pageId ?? null,
      userId: values.userId,
      timestamp: values.timestamp.toISOString(),
    }).catch(() => {
      // Broadcast failure shouldn't break anything
    });
  }
}

/**
 * Convenience wrapper for page operations.
 * Fire-and-forget - call without await.
 */
export function logPageActivity(
  userId: string,
  operation: ActivityOperation,
  page: {
    id: string;
    title?: string;
    driveId: string;
    content?: string;
  },
  options?: {
    actorEmail?: string;
    actorDisplayName?: string;
    isAiGenerated?: boolean;
    aiProvider?: string;
    aiModel?: string;
    aiConversationId?: string;
    updatedFields?: string[];
    previousValues?: Record<string, unknown>;
    newValues?: Record<string, unknown>;
    metadata?: Record<string, unknown>;
    contentRef?: string;
    contentSize?: number;
    contentFormat?: 'text' | 'html' | 'json' | 'tiptap';
    streamId?: string;
    streamSeq?: number;
    changeGroupId?: string;
    changeGroupType?: 'user' | 'ai' | 'automation' | 'system';
    stateHashBefore?: string;
    stateHashAfter?: string;
  }
): void {
  // For delete operations, don't set pageId since the page no longer exists in the database
  // (the FK constraint would fail). The audit trail is preserved via resourceId and resourceTitle.
  const pageIdForLog = operation === 'delete' ? undefined : page.id;

  logActivity({
    userId,
    actorEmail: options?.actorEmail ?? 'unknown@system',
    actorDisplayName: options?.actorDisplayName,
    operation,
    resourceType: 'page',
    resourceId: page.id,
    resourceTitle: page.title,
    driveId: page.driveId,
    pageId: pageIdForLog,
    contentSnapshot: page.content,
    contentFormat: options?.contentFormat,
    contentRef: options?.contentRef,
    contentSize: options?.contentSize,
    isAiGenerated: options?.isAiGenerated,
    aiProvider: options?.aiProvider,
    aiModel: options?.aiModel,
    aiConversationId: options?.aiConversationId,
    updatedFields: options?.updatedFields,
    previousValues: options?.previousValues,
    newValues: options?.newValues,
    metadata: options?.metadata,
    streamId: options?.streamId,
    streamSeq: options?.streamSeq,
    changeGroupId: options?.changeGroupId,
    changeGroupType: options?.changeGroupType,
    stateHashBefore: options?.stateHashBefore,
    stateHashAfter: options?.stateHashAfter,
  }).catch(() => {
    // Silent fail - already logged in logActivity
  });
}

/**
 * Convenience wrapper for permission operations.
 * Fire-and-forget - call without await.
 */
export function logPermissionActivity(
  userId: string,
  operation: 'permission_grant' | 'permission_update' | 'permission_revoke',
  data: {
    pageId: string;
    driveId: string;
    targetUserId: string;
    permissions?: {
      canView?: boolean;
      canEdit?: boolean;
      canShare?: boolean;
      canDelete?: boolean;
    };
    pageTitle?: string;
  },
  options?: {
    actorEmail?: string;
    actorDisplayName?: string;
    /** Previous permission values (for revoke/update - enables rollback) */
    previousValues?: {
      canView?: boolean;
      canEdit?: boolean;
      canShare?: boolean;
      canDelete?: boolean;
      grantedBy?: string | null;
      note?: string | null;
    };
    /** Reason for revocation (e.g., 'member_removal') */
    reason?: string;
  }
): void {
  logActivity({
    userId,
    actorEmail: options?.actorEmail ?? 'unknown@system',
    actorDisplayName: options?.actorDisplayName,
    operation,
    resourceType: 'permission',
    resourceId: data.pageId,
    resourceTitle: data.pageTitle,
    driveId: data.driveId,
    pageId: data.pageId,
    previousValues: options?.previousValues,
    newValues: data.permissions,
    metadata: {
      targetUserId: data.targetUserId,
      permissions: data.permissions,
      reason: options?.reason,
    },
  }).catch(() => {
    // Silent fail - already logged in logActivity
  });
}

/**
 * Convenience wrapper for drive operations.
 * Fire-and-forget - call without await.
 */
export function logDriveActivity(
  userId: string,
  operation: 'create' | 'update' | 'delete' | 'restore' | 'trash' | 'ownership_transfer',
  drive: {
    id: string;
    name?: string;
  },
  options?: {
    actorEmail?: string;
    actorDisplayName?: string;
    isAiGenerated?: boolean;
    aiProvider?: string;
    aiModel?: string;
    aiConversationId?: string;
    metadata?: Record<string, unknown>;
    previousValues?: Record<string, unknown>;
    newValues?: Record<string, unknown>;
  }
): void {
  logActivity({
    userId,
    actorEmail: options?.actorEmail ?? 'unknown@system',
    actorDisplayName: options?.actorDisplayName,
    operation,
    resourceType: 'drive',
    resourceId: drive.id,
    resourceTitle: drive.name,
    driveId: drive.id,
    isAiGenerated: options?.isAiGenerated,
    aiProvider: options?.aiProvider,
    aiModel: options?.aiModel,
    aiConversationId: options?.aiConversationId,
    previousValues: options?.previousValues,
    newValues: options?.newValues,
    metadata: options?.metadata,
  }).catch(() => {
    // Silent fail - already logged in logActivity
  });
}

/**
 * Convenience wrapper for agent config operations.
 * Fire-and-forget - call without await.
 */
export function logAgentConfigActivity(
  userId: string,
  agent: {
    id: string;
    name?: string;
    driveId: string;
  },
  changes: {
    updatedFields?: string[];
    previousValues?: Record<string, unknown>;
    newValues?: Record<string, unknown>;
    isAiGenerated?: boolean;
    aiProvider?: string;
    aiModel?: string;
    aiConversationId?: string;
    metadata?: Record<string, unknown>; // For agent chain tracking
  },
  options?: {
    actorEmail?: string;
    actorDisplayName?: string;
  }
): void {
  logActivity({
    userId,
    actorEmail: options?.actorEmail ?? 'unknown@system',
    actorDisplayName: options?.actorDisplayName,
    operation: 'agent_config_update',
    resourceType: 'agent',
    resourceId: agent.id,
    resourceTitle: agent.name,
    driveId: agent.driveId,
    pageId: agent.id, // Agents are stored as pages
    isAiGenerated: changes.isAiGenerated,
    aiProvider: changes.aiProvider,
    aiModel: changes.aiModel,
    aiConversationId: changes.aiConversationId,
    updatedFields: changes.updatedFields,
    previousValues: changes.previousValues,
    newValues: changes.newValues,
    metadata: changes.metadata,
  }).catch(() => {
    // Silent fail - already logged in logActivity
  });
}

/**
 * Convenience wrapper for drive membership operations.
 * Fire-and-forget - call without await.
 */
export function logMemberActivity(
  userId: string,
  operation: 'member_add' | 'member_remove' | 'member_role_change',
  data: {
    driveId: string;
    driveName?: string;
    targetUserId: string;
    targetUserEmail?: string;
    role?: string;
    previousRole?: string;
    // Additional fields for member_remove rollback support
    customRoleId?: string | null;
    previousCustomRoleId?: string | null;
    invitedBy?: string | null;
    invitedAt?: Date | null;
    acceptedAt?: Date | null;
  },
  options?: {
    actorEmail?: string;
    actorDisplayName?: string;
  }
): void {
  // Build previousValues for rollback support
  // For member_remove, we need to capture all membership data to restore it
  let previousValues: Record<string, unknown> | undefined;
  if (operation === 'member_remove') {
    previousValues = {
      role: data.previousRole ?? data.role,
      customRoleId: data.previousCustomRoleId ?? data.customRoleId,
      invitedBy: data.invitedBy,
      invitedAt: data.invitedAt?.toISOString(),
      acceptedAt: data.acceptedAt?.toISOString(),
    };
  } else if (data.previousRole) {
    previousValues = { role: data.previousRole };
    if (data.previousCustomRoleId !== undefined) {
      previousValues.customRoleId = data.previousCustomRoleId;
    }
  }

  logActivity({
    userId,
    actorEmail: options?.actorEmail ?? 'unknown@system',
    actorDisplayName: options?.actorDisplayName,
    operation,
    resourceType: 'member',
    resourceId: data.targetUserId,
    resourceTitle: data.targetUserEmail,
    driveId: data.driveId,
    previousValues,
    newValues: data.role ? { role: data.role } : undefined,
    metadata: {
      targetUserId: data.targetUserId,
      targetUserEmail: data.targetUserEmail,
      driveName: data.driveName,
    },
  }).catch(() => {
    // Silent fail - already logged in logActivity
  });
}

/**
 * Convenience wrapper for drive role operations.
 * Fire-and-forget - call without await.
 */
export function logRoleActivity(
  userId: string,
  operation: 'create' | 'update' | 'delete' | 'role_reorder',
  data: {
    roleId?: string; // Optional for reorder (affects multiple roles)
    roleName?: string;
    driveId: string;
    driveName?: string;
    permissions?: Record<string, boolean>;
    previousPermissions?: Record<string, boolean>;
    // For reorder operations
    previousOrder?: string[];
    newOrder?: string[];
  },
  options?: {
    actorEmail?: string;
    actorDisplayName?: string;
  }
): void {
  // Build previousValues and newValues based on operation type
  let previousValues: Record<string, unknown> | undefined;
  let newValues: Record<string, unknown> | undefined;

  if (operation === 'role_reorder') {
    previousValues = data.previousOrder ? { order: data.previousOrder } : undefined;
    newValues = data.newOrder ? { order: data.newOrder } : undefined;
  } else {
    previousValues = data.previousPermissions
      ? { permissions: data.previousPermissions }
      : undefined;
    newValues = data.permissions ? { permissions: data.permissions } : undefined;
  }

  logActivity({
    userId,
    actorEmail: options?.actorEmail ?? 'unknown@system',
    actorDisplayName: options?.actorDisplayName,
    operation,
    resourceType: 'role',
    resourceId: data.roleId ?? data.driveId, // Use driveId as resourceId for reorder
    resourceTitle: data.roleName ?? data.driveName,
    driveId: data.driveId,
    previousValues,
    newValues,
    metadata: operation === 'role_reorder' ? { driveName: data.driveName } : undefined,
  }).catch(() => {
    // Silent fail - already logged in logActivity
  });
}

/**
 * Convenience wrapper for user account operations.
 * Fire-and-forget - call without await.
 */
export function logUserActivity(
  userId: string,
  operation:
    | 'signup'
    | 'login'
    | 'logout'
    | 'password_change'
    | 'email_change'
    | 'profile_update'
    | 'avatar_update'
    | 'account_delete',
  data: {
    targetUserId: string;
    targetUserEmail?: string;
    previousEmail?: string;
    newEmail?: string;
    updatedFields?: string[];
    ip?: string;
    userAgent?: string;
  },
  options?: {
    actorEmail?: string;
    actorDisplayName?: string;
  }
): void {
  // For user operations, we use a special driveId marker
  logActivity({
    userId,
    actorEmail: options?.actorEmail ?? 'unknown@system',
    actorDisplayName: options?.actorDisplayName,
    operation,
    resourceType: 'user',
    resourceId: data.targetUserId,
    resourceTitle: data.targetUserEmail,
    driveId: null, // System-level operations don't belong to a specific drive
    updatedFields: data.updatedFields,
    previousValues: data.previousEmail ? { email: data.previousEmail } : undefined,
    newValues: data.newEmail ? { email: data.newEmail } : undefined,
    metadata: {
      ip: data.ip,
      userAgent: data.userAgent,
    },
  }).catch(() => {
    // Silent fail - already logged in logActivity
  });
}

/**
 * Convenience wrapper for token/device operations.
 * Fire-and-forget - call without await.
 */
export function logTokenActivity(
  userId: string,
  operation: 'token_create' | 'token_revoke',
  data: {
    tokenId: string;
    tokenType: 'device' | 'mcp' | 'api';
    tokenName?: string;
    deviceInfo?: string;
    ip?: string;
    userAgent?: string;
  },
  options?: {
    actorEmail?: string;
    actorDisplayName?: string;
  }
): void {
  logActivity({
    userId,
    actorEmail: options?.actorEmail ?? 'unknown@system',
    actorDisplayName: options?.actorDisplayName,
    operation,
    resourceType: data.tokenType === 'device' ? 'device' : 'token',
    resourceId: data.tokenId,
    resourceTitle: data.tokenName ?? data.deviceInfo,
    driveId: null, // System-level operations
    metadata: {
      tokenType: data.tokenType,
      deviceInfo: data.deviceInfo,
      ip: data.ip,
      userAgent: data.userAgent,
    },
  }).catch(() => {
    // Silent fail - already logged in logActivity
  });
}

/**
 * Convenience wrapper for file operations.
 * Fire-and-forget - call without await.
 */
export function logFileActivity(
  userId: string,
  operation: 'upload' | 'convert' | 'delete',
  data: {
    fileId: string;
    fileName?: string;
    fileType?: string;
    fileSize?: number;
    driveId: string;
    pageId?: string;
  },
  options?: {
    actorEmail?: string;
    actorDisplayName?: string;
  }
): void {
  logActivity({
    userId,
    actorEmail: options?.actorEmail ?? 'unknown@system',
    actorDisplayName: options?.actorDisplayName,
    operation,
    resourceType: 'file',
    resourceId: data.fileId,
    resourceTitle: data.fileName,
    driveId: data.driveId,
    pageId: data.pageId,
    metadata: {
      fileType: data.fileType,
      fileSize: data.fileSize,
    },
  }).catch(() => {
    // Silent fail - already logged in logActivity
  });
}

/**
 * Convenience wrapper for message operations (edit/delete in shared chats).
 * Fire-and-forget - call without await.
 */
export function logMessageActivity(
  userId: string,
  operation: 'message_update' | 'message_delete',
  message: {
    id: string;
    pageId: string;
    driveId: string | null; // null for user-level conversations (global assistant)
    conversationType: 'ai_chat' | 'global' | 'channel';
  },
  actorInfo: ActorInfo,
  options?: {
    previousContent?: string;
    newContent?: string;
    isAiGenerated?: boolean;
    aiProvider?: string;
    aiModel?: string;
    aiConversationId?: string;
  }
): void {
  logActivity({
    userId,
    actorEmail: actorInfo.actorEmail,
    actorDisplayName: actorInfo.actorDisplayName,
    operation,
    resourceType: 'message',
    resourceId: message.id,
    driveId: message.driveId,
    pageId: message.pageId,
    previousValues: options?.previousContent ? { content: options.previousContent } : undefined,
    newValues: options?.newContent ? { content: options.newContent } : undefined,
    isAiGenerated: options?.isAiGenerated ?? false,
    aiProvider: options?.aiProvider,
    aiModel: options?.aiModel,
    aiConversationId: options?.aiConversationId,
    metadata: {
      conversationType: message.conversationType,
    },
  }).catch(() => {
    // Silent fail - already logged in logActivity
  });
}

/**
 * Convenience wrapper for rollback operations.
 * Logs when a user restores a resource to a previous state.
 * Await when using a transaction; otherwise fire-and-forget is fine.
 */
export async function logRollbackActivity(
  userId: string,
  rollbackFromActivityId: string,
  resource: {
    resourceType: ActivityResourceType;
    resourceId: string;
    resourceTitle?: string;
    driveId: string | null;
    pageId?: string;
  },
  actorInfo: ActorInfo,
  options?: {
    /** Values that were restored (from the original activity's previousValues) */
    restoredValues?: Record<string, unknown>;
    /** Values that were replaced (current state before rollback) */
    replacedValues?: Record<string, unknown>;
    /** Content snapshot if rolling back content */
    contentSnapshot?: string;
    /** Format of the content being restored */
    contentFormat?: 'text' | 'html' | 'json' | 'tiptap';
    /** Content reference for deterministic snapshots */
    contentRef?: string;
    /** Content size in bytes */
    contentSize?: number;
    /** Source activity snapshot - denormalized for audit trail preservation */
    rollbackSourceOperation?: ActivityOperation;
    rollbackSourceTimestamp?: Date;
    rollbackSourceTitle?: string;
    /** Stream and change-group metadata for deterministic replay */
    streamId?: string;
    streamSeq?: number;
    changeGroupId?: string;
    changeGroupType?: 'user' | 'ai' | 'automation' | 'system';
    stateHashBefore?: string;
    stateHashAfter?: string;
    /** Additional context */
    metadata?: Record<string, unknown>;
    /** Optional transaction for atomic logging */
    tx?: typeof db;
  }
): Promise<void> {
  const payload: ActivityLogInput = {
    userId,
    actorEmail: actorInfo.actorEmail,
    actorDisplayName: actorInfo.actorDisplayName,
    operation: 'rollback',
    resourceType: resource.resourceType,
    resourceId: resource.resourceId,
    resourceTitle: resource.resourceTitle,
    driveId: resource.driveId,
    pageId: resource.pageId,
    contentSnapshot: options?.contentSnapshot,
    contentFormat: options?.contentFormat,
    contentRef: options?.contentRef,
    contentSize: options?.contentSize,
    // previousValues = state before rollback (what we're replacing)
    previousValues: options?.replacedValues,
    // newValues = state after rollback (what we restored to)
    newValues: options?.restoredValues,
    // Rollback tracking - top-level fields for proper DB storage
    rollbackFromActivityId,
    rollbackSourceOperation: options?.rollbackSourceOperation,
    rollbackSourceTimestamp: options?.rollbackSourceTimestamp,
    rollbackSourceTitle: options?.rollbackSourceTitle,
    metadata: options?.metadata,
    streamId: options?.streamId,
    streamSeq: options?.streamSeq,
    changeGroupId: options?.changeGroupId,
    changeGroupType: options?.changeGroupType,
    stateHashBefore: options?.stateHashBefore,
    stateHashAfter: options?.stateHashAfter,
  };

  if (options?.tx) {
    await logActivityWithTx(payload, options.tx);
    return;
  }

  logActivity(payload).catch(() => {
    // Silent fail - already logged in logActivity
  });
}

/**
 * Convenience wrapper for AI conversation undo operations.
 * Logs when a user undoes an AI conversation from a specific message point.
 * Fire-and-forget - call without await.
 */
export function logConversationUndo(
  userId: string,
  conversationId: string,
  messageId: string, // The message we're undoing from
  actorInfo: ActorInfo,
  options: {
    mode: 'messages_only' | 'messages_and_changes';
    messagesDeleted: number;
    activitiesRolledBack: number;
    rolledBackActivityIds?: string[]; // For potential re-undo
    pageId?: string;
    driveId?: string | null;
  }
): void {
  const operation: ActivityOperation =
    options.mode === 'messages_only' ? 'conversation_undo' : 'conversation_undo_with_changes';

  logActivity({
    userId,
    actorEmail: actorInfo.actorEmail,
    actorDisplayName: actorInfo.actorDisplayName,
    operation,
    resourceType: 'conversation',
    resourceId: conversationId,
    driveId: options.driveId ?? null,
    pageId: options.pageId,
    previousValues: {
      messagesWereActive: true,
    },
    metadata: {
      messageId,
      messagesDeleted: options.messagesDeleted,
      activitiesRolledBack: options.activitiesRolledBack,
      rolledBackActivityIds: options.rolledBackActivityIds,
      mode: options.mode,
    },
  }).catch(() => {
    // Silent fail - already logged in logActivity
  });
}
