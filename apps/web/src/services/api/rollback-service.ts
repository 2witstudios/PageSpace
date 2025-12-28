/**
 * Rollback Service
 *
 * Handles version history rollback operations for PageSpace.
 * Allows users to restore resources to previous states based on activity logs.
 */

import { db, activityLogs, pages, drives, driveMembers, driveRoles, pagePermissions, users, chatMessages, messages, eq, and, desc, gte, gt, lte, count, asc, not, inArray } from '@pagespace/db';
import type { ActivityAction, ActivityActionPreview, ActivityActionResult, ActivityChangeSummary } from '@/types/activity-actions';
import {
  canUserRollback,
  isRollbackableOperation,
  type RollbackContext,
} from '@pagespace/lib/permissions';

// Re-export RollbackContext for consumers
export type { RollbackContext };
import {
  logRollbackActivity,
  getActorInfo,
  type ActivityResourceType,
  type ActivityOperation,
  createChangeGroupId,
  inferChangeGroupType,
} from '@pagespace/lib/monitoring';
import {
  loggers,
  readPageContent,
  computePageStateHash,
  hashWithPrefix,
  createPageVersion,
  type PageVersionSource,
  type ChangeGroupType,
} from '@pagespace/lib/server';
import { detectPageContentFormat, type PageContentFormat } from '@pagespace/lib/content';
import { syncMentions } from '@/services/api/page-mention-service';

/**
 * Valid activity operations for filtering
 */
const VALID_OPERATIONS = [
  'create', 'update', 'delete', 'restore', 'reorder',
  'permission_grant', 'permission_update', 'permission_revoke',
  'trash', 'move', 'agent_config_update',
  'member_add', 'member_remove', 'member_role_change',
  'login', 'logout', 'signup', 'password_change', 'email_change',
  'token_create', 'token_revoke', 'upload', 'convert',
  'account_delete', 'profile_update', 'avatar_update',
  'message_update', 'message_delete', 'role_reorder', 'ownership_transfer',
  'rollback', 'conversation_undo', 'conversation_undo_with_changes',
] as const;

/**
 * Check if a string is a valid activity operation
 */
function isValidOperation(operation: string): boolean {
  return VALID_OPERATIONS.includes(operation as typeof VALID_OPERATIONS[number]);
}

const OPERATION_SUMMARY_LABELS: Record<string, string> = {
  create: 'Create',
  update: 'Update',
  delete: 'Delete',
  restore: 'Restore',
  reorder: 'Reorder',
  trash: 'Trash',
  move: 'Move',
  permission_grant: 'Grant permission',
  permission_update: 'Update permission',
  permission_revoke: 'Revoke permission',
  agent_config_update: 'Update agent',
  member_add: 'Add member',
  member_remove: 'Remove member',
  member_role_change: 'Change member role',
  role_reorder: 'Reorder roles',
  ownership_transfer: 'Transfer ownership',
  message_update: 'Edit message',
  message_delete: 'Delete message',
  rollback: 'Rollback',
};

function getOperationSummaryLabel(operation: string): string {
  return OPERATION_SUMMARY_LABELS[operation] ?? operation;
}

function getChangeDescription(activity: ActivityLogForRollback): string {
  const metadata = activity.metadata as { targetUserEmail?: string } | null;
  return activity.resourceTitle || metadata?.targetUserEmail || activity.resourceType;
}

function buildChangeSummary(
  activity: ActivityLogForRollback,
  targetValues: Record<string, unknown> | null
): ActivityChangeSummary[] {
  const operation = activity.operation;
  const label = `Undo ${getOperationSummaryLabel(operation)}`;
  const fields = activity.updatedFields?.length
    ? activity.updatedFields
    : targetValues
      ? Object.keys(targetValues)
      : [];
  return [
    {
      id: activity.id,
      label,
      description: getChangeDescription(activity),
      fields: fields.length > 0 ? fields : undefined,
      resource: {
        type: activity.resourceType,
        id: activity.resourceId,
        title: activity.resourceTitle || activity.resourceType,
      },
    },
  ];
}

async function resolveActivityContentSnapshot(activity: ActivityLogForRollback): Promise<string | null> {
  if (activity.contentSnapshot) {
    return activity.contentSnapshot;
  }

  if (activity.contentRef) {
    try {
      return await readPageContent(activity.contentRef);
    } catch (error) {
      loggers.api.warn('[RollbackService] Failed to read content snapshot', {
        activityId: activity.id,
        contentRef: activity.contentRef,
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }

  return null;
}

function buildRollbackTargetValues(
  activity: ActivityLogForRollback,
  contentSnapshot?: string | null
): Record<string, unknown> | null {
  const baseValues = activity.previousValues ? { ...activity.previousValues } : null;
  if (activity.operation === 'create') {
    return baseValues;
  }
  const resolvedContent = contentSnapshot ?? activity.contentSnapshot;
  if (resolvedContent && (!baseValues || !Object.prototype.hasOwnProperty.call(baseValues, 'content'))) {
    return {
      ...(baseValues ?? {}),
      content: resolvedContent,
    };
  }
  return baseValues;
}

function buildActionTargetValues(
  activity: ActivityLogForRollback,
  contentSnapshot?: string | null
): Record<string, unknown> | null {
  // When rolling back a rollback activity, use previousValues (same as the old redo logic)
  // This restores the state to what it was before the rollback happened
  if (activity.operation === 'rollback') {
    return activity.previousValues ? { ...activity.previousValues } : null;
  }
  return buildRollbackTargetValues(activity, contentSnapshot);
}

function getEffectiveOperation(
  activity: ActivityLogForRollback
): ActivityOperation | null {
  // When the target is a rollback activity, use the original operation type
  // so the correct handler is called (e.g., page handler for page updates)
  if (activity.operation === 'rollback') {
    return (activity.rollbackSourceOperation as ActivityOperation | null) ?? null;
  }
  return activity.operation as ActivityOperation;
}

const REDO_ALLOW_MISSING_TARGET = new Set<ActivityOperation>([
  'member_remove',
  'permission_revoke',
  'delete',
  'trash',
]);

const ROLLBACK_ALLOW_MISSING_TARGET = new Set<ActivityOperation>([
  'permission_grant',
  'member_add',
  'message_delete',
]);

/**
 * Check if this activity represents rolling back a previous rollback (effectively redo)
 */
function isRollingBackRollback(activity: ActivityLogForRollback): boolean {
  return activity.operation === 'rollback';
}

// Helper for deep value comparison that handles dates, nulls, and primitives correctly
function deepEqual(a: unknown, b: unknown): boolean {
  // Handle null/undefined
  if (a === b) return true;
  if (a == null || b == null) return a === b;

  // Handle Date objects
  if (a instanceof Date && b instanceof Date) {
    return a.getTime() === b.getTime();
  }
  if (a instanceof Date || b instanceof Date) {
    const aStr = a instanceof Date ? a.toISOString() : String(a);
    const bStr = b instanceof Date ? b.toISOString() : String(b);
    return aStr === bStr;
  }

  // Handle arrays
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    return a.every((item, i) => deepEqual(item, b[i]));
  }
  if (Array.isArray(a) || Array.isArray(b)) return false;

  // Handle objects
  if (typeof a === 'object' && typeof b === 'object') {
    const keysA = Object.keys(a as object);
    const keysB = Object.keys(b as object);
    if (keysA.length !== keysB.length) return false;
    return keysA.every(key =>
      Object.prototype.hasOwnProperty.call(b, key) &&
      deepEqual((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key])
    );
  }

  // Handle primitives
  return a === b;
}

function getConflictFields(
  expectedValues: Record<string, unknown> | null,
  currentValues: Record<string, unknown> | null
): string[] {
  if (!expectedValues || !currentValues) return [];
  return Object.entries(expectedValues).reduce<string[]>((acc, [key, value]) => {
    const currentVal = currentValues[key];
    if (!deepEqual(currentVal, value)) {
      acc.push(key);
    }
    return acc;
  }, []);
}

function isNoOpChange(
  targetValues: Record<string, unknown> | null,
  currentValues: Record<string, unknown> | null
): boolean {
  if (!targetValues || !currentValues) return false;
  if (Object.keys(targetValues).length === 0) return false;
  return Object.entries(targetValues).every(([key, value]) =>
    deepEqual(currentValues[key], value)
  );
}

interface PageUpdateWithRevisionOptions {
  userId?: string | null;
  changeGroupId?: string;
  changeGroupType?: ChangeGroupType;
  source?: PageVersionSource;
  metadata?: Record<string, unknown>;
}

interface PageUpdateContext {
  userId: string;
  changeGroupId: string;
  changeGroupType: ChangeGroupType;
  source: PageVersionSource;
  metadata?: Record<string, unknown>;
}

interface PageMutationMeta {
  pageId: string;
  nextRevision: number;
  stateHashBefore: string;
  stateHashAfter: string;
  contentRefAfter: string | null;
  contentSizeAfter: number | null;
  contentFormatAfter: PageContentFormat;
}

interface PageChangeResult {
  restoredValues: Record<string, unknown>;
  pageMutationMeta: PageMutationMeta;
}

async function applyPageUpdateWithRevision(
  database: typeof db,
  pageId: string,
  updateData: Record<string, unknown>,
  options?: PageUpdateWithRevisionOptions
): Promise<PageMutationMeta> {
  const [currentPage] = await database
    .select()
    .from(pages)
    .where(eq(pages.id, pageId))
    .limit(1);

  if (!currentPage) {
    throw new Error('Page not found');
  }

  const currentRevision = typeof currentPage.revision === 'number' ? currentPage.revision : 0;
  const nextRevision = currentRevision + 1;

  const previousContent = currentPage.content ?? '';
  const nextContent = updateData.content !== undefined
    ? String(updateData.content)
    : previousContent;
  const contentFormatBefore = detectPageContentFormat(previousContent);
  const contentFormatAfter = detectPageContentFormat(nextContent);
  const contentRefBefore = hashWithPrefix(contentFormatBefore, previousContent);
  const contentRefAfter = hashWithPrefix(contentFormatAfter, nextContent);

  const stateHashBefore = computePageStateHash({
    title: currentPage.title,
    contentRef: contentRefBefore,
    parentId: currentPage.parentId,
    position: currentPage.position,
    isTrashed: currentPage.isTrashed,
    type: currentPage.type,
    driveId: currentPage.driveId,
    aiProvider: currentPage.aiProvider,
    aiModel: currentPage.aiModel,
    systemPrompt: currentPage.systemPrompt,
    enabledTools: currentPage.enabledTools,
    isPaginated: currentPage.isPaginated,
    includeDrivePrompt: currentPage.includeDrivePrompt,
    agentDefinition: currentPage.agentDefinition,
    visibleToGlobalAssistant: currentPage.visibleToGlobalAssistant,
    includePageTree: currentPage.includePageTree,
    pageTreeScope: currentPage.pageTreeScope,
  });

  const nextState = {
    title: updateData.title !== undefined ? String(updateData.title) : currentPage.title,
    contentRef: contentRefAfter,
    parentId: updateData.parentId !== undefined ? (updateData.parentId as string | null) : currentPage.parentId,
    position: updateData.position !== undefined ? Number(updateData.position) : currentPage.position,
    isTrashed: updateData.isTrashed !== undefined ? Boolean(updateData.isTrashed) : currentPage.isTrashed,
    type: updateData.type !== undefined ? String(updateData.type) : currentPage.type,
    driveId: currentPage.driveId,
    aiProvider: updateData.aiProvider !== undefined
      ? (updateData.aiProvider === null ? null : String(updateData.aiProvider))
      : currentPage.aiProvider,
    aiModel: updateData.aiModel !== undefined
      ? (updateData.aiModel === null ? null : String(updateData.aiModel))
      : currentPage.aiModel,
    systemPrompt: updateData.systemPrompt !== undefined
      ? (updateData.systemPrompt === null ? null : String(updateData.systemPrompt))
      : currentPage.systemPrompt,
    enabledTools: updateData.enabledTools !== undefined ? updateData.enabledTools : currentPage.enabledTools,
    isPaginated: updateData.isPaginated !== undefined ? Boolean(updateData.isPaginated) : currentPage.isPaginated,
    includeDrivePrompt: updateData.includeDrivePrompt !== undefined ? Boolean(updateData.includeDrivePrompt) : currentPage.includeDrivePrompt,
    agentDefinition: updateData.agentDefinition !== undefined
      ? (updateData.agentDefinition === null ? null : String(updateData.agentDefinition))
      : currentPage.agentDefinition,
    visibleToGlobalAssistant: updateData.visibleToGlobalAssistant !== undefined ? Boolean(updateData.visibleToGlobalAssistant) : currentPage.visibleToGlobalAssistant,
    includePageTree: updateData.includePageTree !== undefined ? Boolean(updateData.includePageTree) : currentPage.includePageTree,
    pageTreeScope: updateData.pageTreeScope !== undefined
      ? (updateData.pageTreeScope === null ? null : String(updateData.pageTreeScope))
      : currentPage.pageTreeScope,
  };

  const stateHashAfter = computePageStateHash(nextState);

  const [updated] = await database
    .update(pages)
    .set({
      ...updateData,
      revision: nextRevision,
      stateHash: stateHashAfter,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(pages.id, pageId),
        eq(pages.revision, currentRevision)
      )
    )
    .returning({ id: pages.id });

  if (!updated) {
    throw new Error('Page was modified while applying rollback');
  }

  if (updateData.content !== undefined) {
    await syncMentions(pageId, nextContent, database);
  }

  const changeGroupId = options?.changeGroupId ?? createChangeGroupId();
  const changeGroupType = options?.changeGroupType ?? inferChangeGroupType({ isAiGenerated: false });

  const version = await createPageVersion({
    pageId,
    driveId: currentPage.driveId,
    createdBy: options?.userId ?? null,
    source: options?.source ?? 'restore',
    content: nextContent,
    contentFormat: contentFormatAfter,
    pageRevision: nextRevision,
    stateHash: stateHashAfter,
    changeGroupId,
    changeGroupType,
    metadata: options?.metadata,
  }, { tx: database });

  return {
    pageId,
    nextRevision,
    stateHashBefore,
    stateHashAfter,
    contentRefAfter: version.contentRef ?? contentRefAfter ?? null,
    contentSizeAfter: version.contentSize ?? null,
    contentFormatAfter,
  };
}

/**
 * Activity log with full details for rollback
 */
export interface ActivityLogForRollback {
  id: string;
  timestamp: Date;
  userId: string | null;
  actorEmail: string;
  actorDisplayName: string | null;
  operation: string;
  resourceType: ActivityResourceType;
  resourceId: string;
  resourceTitle: string | null;
  driveId: string | null;
  pageId: string | null;
  isAiGenerated: boolean;
  aiProvider: string | null;
  aiModel: string | null;
  contentSnapshot: string | null;
  contentRef: string | null;
  contentFormat: PageContentFormat | null;
  contentSize: number | null;
  updatedFields: string[] | null;
  previousValues: Record<string, unknown> | null;
  newValues: Record<string, unknown> | null;
  metadata: Record<string, unknown> | null;
  streamId: string | null;
  streamSeq: number | null;
  changeGroupId: string | null;
  changeGroupType: ChangeGroupType | null;
  stateHashBefore: string | null;
  stateHashAfter: string | null;
  rollbackFromActivityId: string | null;
  rollbackSourceOperation: ActivityOperation | null;
  rollbackSourceTimestamp: Date | null;
  rollbackSourceTitle: string | null;
}

/**
 * Result of a rollback preview
 */
export type RollbackPreview = ActivityActionPreview;

/**
 * Result of executing a rollback
 */
export interface RollbackResult extends ActivityActionResult {
  success: boolean;
  rollbackActivityId?: string;
  restoredValues?: Record<string, unknown>;
}

/**
 * Options for fetching version history
 */
export interface VersionHistoryOptions {
  limit?: number;
  offset?: number;
  startDate?: Date;
  endDate?: Date;
  actorId?: string;
  operation?: string;
  includeAiOnly?: boolean;
  resourceType?: string;
}

/**
 * Fetch a single activity log by ID
 */
export async function getActivityById(
  activityId: string
): Promise<ActivityLogForRollback | null> {
  loggers.api.debug('[Rollback:Fetch] Fetching activity by ID', { activityId });

  try {
    const result = await db
      .select()
      .from(activityLogs)
      .where(eq(activityLogs.id, activityId))
      .limit(1);

    if (result.length === 0) {
      loggers.api.debug('[Rollback:Fetch] Activity not found', { activityId });
      return null;
    }

    const activity = result[0];
    loggers.api.debug('[Rollback:Fetch] Activity found', {
      activityId,
      operation: activity.operation,
      resourceType: activity.resourceType,
      resourceId: activity.resourceId,
      isAiGenerated: activity.isAiGenerated,
    });

    return {
      id: activity.id,
      timestamp: activity.timestamp,
      userId: activity.userId,
      actorEmail: activity.actorEmail,
      actorDisplayName: activity.actorDisplayName,
      operation: activity.operation,
      resourceType: activity.resourceType as ActivityResourceType,
      resourceId: activity.resourceId,
      resourceTitle: activity.resourceTitle,
      driveId: activity.driveId,
      pageId: activity.pageId,
      isAiGenerated: activity.isAiGenerated,
      aiProvider: activity.aiProvider,
      aiModel: activity.aiModel,
      contentSnapshot: activity.contentSnapshot,
      contentRef: activity.contentRef,
      contentFormat: activity.contentFormat as PageContentFormat | null,
      contentSize: activity.contentSize,
      updatedFields: activity.updatedFields as string[] | null,
      previousValues: activity.previousValues as Record<string, unknown> | null,
      newValues: activity.newValues as Record<string, unknown> | null,
      metadata: activity.metadata as Record<string, unknown> | null,
      streamId: activity.streamId,
      streamSeq: activity.streamSeq,
      changeGroupId: activity.changeGroupId,
      changeGroupType: activity.changeGroupType as ChangeGroupType | null,
      stateHashBefore: activity.stateHashBefore,
      stateHashAfter: activity.stateHashAfter,
      rollbackFromActivityId: activity.rollbackFromActivityId,
      rollbackSourceOperation: activity.rollbackSourceOperation as ActivityOperation | null,
      rollbackSourceTimestamp: activity.rollbackSourceTimestamp,
      rollbackSourceTitle: activity.rollbackSourceTitle,
    };
  } catch (error) {
    loggers.api.error('[RollbackService] Error fetching activity', {
      activityId,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

/**
 * Preview what a rollback or redo would do
 */
async function previewActivityAction(
  action: ActivityAction,
  activityId: string,
  userId: string,
  context: RollbackContext,
  options?: { force?: boolean; undoGroupActivityIds?: string[] }
): Promise<ActivityActionPreview> {
  const force = options?.force ?? false;
  const undoGroupActivityIds = options?.undoGroupActivityIds ?? [];
  loggers.api.debug('[Rollback:Preview] Starting preview', { action, activityId, userId, context, force });

  const activity = await getActivityById(activityId);
  const resolvedContentSnapshot = activity
    ? await resolveActivityContentSnapshot(activity)
    : null;
  const targetValues = activity ? buildActionTargetValues(activity, resolvedContentSnapshot) : null;
  const changes = activity ? buildChangeSummary(activity, targetValues) : [];
  const affectedResources = activity
    ? [
        {
          type: activity.resourceType,
          id: activity.resourceId,
          title: activity.resourceTitle || 'Untitled',
        },
      ]
    : [];

  const basePreview = (overrides: Partial<ActivityActionPreview>): ActivityActionPreview => ({
    action,
    canExecute: false,
    reason: undefined,
    warnings: [],
    hasConflict: false,
    conflictFields: [],
    requiresForce: false,
    isNoOp: false,
    currentValues: null,
    targetValues,
    changes,
    affectedResources,
    ...overrides,
  });

  if (!activity) {
    loggers.api.debug('[Rollback:Preview] Activity not found', { activityId });
    return basePreview({ reason: 'Activity not found' });
  }

  // When rolling back a rollback activity, we need the source operation to know what handler to use
  const rollingBackRollback = isRollingBackRollback(activity);

  const effectiveOperation = getEffectiveOperation(activity);
  if (!effectiveOperation) {
    return basePreview({
      reason: rollingBackRollback
        ? 'Rollback source operation not available'
        : 'Operation not available',
    });
  }

  // Check if operation is rollbackable
  const isRollbackable = isRollbackableOperation(effectiveOperation);
  loggers.api.debug('[Rollback:Preview] Checking operation eligibility', {
    action,
    operation: effectiveOperation,
    isRollbackable,
  });

  if (!isRollbackable) {
    return basePreview({
      reason: `Cannot ${action} '${effectiveOperation}' operations`,
    });
  }

  const hasTargetValues = !!targetValues && Object.keys(targetValues).length > 0;
  // Content snapshots are only relevant for regular rollbacks, not rollback of rollbacks
  const hasContentSnapshot = !rollingBackRollback && !!resolvedContentSnapshot;
  // When rolling back a rollback, use the redo allow list since we're restoring forward
  const allowMissingTarget = rollingBackRollback
    ? REDO_ALLOW_MISSING_TARGET.has(effectiveOperation)
    : ROLLBACK_ALLOW_MISSING_TARGET.has(effectiveOperation);
  loggers.api.debug('[Rollback:Preview] Checking previous state availability', {
    action,
    rollingBackRollback,
    hasTargetValues,
    hasContentSnapshot,
    allowMissingTarget,
    previousValuesFields: targetValues ? Object.keys(targetValues) : [],
  });

  // For 'create' operations, rollback means trashing - no previous state needed
  if (effectiveOperation !== 'create' && !hasTargetValues && !hasContentSnapshot && !allowMissingTarget) {
    return basePreview({
      reason: rollingBackRollback
        ? 'No rollback state available to reapply'
        : 'No values to restore',
    });
  }

  // Check permissions
  loggers.api.debug('[Rollback:Preview] Checking permissions', {
    userId,
    context,
    resourceType: activity.resourceType,
  });

  const permissionCheck = await canUserRollback(userId, activity, context);

  loggers.api.debug('[Rollback:Preview] Permission check result', {
    canRollback: permissionCheck.canRollback,
    reason: permissionCheck.reason,
  });

  if (!permissionCheck.canRollback) {
    return basePreview({
      reason: permissionCheck.reason,
    });
  }

  // Get current state and check for conflicts
  const warnings: string[] = [];
  let currentValues: Record<string, unknown> | null = null;
  let conflictFields: string[] = [];
  let hasConflict = false;
  let requiresForce = false;

  loggers.api.debug('[Rollback:Preview] Fetching current resource state', {
    resourceType: activity.resourceType,
    resourceId: activity.resourceId,
  });

  if (activity.resourceType === 'page' && activity.pageId) {
    const currentPage = await db
      .select()
      .from(pages)
      .where(eq(pages.id, activity.pageId))
      .limit(1);

    if (currentPage.length === 0) {
      return basePreview({
        reason: 'Resource no longer exists',
      });
    }

    // Check if parent drive still exists and is not trashed
    if (activity.driveId) {
      const parentDrive = await db
        .select({ id: drives.id, isTrashed: drives.isTrashed })
        .from(drives)
        .where(eq(drives.id, activity.driveId))
        .limit(1);

      if (parentDrive.length === 0) {
        return basePreview({
          reason: 'Parent drive has been deleted',
        });
      }

      if (parentDrive[0].isTrashed) {
        return basePreview({
          reason: 'Parent drive is in trash. Restore the drive first.',
        });
      }
    }

    currentValues = {
      title: currentPage[0].title,
      content: currentPage[0].content,
      parentId: currentPage[0].parentId,
      position: currentPage[0].position,
      isTrashed: currentPage[0].isTrashed,
    };

    if (effectiveOperation === 'create') {
      const isTrashed = currentPage[0].isTrashed;
      const shouldBeTrashed = action === 'rollback';
      if (isTrashed === shouldBeTrashed) {
        return basePreview({
          reason: shouldBeTrashed ? 'Page is already in trash' : 'Page is already restored',
          currentValues,
          isNoOp: true,
        });
      }
    }

    conflictFields = getConflictFields(activity.newValues, currentValues);

    // If there's a conflict but we have undo group context, check if the modifications
    // came from other activities in the same undo group (internal conflict vs external)
    if (conflictFields.length > 0 && undoGroupActivityIds.length > 0) {
      const externalModifications = await db
        .select({ id: activityLogs.id })
        .from(activityLogs)
        .where(
          and(
            eq(activityLogs.resourceId, activity.resourceId),
            eq(activityLogs.resourceType, 'page'),
            gt(activityLogs.timestamp, activity.timestamp),
            not(inArray(activityLogs.id, undoGroupActivityIds))
          )
        )
        .limit(1);

      if (externalModifications.length === 0) {
        // All modifications came from activities in the undo group - not a real conflict
        loggers.api.debug('[Rollback:Preview] Page conflict is internal to undo group, ignoring', {
          activityId: activity.id,
          conflictFields,
        });
        conflictFields = [];
      }
    }

    if (conflictFields.length > 0) {
      hasConflict = true;
      requiresForce = true;
      loggers.api.debug('[Rollback:Preview] Conflict check', {
        hasConflict: true,
        checkedFields: conflictFields,
        force,
      });

      if (!force) {
        return basePreview({
          reason: 'Resource has been modified since this change. Use force=true to override.',
          currentValues,
          hasConflict,
          conflictFields,
          requiresForce,
        });
      }
      warnings.push('This resource has been modified since this change. Recent changes will be overwritten.');
    }
  } else if (activity.resourceType === 'drive' && activity.driveId) {
    const currentDrive = await db
      .select()
      .from(drives)
      .where(eq(drives.id, activity.driveId))
      .limit(1);

    if (currentDrive.length === 0) {
      return basePreview({
        reason: 'Drive no longer exists',
      });
    }

    currentValues = {
      name: currentDrive[0].name,
      isTrashed: currentDrive[0].isTrashed,
      drivePrompt: currentDrive[0].drivePrompt,
      ownerId: currentDrive[0].ownerId,
    };

    if (effectiveOperation === 'create') {
      const isTrashed = currentDrive[0].isTrashed;
      const shouldBeTrashed = action === 'rollback';
      if (isTrashed === shouldBeTrashed) {
        return basePreview({
          reason: shouldBeTrashed ? 'Drive is already in trash' : 'Drive is already restored',
          currentValues,
          isNoOp: true,
        });
      }
    }

    conflictFields = getConflictFields(activity.newValues, currentValues);

    // If there's a conflict but we have undo group context, check if the modifications
    // came from other activities in the same undo group (internal conflict vs external)
    if (conflictFields.length > 0 && undoGroupActivityIds.length > 0) {
      const externalModifications = await db
        .select({ id: activityLogs.id })
        .from(activityLogs)
        .where(
          and(
            eq(activityLogs.resourceId, activity.resourceId),
            eq(activityLogs.resourceType, 'drive'),
            gt(activityLogs.timestamp, activity.timestamp),
            not(inArray(activityLogs.id, undoGroupActivityIds))
          )
        )
        .limit(1);

      if (externalModifications.length === 0) {
        // All modifications came from activities in the undo group - not a real conflict
        loggers.api.debug('[Rollback:Preview] Drive conflict is internal to undo group, ignoring', {
          activityId: activity.id,
          conflictFields,
        });
        conflictFields = [];
      }
    }

    if (conflictFields.length > 0) {
      hasConflict = true;
      requiresForce = true;
      loggers.api.debug('[Rollback:Preview] Drive conflict check', {
        hasConflict: true,
        checkedFields: conflictFields,
        force,
      });

      if (!force) {
        return basePreview({
          reason: 'Drive has been modified since this change. Use force=true to override.',
          currentValues,
          hasConflict,
          conflictFields,
          requiresForce,
        });
      }
      warnings.push('This drive has been modified since this change. Recent changes will be overwritten.');
    }
  } else if (activity.resourceType === 'member' && activity.driveId) {
    const metadata = activity.metadata as { targetUserId?: string } | null;
    const targetUserId = metadata?.targetUserId || (activity.previousValues?.userId as string);

    if (targetUserId) {
      const currentMember = await db
        .select()
        .from(driveMembers)
        .where(and(
          eq(driveMembers.driveId, activity.driveId),
          eq(driveMembers.userId, targetUserId)
        ))
        .limit(1);

      if (currentMember.length > 0) {
        currentValues = {
          userId: targetUserId,
          role: currentMember[0].role,
          customRoleId: currentMember[0].customRoleId,
          invitedBy: currentMember[0].invitedBy,
          invitedAt: currentMember[0].invitedAt,
          acceptedAt: currentMember[0].acceptedAt,
        };
      }

      if (effectiveOperation === 'member_add') {
        if (rollingBackRollback) {
          // Rollback of rollback: re-adding member, no-op if already exists
          if (currentMember.length > 0) {
            return basePreview({
              reason: 'Member is already in the drive',
              currentValues,
              isNoOp: true,
            });
          }
        } else {
          // Regular rollback: removing member, no-op if already removed
          if (currentMember.length === 0) {
            return basePreview({
              reason: 'Member has already been removed',
              currentValues,
              isNoOp: true,
            });
          }
        }
      }

      if (effectiveOperation === 'member_remove') {
        if (rollingBackRollback) {
          // Rollback of rollback: removing member, no-op if already removed
          if (currentMember.length === 0) {
            return basePreview({
              reason: 'Member has already been removed',
              currentValues,
              isNoOp: true,
            });
          }
        } else {
          // Regular rollback: re-adding member, no-op if already exists
          if (currentMember.length > 0) {
            return basePreview({
              reason: 'Member has already been re-added to the drive',
              currentValues,
              isNoOp: true,
            });
          }
        }
      }

      if (effectiveOperation === 'member_role_change' && currentMember.length === 0) {
        return basePreview({
          reason: 'Member no longer exists',
          currentValues,
        });
      }

      if (currentMember.length > 0 && effectiveOperation === 'member_role_change') {
        conflictFields = getConflictFields(activity.newValues, currentValues);

        // If there's a conflict but we have undo group context, check if the modifications
        // came from other activities in the same undo group (internal conflict vs external)
        if (conflictFields.length > 0 && undoGroupActivityIds.length > 0) {
          const externalModifications = await db
            .select({ id: activityLogs.id })
            .from(activityLogs)
            .where(
              and(
                eq(activityLogs.resourceId, activity.resourceId),
                eq(activityLogs.resourceType, 'member'),
                gt(activityLogs.timestamp, activity.timestamp),
                not(inArray(activityLogs.id, undoGroupActivityIds))
              )
            )
            .limit(1);

          if (externalModifications.length === 0) {
            // All modifications came from activities in the undo group - not a real conflict
            loggers.api.debug('[Rollback:Preview] Member conflict is internal to undo group, ignoring', {
              activityId: activity.id,
              conflictFields,
            });
            conflictFields = [];
          }
        }

        if (conflictFields.length > 0) {
          hasConflict = true;
          requiresForce = true;
          loggers.api.debug('[Rollback:Preview] Member conflict check', {
            hasConflict: true,
            force,
          });

          if (!force) {
            return basePreview({
              reason: 'Member role has been changed since this update. Use force=true to override.',
              currentValues,
              hasConflict,
              conflictFields,
              requiresForce,
            });
          }
          warnings.push("This member's role has been changed since this update. Recent changes will be overwritten.");
        }
      }
    }
  } else if (activity.resourceType === 'permission' && activity.pageId) {
    const metadata = activity.metadata as { targetUserId?: string } | null;
    const targetUserId = metadata?.targetUserId || (activity.previousValues?.userId as string);

    if (targetUserId) {
      const currentPermission = await db
        .select()
        .from(pagePermissions)
        .where(and(
          eq(pagePermissions.pageId, activity.pageId),
          eq(pagePermissions.userId, targetUserId)
        ))
        .limit(1);

      if (currentPermission.length > 0) {
        currentValues = {
          userId: targetUserId,
          canView: currentPermission[0].canView,
          canEdit: currentPermission[0].canEdit,
          canShare: currentPermission[0].canShare,
          canDelete: currentPermission[0].canDelete,
          note: currentPermission[0].note,
          expiresAt: currentPermission[0].expiresAt,
          grantedBy: currentPermission[0].grantedBy,
        };
      }

      if (effectiveOperation === 'permission_grant') {
        if (rollingBackRollback) {
          // Rollback of rollback: re-granting permission, no-op if already exists
          if (currentPermission.length > 0) {
            return basePreview({
              reason: 'Permission is already granted',
              currentValues,
              isNoOp: true,
            });
          }
        } else {
          // Regular rollback: revoking permission, no-op if already revoked
          if (currentPermission.length === 0) {
            return basePreview({
              reason: 'Permission has already been revoked',
              currentValues,
              isNoOp: true,
            });
          }
        }
      }

      if (effectiveOperation === 'permission_revoke') {
        if (rollingBackRollback) {
          // Rollback of rollback: revoking permission, no-op if already revoked
          if (currentPermission.length === 0) {
            return basePreview({
              reason: 'Permission has already been revoked',
              currentValues,
              isNoOp: true,
            });
          }
        } else {
          // Regular rollback: re-granting permission, no-op if already exists
          if (currentPermission.length > 0) {
            return basePreview({
              reason: 'Permission has already been re-granted',
              currentValues,
              isNoOp: true,
            });
          }
        }
      }

      if (effectiveOperation === 'permission_update' && currentPermission.length === 0) {
        return basePreview({
          reason: 'Permission no longer exists',
          currentValues,
        });
      }

      if (currentPermission.length > 0 && effectiveOperation === 'permission_update') {
        conflictFields = getConflictFields(activity.newValues, currentValues);

        // If there's a conflict but we have undo group context, check if the modifications
        // came from other activities in the same undo group (internal conflict vs external)
        if (conflictFields.length > 0 && undoGroupActivityIds.length > 0) {
          const externalModifications = await db
            .select({ id: activityLogs.id })
            .from(activityLogs)
            .where(
              and(
                eq(activityLogs.resourceId, activity.resourceId),
                eq(activityLogs.resourceType, 'permission'),
                gt(activityLogs.timestamp, activity.timestamp),
                not(inArray(activityLogs.id, undoGroupActivityIds))
              )
            )
            .limit(1);

          if (externalModifications.length === 0) {
            // All modifications came from activities in the undo group - not a real conflict
            loggers.api.debug('[Rollback:Preview] Permission conflict is internal to undo group, ignoring', {
              activityId: activity.id,
              conflictFields,
            });
            conflictFields = [];
          }
        }

        if (conflictFields.length > 0) {
          hasConflict = true;
          requiresForce = true;
          loggers.api.debug('[Rollback:Preview] Permission conflict check', {
            hasConflict: true,
            force,
          });

          if (!force) {
            return basePreview({
              reason: 'Permissions have been changed since this update. Use force=true to override.',
              currentValues,
              hasConflict,
              conflictFields,
              requiresForce,
            });
          }
          warnings.push('These permissions have been changed since this update. Recent changes will be overwritten.');
        }
      }
    }
  } else if (activity.resourceType === 'role' && activity.driveId) {
    const metadata = activity.metadata as { roleId?: string } | null;
    const roleId = metadata?.roleId || activity.resourceId;

    // Role reorder affects all roles in the drive
    if (effectiveOperation === 'role_reorder') {
      // Get current order of roles in this drive
      const currentRoles = await db
        .select({ id: driveRoles.id, position: driveRoles.position })
        .from(driveRoles)
        .where(eq(driveRoles.driveId, activity.driveId))
        .orderBy(asc(driveRoles.position));

      currentValues = {
        order: currentRoles.map(role => role.id),
      };

      conflictFields = getConflictFields(activity.newValues, currentValues);
      if (conflictFields.length > 0) {
        hasConflict = true;
        requiresForce = true;
        loggers.api.debug('[Rollback:Preview] Role reorder conflict check', {
          hasConflict: true,
          force,
        });

        if (!force) {
          return basePreview({
            reason: 'Roles have been reordered since this change. Use force=true to override.',
            currentValues,
            hasConflict,
            conflictFields,
            requiresForce,
          });
        }
        warnings.push('Roles have been reordered since this change. Recent changes will be overwritten.');
      }
    } else if (roleId) {
      const currentRole = await db
        .select()
        .from(driveRoles)
        .where(eq(driveRoles.id, roleId))
        .limit(1);

      if (currentRole.length > 0) {
        currentValues = {
          name: currentRole[0].name,
          description: currentRole[0].description,
          color: currentRole[0].color,
          isDefault: currentRole[0].isDefault,
          permissions: currentRole[0].permissions,
          position: currentRole[0].position,
        };
      }

      if (effectiveOperation === 'create') {
        if (rollingBackRollback) {
          // Rollback of rollback: re-creating role, no-op if already exists
          if (currentRole.length > 0) {
            return basePreview({
              reason: 'Role already exists',
              currentValues,
              isNoOp: true,
            });
          }
        } else {
          // Regular rollback: deleting role, no-op if already deleted
          if (currentRole.length === 0) {
            return basePreview({
              reason: 'Role has already been deleted',
              currentValues,
              isNoOp: true,
            });
          }
        }
      }

      if (effectiveOperation === 'delete') {
        if (rollingBackRollback) {
          // Rollback of rollback: deleting role, no-op if already deleted
          if (currentRole.length === 0) {
            return basePreview({
              reason: 'Role has already been deleted',
              currentValues,
              isNoOp: true,
            });
          }
        } else {
          // Regular rollback: re-creating role, no-op if already exists
          if (currentRole.length > 0) {
            return basePreview({
              reason: 'Role already exists with this ID',
              currentValues,
              isNoOp: true,
            });
          }
        }
      }

      if (currentRole.length > 0 && effectiveOperation === 'update') {
        conflictFields = getConflictFields(activity.newValues, currentValues);
        if (conflictFields.length > 0) {
          hasConflict = true;
          requiresForce = true;
          loggers.api.debug('[Rollback:Preview] Role conflict check', {
            hasConflict: true,
            force,
          });

          if (!force) {
            return basePreview({
              reason: 'Role has been modified since this update. Use force=true to override.',
              currentValues,
              hasConflict,
              conflictFields,
              requiresForce,
            });
          }
          warnings.push('This role has been modified since this update. Recent changes will be overwritten.');
        }
      }
    }
  } else if (activity.resourceType === 'agent' && activity.pageId) {
    const currentAgent = await db
      .select({
        systemPrompt: pages.systemPrompt,
        enabledTools: pages.enabledTools,
        aiProvider: pages.aiProvider,
        aiModel: pages.aiModel,
        includeDrivePrompt: pages.includeDrivePrompt,
        agentDefinition: pages.agentDefinition,
        visibleToGlobalAssistant: pages.visibleToGlobalAssistant,
      })
      .from(pages)
      .where(eq(pages.id, activity.pageId))
      .limit(1);

    if (currentAgent.length === 0) {
      return basePreview({
        reason: 'Agent no longer exists',
      });
    }

    currentValues = {
      systemPrompt: currentAgent[0].systemPrompt,
      enabledTools: currentAgent[0].enabledTools,
      aiProvider: currentAgent[0].aiProvider,
      aiModel: currentAgent[0].aiModel,
      includeDrivePrompt: currentAgent[0].includeDrivePrompt,
      agentDefinition: currentAgent[0].agentDefinition,
      visibleToGlobalAssistant: currentAgent[0].visibleToGlobalAssistant,
    };

    conflictFields = getConflictFields(activity.newValues, currentValues);

    // If there's a conflict but we have undo group context, check if the modifications
    // came from other activities in the same undo group (internal conflict vs external)
    if (conflictFields.length > 0 && undoGroupActivityIds.length > 0) {
      const externalModifications = await db
        .select({ id: activityLogs.id })
        .from(activityLogs)
        .where(
          and(
            eq(activityLogs.resourceId, activity.resourceId),
            eq(activityLogs.resourceType, 'agent'),
            gt(activityLogs.timestamp, activity.timestamp),
            not(inArray(activityLogs.id, undoGroupActivityIds))
          )
        )
        .limit(1);

      if (externalModifications.length === 0) {
        // All modifications came from activities in the undo group - not a real conflict
        loggers.api.debug('[Rollback:Preview] Agent conflict is internal to undo group, ignoring', {
          activityId: activity.id,
          conflictFields,
        });
        conflictFields = [];
      }
    }

    if (conflictFields.length > 0) {
      hasConflict = true;
      requiresForce = true;
      loggers.api.debug('[Rollback:Preview] Agent conflict check', {
        hasConflict: true,
        force,
      });

      if (!force) {
        return basePreview({
          reason: 'Agent settings have been modified since this update. Use force=true to override.',
          currentValues,
          hasConflict,
          conflictFields,
          requiresForce,
        });
      }
      warnings.push('Agent settings have been modified since this update. Recent changes will be overwritten.');
    }
  } else if (activity.resourceType === 'message') {
    const metadata = activity.metadata as Record<string, unknown> | null;
    const conversationType = metadata?.conversationType as string | undefined;
    const isGlobal = !activity.pageId || conversationType === 'global';
    const table = isGlobal ? messages : chatMessages;

    const currentMessage = await db
      .select()
      .from(table)
      .where(eq(table.id, activity.resourceId))
      .limit(1);

    if (currentMessage.length === 0) {
      return basePreview({
        reason: 'Message no longer exists',
      });
    }

    currentValues = {
      content: currentMessage[0].content,
      isActive: currentMessage[0].isActive,
    };

    conflictFields = getConflictFields(activity.newValues, currentValues);

    // If there's a conflict but we have undo group context, check if the modifications
    // came from other activities in the same undo group (internal conflict vs external)
    if (conflictFields.length > 0 && undoGroupActivityIds.length > 0) {
      const externalModifications = await db
        .select({ id: activityLogs.id })
        .from(activityLogs)
        .where(
          and(
            eq(activityLogs.resourceId, activity.resourceId),
            eq(activityLogs.resourceType, 'message'),
            gt(activityLogs.timestamp, activity.timestamp),
            not(inArray(activityLogs.id, undoGroupActivityIds))
          )
        )
        .limit(1);

      if (externalModifications.length === 0) {
        // All modifications came from activities in the undo group - not a real conflict
        loggers.api.debug('[Rollback:Preview] Message conflict is internal to undo group, ignoring', {
          activityId: activity.id,
          conflictFields,
        });
        conflictFields = [];
      }
    }

    if (conflictFields.length > 0) {
      hasConflict = true;
      requiresForce = true;
      loggers.api.debug('[Rollback:Preview] Message conflict check', {
        hasConflict: true,
        force,
      });

      if (!force) {
        return basePreview({
          reason: 'Message has been modified since this change. Use force=true to override.',
          currentValues,
          hasConflict,
          conflictFields,
          requiresForce,
        });
      }
      warnings.push('This message has been modified since this change. Recent changes will be overwritten.');
    }
  }

  const noOp = isNoOpChange(targetValues, currentValues);
  if (noOp) {
    return basePreview({
      reason: 'Already at this version',
      currentValues,
      warnings,
      hasConflict,
      conflictFields,
      requiresForce,
      isNoOp: true,
    });
  }

  loggers.api.debug('[Rollback:Preview] Preview complete', {
    canExecute: true,
    warningsCount: warnings.length,
    targetFieldsCount: targetValues ? Object.keys(targetValues).length : 0,
  });

  return basePreview({
    canExecute: true,
    currentValues,
    warnings,
    hasConflict,
    conflictFields,
    requiresForce,
  });
}

/**
 * Preview what a rollback would do
 */
export async function previewRollback(
  activityId: string,
  userId: string,
  context: RollbackContext,
  options?: { force?: boolean; undoGroupActivityIds?: string[] }
): Promise<RollbackPreview> {
  return previewActivityAction('rollback', activityId, userId, context, options);
}

/**
 * Execute a rollback operation
 * @param options.tx - Optional transaction to use for all database operations (for atomicity)
 * @param options.force - Skip conflict check if resource was modified since activity
 */
export async function executeRollback(
  activityId: string,
  userId: string,
  context: RollbackContext,
  options?: { tx?: typeof db; force?: boolean }
): Promise<RollbackResult> {
  const { tx, force } = options ?? {};
  loggers.api.debug('[Rollback:Execute] Starting execution', {
    activityId,
    userId,
    context,
    usingTransaction: !!tx,
    force,
  });

  const preview = await previewRollback(activityId, userId, context, { force });

  if (!preview.canExecute) {
    loggers.api.debug('[Rollback:Execute] Aborting - preview check failed', {
      canExecute: preview.canExecute,
      reason: preview.reason,
      isNoOp: preview.isNoOp,
    });
    return {
      success: preview.isNoOp,
      action: 'rollback',
      status: preview.isNoOp ? 'no_op' : 'failed',
      message: preview.reason || 'Cannot rollback this activity',
      warnings: preview.warnings,
      changesApplied: preview.changes,
    };
  }

  const activity = await getActivityById(activityId);
  if (!activity) {
    return {
      success: false,
      action: 'rollback',
      status: 'failed',
      message: 'Activity not found',
      warnings: preview.warnings,
      changesApplied: preview.changes,
    };
  }

  const warnings: string[] = [...preview.warnings];
  const database = tx ?? db;
  const changeGroupId = createChangeGroupId();
  const changeGroupType = inferChangeGroupType({ isAiGenerated: false });

  // When rolling back a rollback, use the original source operation for metadata
  const rollingBackRollback = isRollingBackRollback(activity);
  if (rollingBackRollback && !activity.rollbackSourceOperation) {
    return {
      success: false,
      action: 'rollback',
      status: 'failed',
      message: 'Rollback source operation not available for this activity',
      warnings: preview.warnings,
      changesApplied: preview.changes,
    };
  }
  const effectiveSourceOperation = rollingBackRollback
    ? activity.rollbackSourceOperation as ActivityOperation
    : activity.operation as ActivityOperation;

  const pageUpdateContext: PageUpdateContext = {
    userId,
    changeGroupId,
    changeGroupType,
    source: 'restore',
    metadata: {
      action: 'rollback',
      rollbackFromActivityId: activityId,
      rollbackSourceOperation: effectiveSourceOperation,
      rollbackSourceTimestamp: activity.timestamp,
    },
  };

  try {
    // Get actor info for logging
    const actorInfo = await getActorInfo(userId);

    // Execute rollback based on resource type
    let restoredValues: Record<string, unknown> = {};
    let pageMutationMeta: PageMutationMeta | undefined;

    loggers.api.debug('[Rollback:Execute] Executing handler', {
      resourceType: activity.resourceType,
      operation: activity.operation,
      effectiveSourceOperation,
      rollingBackRollback,
      resourceId: activity.resourceId,
    });

    // When rolling back a rollback, use redo handlers (they take explicit targetValues and sourceOperation)
    // Otherwise use regular rollback handlers
    switch (activity.resourceType) {
      case 'page': {
        const result = rollingBackRollback
          ? await redoPageChange(activity, preview.targetValues, effectiveSourceOperation, database, pageUpdateContext)
          : await rollbackPageChange(activity, preview.currentValues, database, pageUpdateContext);
        restoredValues = result.restoredValues;
        pageMutationMeta = result.pageMutationMeta;
        break;
      }

      case 'drive':
        restoredValues = rollingBackRollback
          ? await redoDriveChange(activity, preview.targetValues, effectiveSourceOperation, database, pageUpdateContext)
          : await rollbackDriveChange(activity, preview.currentValues, database, pageUpdateContext);
        break;

      case 'permission':
        restoredValues = rollingBackRollback
          ? await redoPermissionChange(activity, preview.targetValues, effectiveSourceOperation, database)
          : await rollbackPermissionChange(activity, database);
        break;

      case 'agent': {
        const result = rollingBackRollback
          ? await redoAgentConfigChange(activity, preview.targetValues, database, pageUpdateContext)
          : await rollbackAgentConfigChange(activity, preview.currentValues, database, pageUpdateContext);
        restoredValues = result.restoredValues;
        pageMutationMeta = result.pageMutationMeta;
        break;
      }

      case 'member':
        restoredValues = rollingBackRollback
          ? await redoMemberChange(activity, preview.targetValues, effectiveSourceOperation, database)
          : await rollbackMemberChange(activity, database);
        break;

      case 'role':
        restoredValues = rollingBackRollback
          ? await redoRoleChange(activity, preview.targetValues, effectiveSourceOperation, database)
          : await rollbackRoleChange(activity, database);
        break;

      case 'message':
        restoredValues = rollingBackRollback
          ? await redoMessageChange(activity, preview.targetValues, effectiveSourceOperation, database)
          : await rollbackMessageChange(activity, database);
        break;

      case 'conversation':
        // Conversation undo activities are logged for audit trail but cannot be rolled back
        // because they represent the undo operation itself, not a data change
        loggers.api.debug('[Rollback:Execute] Conversation undo cannot be rolled back', {
          activityId: activity.id,
          operation: activity.operation,
        });
        return {
          success: false,
          action: 'rollback',
          status: 'failed',
          message: 'Conversation undo operations cannot be rolled back. The affected messages remain soft-deleted and can be restored individually if needed.',
          warnings,
          changesApplied: preview.changes,
        };

      default:
        loggers.api.debug('[Rollback:Execute] Unsupported resource type', {
          resourceType: activity.resourceType,
        });
        return {
          success: false,
          action: 'rollback',
          status: 'failed',
          message: `Rollback not supported for resource type: ${activity.resourceType}`,
          warnings,
          changesApplied: preview.changes,
        };
    }

    loggers.api.debug('[Rollback:Execute] Handler completed', {
      resourceType: activity.resourceType,
      restoredFieldsCount: Object.keys(restoredValues).length,
    });

    const resolvedContentSnapshot = await resolveActivityContentSnapshot(activity);

    // Log the rollback activity with source snapshot for audit trail preservation
    const logOptions: Parameters<typeof logRollbackActivity>[4] = {
      restoredValues,
      replacedValues: preview.currentValues ?? undefined,
      contentSnapshot: resolvedContentSnapshot ?? undefined,
      contentFormat: pageMutationMeta?.contentFormatAfter ?? activity.contentFormat ?? undefined,
      // Source activity snapshot - survives retention policy deletion
      // Use effectiveSourceOperation so "rollback of rollback" logs the original operation
      rollbackSourceOperation: effectiveSourceOperation,
      rollbackSourceTimestamp: rollingBackRollback
        ? (activity.rollbackSourceTimestamp ?? activity.timestamp)
        : activity.timestamp,
      rollbackSourceTitle: activity.resourceTitle ?? undefined,
      metadata: activity.metadata ? { sourceMetadata: activity.metadata } : undefined,
      changeGroupId,
      changeGroupType,
      tx,
    };

    if (pageMutationMeta) {
      logOptions.streamId = activity.pageId ?? activity.resourceId;
      logOptions.streamSeq = pageMutationMeta.nextRevision;
      logOptions.stateHashBefore = pageMutationMeta.stateHashBefore;
      logOptions.stateHashAfter = pageMutationMeta.stateHashAfter;
      logOptions.contentRef = pageMutationMeta.contentRefAfter ?? undefined;
      logOptions.contentSize = pageMutationMeta.contentSizeAfter ?? undefined;
    }

    await logRollbackActivity(
      userId,
      activityId,
      {
        resourceType: activity.resourceType,
        resourceId: activity.resourceId,
        resourceTitle: activity.resourceTitle ?? undefined,
        driveId: activity.driveId,
        pageId: activity.pageId ?? undefined,
      },
      actorInfo,
      logOptions
    );

    loggers.api.debug('[Rollback:Execute] Rollback completed successfully', {
      activityId,
      resourceType: activity.resourceType,
      resourceId: activity.resourceId,
    });

    return {
      success: true,
      action: 'rollback',
      status: 'success',
      restoredValues,
      message: 'Change undone',
      warnings,
      changesApplied: preview.changes,
    };
  } catch (error) {
    loggers.api.error('[RollbackService] Error executing rollback', {
      activityId,
      userId,
      error: error instanceof Error ? error.message : String(error),
    });

    return {
      success: false,
      action: 'rollback',
      status: 'failed',
      message: error instanceof Error ? error.message : 'Failed to execute rollback',
      warnings,
      changesApplied: preview.changes,
    };
  }
}

/**
 * Rollback a page change
 */
async function rollbackPageChange(
  activity: ActivityLogForRollback,
  _currentValues: Record<string, unknown> | null,
  database: typeof db,
  pageUpdateContext: PageUpdateContext
): Promise<PageChangeResult> {
  loggers.api.debug('[Rollback:Execute:Page] Starting page rollback', {
    pageId: activity.pageId,
    operation: activity.operation,
    updatedFields: activity.updatedFields,
  });

  if (!activity.pageId) {
    throw new Error('Page ID not found in activity');
  }

  const resolvedContentSnapshot = await resolveActivityContentSnapshot(activity);

  // Handle create operation by trashing the page
  if (activity.operation === 'create') {
    loggers.api.debug('[Rollback:Execute:Page] Trashing created page', {
      pageId: activity.pageId,
    });

    // Get the page's parent (grandparent of any children)
    const [page] = await database
      .select({ parentId: pages.parentId })
      .from(pages)
      .where(eq(pages.id, activity.pageId));

    // Orphan any children to the grandparent (matches pageService.trashPage behavior)
    // This prevents broken tree with children pointing to trashed parent
    const childPages = await database
      .select({ id: pages.id })
      .from(pages)
      .where(eq(pages.parentId, activity.pageId));

    const nextParentId = page?.parentId ?? null;
    for (const child of childPages) {
      await applyPageUpdateWithRevision(database, child.id, {
        parentId: nextParentId,
        originalParentId: activity.pageId,
      }, pageUpdateContext);
    }

    // Now trash the created page
    const pageMutationMeta = await applyPageUpdateWithRevision(database, activity.pageId, {
      isTrashed: true,
      trashedAt: new Date(),
    }, pageUpdateContext);

    return { restoredValues: { trashed: true, pageId: activity.pageId }, pageMutationMeta };
  }

  const previousValues = activity.previousValues || {};
  const updateData: Record<string, unknown> = {};

  // Restore fields that were changed
  if (activity.updatedFields) {
    for (const field of activity.updatedFields) {
      if (field in previousValues) {
        updateData[field] = previousValues[field];
      }
    }
  } else if (Object.keys(previousValues).length > 0) {
    // If no updatedFields, restore all previousValues
    Object.assign(updateData, previousValues);
  }

  // If we have a content snapshot and content was changed, use it
  if (resolvedContentSnapshot && (activity.operation === 'update' || activity.operation === 'create')) {
    updateData.content = resolvedContentSnapshot;
  }

  if (Object.keys(updateData).length === 0) {
    throw new Error('No values to restore');
  }

  loggers.api.debug('[Rollback:Execute:Page] Applying page update', {
    pageId: activity.pageId,
    fieldsToRestore: Object.keys(updateData),
  });

  // Update the page with revision/state hash
  const pageMutationMeta = await applyPageUpdateWithRevision(database, activity.pageId, updateData, pageUpdateContext);

  // If we're restoring a trashed page (isTrashed: false), also restore orphaned children
  // When pages are trashed, children are orphaned to grandparent with originalParentId set
  // Now that the parent is restored, re-parent those children back to their original parent
  if (updateData.isTrashed === false && activity.pageId) {
    const restoredChildren = await database
      .select({ id: pages.id })
      .from(pages)
      .where(eq(pages.originalParentId, activity.pageId));

    for (const child of restoredChildren) {
      await applyPageUpdateWithRevision(database, child.id, {
        parentId: activity.pageId,
        originalParentId: null,
      }, pageUpdateContext);
    }

    if (restoredChildren.length > 0) {
      loggers.api.debug('[Rollback:Execute:Page] Restored orphaned children', {
        parentPageId: activity.pageId,
        childrenRestored: restoredChildren.length,
        childIds: restoredChildren.map(c => c.id),
      });
    }
  }

  return { restoredValues: updateData, pageMutationMeta };
}

/**
 * Rollback a drive change
 */
async function rollbackDriveChange(
  activity: ActivityLogForRollback,
  _currentValues: Record<string, unknown> | null,
  database: typeof db,
  pageUpdateContext: PageUpdateContext
): Promise<Record<string, unknown>> {
  if (!activity.driveId) {
    throw new Error('Drive ID not found in activity');
  }

  // Handle create operation by trashing the drive and all its pages
  if (activity.operation === 'create') {
    loggers.api.debug('[Rollback:Execute:Drive] Trashing created drive and pages', {
      driveId: activity.driveId,
    });

    const trashedAt = new Date();
    const drivePages = await database
      .select({ id: pages.id })
      .from(pages)
      .where(eq(pages.driveId, activity.driveId));

    // First, trash all pages in the drive to prevent orphans
    for (const page of drivePages) {
      await applyPageUpdateWithRevision(database, page.id, {
        isTrashed: true,
        trashedAt,
      }, pageUpdateContext);
    }

    // Then trash the drive itself
    await database
      .update(drives)
      .set({
        isTrashed: true,
        trashedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(drives.id, activity.driveId));

    return { trashed: true, driveId: activity.driveId, pagesTrashed: true };
  }

  const previousValues = activity.previousValues || {};
  const updateData: Record<string, unknown> = {};

  // Restore fields that were changed
  if (activity.updatedFields) {
    for (const field of activity.updatedFields) {
      if (field in previousValues) {
        updateData[field] = previousValues[field];
      }
    }
  } else if (Object.keys(previousValues).length > 0) {
    Object.assign(updateData, previousValues);
  }

  if (Object.keys(updateData).length === 0) {
    throw new Error('No values to restore');
  }

  // Update the drive
  await database
    .update(drives)
    .set({
      ...updateData,
      updatedAt: new Date(),
    })
    .where(eq(drives.id, activity.driveId!));

  return updateData;
}

/**
 * Rollback a permission change
 */
async function rollbackPermissionChange(
  activity: ActivityLogForRollback,
  database: typeof db
): Promise<Record<string, unknown>> {
  const metadata = activity.metadata as { permissionId?: string; targetUserId?: string } | null;
  const previousValues = activity.previousValues || {};

  if (!activity.pageId) {
    throw new Error('Page ID not found in activity');
  }

  const targetUserId = metadata?.targetUserId || (previousValues.userId as string);
  if (!targetUserId) {
    throw new Error('Target user ID not found in activity');
  }

  switch (activity.operation) {
    case 'permission_grant': {
      // A permission was granted - rollback by deleting it
      await database
        .delete(pagePermissions)
        .where(
          and(
            eq(pagePermissions.pageId, activity.pageId),
            eq(pagePermissions.userId, targetUserId)
          )
        );

      loggers.api.info('[RollbackService] Deleted permission that was granted', {
        pageId: activity.pageId,
        userId: targetUserId,
      });

      return { deleted: true, pageId: activity.pageId, userId: targetUserId };
    }

    case 'permission_revoke': {
      // A permission was revoked - rollback by re-creating it with previous values
      const permissionData = {
        pageId: activity.pageId,
        userId: targetUserId,
        canView: (previousValues.canView as boolean) ?? false,
        canEdit: (previousValues.canEdit as boolean) ?? false,
        canShare: (previousValues.canShare as boolean) ?? false,
        canDelete: (previousValues.canDelete as boolean) ?? false,
        grantedBy: previousValues.grantedBy as string | null,
        note: previousValues.note as string | null,
      };

      await database.insert(pagePermissions).values(permissionData);

      loggers.api.info('[RollbackService] Re-created revoked permission', {
        pageId: activity.pageId,
        userId: targetUserId,
      });

      return permissionData;
    }

    case 'permission_update': {
      // A permission was updated - rollback by restoring previous values
      const updateData: Record<string, unknown> = {};

      const permissionFields = ['canView', 'canEdit', 'canShare', 'canDelete', 'note', 'expiresAt'];
      for (const field of permissionFields) {
        if (field in previousValues) {
          updateData[field] = previousValues[field];
        }
      }

      if (Object.keys(updateData).length === 0) {
        throw new Error('No permission values to restore');
      }

      await database
        .update(pagePermissions)
        .set(updateData)
        .where(
          and(
            eq(pagePermissions.pageId, activity.pageId),
            eq(pagePermissions.userId, targetUserId)
          )
        );

      loggers.api.info('[RollbackService] Restored previous permission values', {
        pageId: activity.pageId,
        userId: targetUserId,
        restoredFields: Object.keys(updateData),
      });

      return updateData;
    }

    default:
      throw new Error(`Unsupported permission operation: ${activity.operation}`);
  }
}

/**
 * Rollback an agent config change
 */
async function rollbackAgentConfigChange(
  activity: ActivityLogForRollback,
  _currentValues: Record<string, unknown> | null,
  database: typeof db,
  pageUpdateContext: PageUpdateContext
): Promise<PageChangeResult> {
  // Agent configs are stored in pages table
  if (!activity.pageId) {
    throw new Error('Page ID not found in activity');
  }

  const previousValues = activity.previousValues || {};
  const updateData: Record<string, unknown> = {};

  // Agent config fields that can be rolled back
  const agentFields = [
    'systemPrompt',
    'enabledTools',
    'aiProvider',
    'aiModel',
    'includeDrivePrompt',
    'agentDefinition',
    'visibleToGlobalAssistant',
  ];

  for (const field of agentFields) {
    if (field in previousValues) {
      updateData[field] = previousValues[field];
    }
  }

  if (Object.keys(updateData).length === 0) {
    throw new Error('No agent config values to restore');
  }

  const pageMutationMeta = await applyPageUpdateWithRevision(database, activity.pageId, updateData, pageUpdateContext);

  return { restoredValues: updateData, pageMutationMeta };
}

/**
 * Rollback a member change
 */
async function rollbackMemberChange(
  activity: ActivityLogForRollback,
  database: typeof db
): Promise<Record<string, unknown>> {
  const metadata = activity.metadata as { memberId?: string; targetUserId?: string } | null;
  const previousValues = activity.previousValues || {};

  if (!activity.driveId) {
    throw new Error('Drive ID not found in activity');
  }

  const targetUserId = metadata?.targetUserId || (previousValues.userId as string);
  if (!targetUserId) {
    throw new Error('Target user ID not found in activity');
  }

  // Determine if this was an add, remove, or role change based on operation and context
  // Note: member_add and member_remove are the actual operation names from logMemberActivity
  const wasAdded = activity.operation === 'create' || activity.operation === 'member_add' || !previousValues.role;
  const wasRemoved = activity.operation === 'delete' || activity.operation === 'trash' || activity.operation === 'member_remove';

  if (wasAdded && !wasRemoved) {
    // Member was added - rollback by removing them
    await database
      .delete(driveMembers)
      .where(
        and(
          eq(driveMembers.driveId, activity.driveId),
          eq(driveMembers.userId, targetUserId)
        )
      );

    loggers.api.info('[RollbackService] Removed member that was added', {
      driveId: activity.driveId,
      userId: targetUserId,
    });

    return { deleted: true, driveId: activity.driveId, userId: targetUserId };
  }

  if (wasRemoved) {
    // Member was removed - rollback by re-adding them with previous values
    const memberData = {
      driveId: activity.driveId,
      userId: targetUserId,
      role: (previousValues.role as 'OWNER' | 'ADMIN' | 'MEMBER') || 'MEMBER',
      customRoleId: previousValues.customRoleId as string | null,
      invitedBy: previousValues.invitedBy as string | null,
      invitedAt: previousValues.invitedAt ? new Date(previousValues.invitedAt as string) : new Date(),
      acceptedAt: previousValues.acceptedAt ? new Date(previousValues.acceptedAt as string) : new Date(),
    };

    await database.insert(driveMembers).values(memberData);

    loggers.api.info('[RollbackService] Re-added removed member', {
      driveId: activity.driveId,
      userId: targetUserId,
      role: memberData.role,
    });

    return memberData;
  }

  // Role/customRole was changed - restore previous values
  const updateData: Record<string, unknown> = {};

  if ('role' in previousValues) {
    updateData.role = previousValues.role;
  }
  if ('customRoleId' in previousValues) {
    updateData.customRoleId = previousValues.customRoleId;
  }

  if (Object.keys(updateData).length === 0) {
    throw new Error('No member values to restore');
  }

  await database
    .update(driveMembers)
    .set(updateData)
    .where(
      and(
        eq(driveMembers.driveId, activity.driveId),
        eq(driveMembers.userId, targetUserId)
      )
    );

  loggers.api.info('[RollbackService] Restored previous member values', {
    driveId: activity.driveId,
    userId: targetUserId,
    restoredFields: Object.keys(updateData),
  });

  return updateData;
}

/**
 * Rollback a role change
 */
async function rollbackRoleChange(
  activity: ActivityLogForRollback,
  database: typeof db
): Promise<Record<string, unknown>> {
  const metadata = activity.metadata as { roleId?: string } | null;
  const previousValues = activity.previousValues || {};

  if (!activity.driveId) {
    throw new Error('Drive ID not found in activity');
  }

  if (activity.operation === 'role_reorder') {
    const previousOrder = previousValues.order as string[] | undefined;
    if (!previousOrder || previousOrder.length === 0) {
      throw new Error('No previous role order found for rollback');
    }

    for (const [index, roleId] of previousOrder.entries()) {
      await database
        .update(driveRoles)
        .set({ position: index, updatedAt: new Date() })
        .where(eq(driveRoles.id, roleId));
    }

    loggers.api.info('[RollbackService] Restored previous role order', {
      driveId: activity.driveId,
      roleCount: previousOrder.length,
    });

    return { order: previousOrder };
  }

  const roleId = activity.resourceId || metadata?.roleId;
  if (!roleId) {
    throw new Error('Role ID not found in activity');
  }

  // Determine if this was a create, delete, or update
  const wasCreated = activity.operation === 'create';
  const wasDeleted = activity.operation === 'delete' || activity.operation === 'trash';

  if (wasCreated) {
    // Role was created - rollback by deleting it
    // First, capture which members had this role for audit trail
    const affectedMembers = await database
      .select({ userId: driveMembers.userId })
      .from(driveMembers)
      .where(eq(driveMembers.customRoleId, roleId));

    // Delete the role (FK constraint will set customRoleId to null for affected members)
    await database
      .delete(driveRoles)
      .where(eq(driveRoles.id, roleId));

    loggers.api.info('[RollbackService] Deleted role that was created', {
      driveId: activity.driveId,
      roleId,
      affectedMemberCount: affectedMembers.length,
    });

    return {
      deleted: true,
      roleId,
      affectedMemberUserIds: affectedMembers.map(m => m.userId),
    };
  }

  if (wasDeleted) {
    // Role was deleted - rollback by re-creating it with previous values
    const roleData = {
      id: roleId,
      driveId: activity.driveId,
      name: (previousValues.name as string) || 'Restored Role',
      description: previousValues.description as string | null,
      color: previousValues.color as string | null,
      isDefault: (previousValues.isDefault as boolean) ?? false,
      permissions: (previousValues.permissions as Record<string, { canView: boolean; canEdit: boolean; canShare: boolean }>) || {},
      position: (previousValues.position as number) ?? 0,
      updatedAt: new Date(),
    };

    await database.insert(driveRoles).values(roleData);

    loggers.api.info('[RollbackService] Re-created deleted role', {
      driveId: activity.driveId,
      roleId,
      name: roleData.name,
    });

    return roleData;
  }

  // Role was updated - restore previous values
  const updateData: Record<string, unknown> = {};

  const roleFields = ['name', 'description', 'color', 'isDefault', 'permissions', 'position'];
  for (const field of roleFields) {
    if (field in previousValues) {
      updateData[field] = previousValues[field];
    }
  }

  if (Object.keys(updateData).length === 0) {
    throw new Error('No role values to restore');
  }

  updateData.updatedAt = new Date();

  await database
    .update(driveRoles)
    .set(updateData)
    .where(eq(driveRoles.id, roleId));

  loggers.api.info('[RollbackService] Restored previous role values', {
    driveId: activity.driveId,
    roleId,
    restoredFields: Object.keys(updateData),
  });

  return updateData;
}

/**
 * Rollback a message change (edit or delete)
 */
async function rollbackMessageChange(
  activity: ActivityLogForRollback,
  database: typeof db
): Promise<Record<string, unknown>> {
  const previousValues = activity.previousValues || {};
  const messageId = activity.resourceId;

  const metadata = activity.metadata as Record<string, unknown> | null;
  const conversationType = metadata?.conversationType as string | undefined;

  // Determine which table to update based on pageId or conversationType
  // If pageId exists, it's a page chat. If not, it's likely a global chat.
  const isGlobal = !activity.pageId || conversationType === 'global';
  const table = isGlobal ? messages : chatMessages;

  switch (activity.operation) {
    case 'create': {
      // Deactivate message created during turn
      await database
        .update(table)
        .set({ isActive: false })
        .where(eq(table.id, messageId));

      loggers.api.info(`[RollbackService] Deactivated message that was created (${isGlobal ? 'global' : 'page'})`, {
        messageId,
        pageId: activity.pageId,
      });

      return { deactivated: true, isActive: false };
    }

    case 'message_update': {
      // Restore previous content, clear editedAt
      const previousContent = previousValues.content as string;
      if (!previousContent) {
        throw new Error('No previous content found for message rollback');
      }

      await database
        .update(table)
        .set({
          content: previousContent,
          editedAt: null,
        })
        .where(eq(table.id, messageId));

      loggers.api.info(`[RollbackService] Restored previous message content (${isGlobal ? 'global' : 'page'})`, {
        messageId,
        pageId: activity.pageId,
      });

      return { content: previousContent, editedAt: null };
    }

    case 'message_delete': {
      // Undelete - set isActive = true
      await database
        .update(table)
        .set({ isActive: true })
        .where(eq(table.id, messageId));

      loggers.api.info(`[RollbackService] Restored deleted message (${isGlobal ? 'global' : 'page'})`, {
        messageId,
        pageId: activity.pageId,
      });

      return { restored: true, isActive: true };
    }

    default:
      throw new Error(`Unsupported message operation: ${activity.operation}`);
  }
}

/**
 * Redo a page change (undo a rollback)
 */
async function redoPageChange(
  activity: ActivityLogForRollback,
  targetValues: Record<string, unknown> | null,
  sourceOperation: ActivityOperation,
  database: typeof db,
  pageUpdateContext: PageUpdateContext
): Promise<PageChangeResult> {
  if (!activity.pageId) {
    throw new Error('Page ID not found in activity');
  }

  const updateData: Record<string, unknown> = {};

  if (targetValues && Object.keys(targetValues).length > 0) {
    Object.assign(updateData, targetValues);
  } else if (sourceOperation === 'delete' || sourceOperation === 'trash') {
    updateData.isTrashed = true;
  } else if (sourceOperation === 'create') {
    updateData.isTrashed = false;
  }

  if (Object.keys(updateData).length === 0) {
    throw new Error('No values to restore');
  }

  if (updateData.isTrashed === true) {
    const [page] = await database
      .select({ parentId: pages.parentId })
      .from(pages)
      .where(eq(pages.id, activity.pageId));

    const childPages = await database
      .select({ id: pages.id })
      .from(pages)
      .where(eq(pages.parentId, activity.pageId));

    const nextParentId = page?.parentId ?? null;
    for (const child of childPages) {
      await applyPageUpdateWithRevision(database, child.id, {
        parentId: nextParentId,
        originalParentId: activity.pageId,
      }, pageUpdateContext);
    }

    updateData.trashedAt = new Date();
  }

  if (updateData.isTrashed === false) {
    updateData.trashedAt = null;
  }

  const pageMutationMeta = await applyPageUpdateWithRevision(database, activity.pageId, updateData, pageUpdateContext);

  if (updateData.isTrashed === false) {
    const restoredChildren = await database
      .select({ id: pages.id })
      .from(pages)
      .where(eq(pages.originalParentId, activity.pageId));

    for (const child of restoredChildren) {
      await applyPageUpdateWithRevision(database, child.id, {
        parentId: activity.pageId,
        originalParentId: null,
      }, pageUpdateContext);
    }
  }

  return { restoredValues: updateData, pageMutationMeta };
}

/**
 * Redo a drive change (undo a rollback)
 */
async function redoDriveChange(
  activity: ActivityLogForRollback,
  targetValues: Record<string, unknown> | null,
  sourceOperation: ActivityOperation,
  database: typeof db,
  pageUpdateContext: PageUpdateContext
): Promise<Record<string, unknown>> {
  if (!activity.driveId) {
    throw new Error('Drive ID not found in activity');
  }

  const updateData: Record<string, unknown> = {};

  if (targetValues && Object.keys(targetValues).length > 0) {
    Object.assign(updateData, targetValues);
  } else if (sourceOperation === 'delete' || sourceOperation === 'trash') {
    updateData.isTrashed = true;
  } else if (sourceOperation === 'create') {
    updateData.isTrashed = false;
  }

  if (Object.keys(updateData).length === 0) {
    throw new Error('No values to restore');
  }

  if (updateData.isTrashed === true) {
    const trashedAt = new Date();
    const drivePages = await database
      .select({ id: pages.id })
      .from(pages)
      .where(eq(pages.driveId, activity.driveId));

    for (const page of drivePages) {
      await applyPageUpdateWithRevision(database, page.id, {
        isTrashed: true,
        trashedAt,
      }, pageUpdateContext);
    }
    updateData.trashedAt = trashedAt;
  }

  if (updateData.isTrashed === false) {
    const drivePages = await database
      .select({ id: pages.id })
      .from(pages)
      .where(eq(pages.driveId, activity.driveId));

    for (const page of drivePages) {
      await applyPageUpdateWithRevision(database, page.id, {
        isTrashed: false,
        trashedAt: null,
      }, pageUpdateContext);
    }
    updateData.trashedAt = null;
  }

  await database
    .update(drives)
    .set({
      ...updateData,
      updatedAt: new Date(),
    })
    .where(eq(drives.id, activity.driveId));

  return updateData;
}

/**
 * Redo a permission change (undo a rollback)
 */
async function redoPermissionChange(
  activity: ActivityLogForRollback,
  targetValues: Record<string, unknown> | null,
  sourceOperation: ActivityOperation,
  database: typeof db
): Promise<Record<string, unknown>> {
  const metadata = activity.metadata as { targetUserId?: string } | null;

  if (!activity.pageId) {
    throw new Error('Page ID not found in activity');
  }

  const targetUserId =
    metadata?.targetUserId ||
    (targetValues?.userId as string | undefined) ||
    (activity.newValues?.userId as string | undefined);

  if (!targetUserId) {
    throw new Error('Target user ID not found in activity');
  }

  switch (sourceOperation) {
    case 'permission_grant': {
      if (!targetValues) {
        throw new Error('No permission values to apply');
      }

      const permissionData = {
        pageId: activity.pageId,
        userId: targetUserId,
        canView: (targetValues.canView as boolean) ?? false,
        canEdit: (targetValues.canEdit as boolean) ?? false,
        canShare: (targetValues.canShare as boolean) ?? false,
        canDelete: (targetValues.canDelete as boolean) ?? false,
        note: (targetValues.note as string) ?? null,
        expiresAt: (targetValues.expiresAt as Date | null) ?? null,
        grantedBy: (targetValues.grantedBy as string) ?? null,
      };

      await database
        .insert(pagePermissions)
        .values(permissionData)
        .onConflictDoUpdate({
          target: [pagePermissions.pageId, pagePermissions.userId],
          set: permissionData,
        });

      return permissionData;
    }

    case 'permission_update': {
      if (!targetValues) {
        throw new Error('No permission values to apply');
      }

      const updateData: Record<string, unknown> = {};
      const fields = ['canView', 'canEdit', 'canShare', 'canDelete', 'note', 'expiresAt', 'grantedBy'];
      for (const field of fields) {
        if (field in targetValues) {
          updateData[field] = targetValues[field];
        }
      }

      if (Object.keys(updateData).length === 0) {
        throw new Error('No permission values to apply');
      }

      await database
        .update(pagePermissions)
        .set(updateData)
        .where(and(
          eq(pagePermissions.pageId, activity.pageId),
          eq(pagePermissions.userId, targetUserId)
        ));

      return updateData;
    }

    case 'permission_revoke': {
      await database
        .delete(pagePermissions)
        .where(and(
          eq(pagePermissions.pageId, activity.pageId),
          eq(pagePermissions.userId, targetUserId)
        ));

      return { deleted: true, pageId: activity.pageId, userId: targetUserId };
    }

    default:
      throw new Error(`Unsupported permission operation: ${sourceOperation}`);
  }
}

/**
 * Redo a member change (undo a rollback)
 */
async function redoMemberChange(
  activity: ActivityLogForRollback,
  targetValues: Record<string, unknown> | null,
  sourceOperation: ActivityOperation,
  database: typeof db
): Promise<Record<string, unknown>> {
  const metadata = activity.metadata as { targetUserId?: string } | null;

  if (!activity.driveId) {
    throw new Error('Drive ID not found in activity');
  }

  const targetUserId =
    metadata?.targetUserId ||
    (targetValues?.userId as string | undefined) ||
    (activity.newValues?.userId as string | undefined);

  if (!targetUserId) {
    throw new Error('Target user ID not found in activity');
  }

  const parseDate = (value: unknown): Date | null => {
    if (!value) return null;
    return value instanceof Date ? value : new Date(value as string);
  };

  switch (sourceOperation) {
    case 'member_add': {
      const memberData = {
        driveId: activity.driveId,
        userId: targetUserId,
        role: (targetValues?.role as 'OWNER' | 'ADMIN' | 'MEMBER') || 'MEMBER',
        customRoleId: (targetValues?.customRoleId as string | null) ?? null,
        invitedBy: (targetValues?.invitedBy as string | null) ?? null,
        invitedAt: parseDate(targetValues?.invitedAt) ?? new Date(),
        acceptedAt: parseDate(targetValues?.acceptedAt),
      };

      await database
        .insert(driveMembers)
        .values(memberData)
        .onConflictDoUpdate({
          target: [driveMembers.driveId, driveMembers.userId],
          set: memberData,
        });

      return memberData;
    }

    case 'member_remove': {
      await database
        .delete(driveMembers)
        .where(and(
          eq(driveMembers.driveId, activity.driveId),
          eq(driveMembers.userId, targetUserId)
        ));

      return { deleted: true, driveId: activity.driveId, userId: targetUserId };
    }

    case 'member_role_change': {
      if (!targetValues) {
        throw new Error('No member values to apply');
      }

      const updateData: Record<string, unknown> = {};

      if ('role' in targetValues) {
        updateData.role = targetValues.role;
      }
      if ('customRoleId' in targetValues) {
        updateData.customRoleId = targetValues.customRoleId;
      }

      if (Object.keys(updateData).length === 0) {
        throw new Error('No member values to apply');
      }

      await database
        .update(driveMembers)
        .set(updateData)
        .where(and(
          eq(driveMembers.driveId, activity.driveId),
          eq(driveMembers.userId, targetUserId)
        ));

      return updateData;
    }

    default:
      throw new Error(`Unsupported member operation: ${sourceOperation}`);
  }
}

/**
 * Redo a role change (undo a rollback)
 */
async function redoRoleChange(
  activity: ActivityLogForRollback,
  targetValues: Record<string, unknown> | null,
  sourceOperation: ActivityOperation,
  database: typeof db
): Promise<Record<string, unknown>> {
  const metadata = activity.metadata as { roleId?: string } | null;
  const roleId = metadata?.roleId || activity.resourceId;

  if (!activity.driveId) {
    throw new Error('Drive ID not found in activity');
  }

  if (!roleId) {
    throw new Error('Role ID not found in activity');
  }

  if (sourceOperation === 'role_reorder') {
    const order = (targetValues?.order as string[] | undefined) ?? [];
    if (order.length === 0) {
      throw new Error('No role order found to apply');
    }

    for (const [index, targetRoleId] of order.entries()) {
      await database
        .update(driveRoles)
        .set({ position: index, updatedAt: new Date() })
        .where(eq(driveRoles.id, targetRoleId));
    }

    return { order };
  }

  switch (sourceOperation) {
    case 'create': {
      if (!targetValues) {
        throw new Error('No role values to apply');
      }

      const roleData = {
        id: roleId,
        driveId: activity.driveId,
        name: (targetValues.name as string) || 'Restored Role',
        description: (targetValues.description as string | null) ?? null,
        color: (targetValues.color as string | null) ?? null,
        isDefault: (targetValues.isDefault as boolean) ?? false,
        permissions: (targetValues.permissions as Record<string, { canView: boolean; canEdit: boolean; canShare: boolean }>) || {},
        position: (targetValues.position as number) ?? 0,
        updatedAt: new Date(),
      };

      await database.insert(driveRoles).values(roleData);

      return roleData;
    }

    case 'delete': {
      const affectedMembers = await database
        .select({ userId: driveMembers.userId })
        .from(driveMembers)
        .where(eq(driveMembers.customRoleId, roleId));

      await database
        .delete(driveRoles)
        .where(eq(driveRoles.id, roleId));

      return {
        deleted: true,
        roleId,
        affectedMemberUserIds: affectedMembers.map(member => member.userId),
      };
    }

    case 'update': {
      if (!targetValues) {
        throw new Error('No role values to apply');
      }

      const updateData: Record<string, unknown> = {};
      const fields = ['name', 'description', 'color', 'isDefault', 'permissions', 'position'];
      for (const field of fields) {
        if (field in targetValues) {
          updateData[field] = targetValues[field];
        }
      }

      if (Object.keys(updateData).length === 0) {
        throw new Error('No role values to apply');
      }

      updateData.updatedAt = new Date();

      await database
        .update(driveRoles)
        .set(updateData)
        .where(eq(driveRoles.id, roleId));

      return updateData;
    }

    default:
      throw new Error(`Unsupported role operation: ${sourceOperation}`);
  }
}

/**
 * Redo agent config change (undo a rollback)
 */
async function redoAgentConfigChange(
  activity: ActivityLogForRollback,
  targetValues: Record<string, unknown> | null,
  database: typeof db,
  pageUpdateContext: PageUpdateContext
): Promise<PageChangeResult> {
  if (!activity.pageId) {
    throw new Error('Page ID not found in activity');
  }

  if (!targetValues) {
    throw new Error('No agent values to apply');
  }

  const updateData: Record<string, unknown> = {};
  const fields = ['systemPrompt', 'enabledTools', 'aiProvider', 'aiModel', 'includeDrivePrompt', 'agentDefinition', 'visibleToGlobalAssistant'];

  for (const field of fields) {
    if (field in targetValues) {
      updateData[field] = targetValues[field];
    }
  }

  if (Object.keys(updateData).length === 0) {
    throw new Error('No agent values to apply');
  }

  const pageMutationMeta = await applyPageUpdateWithRevision(database, activity.pageId, updateData, pageUpdateContext);

  return { restoredValues: updateData, pageMutationMeta };
}

/**
 * Redo a message change (undo a rollback)
 */
async function redoMessageChange(
  activity: ActivityLogForRollback,
  targetValues: Record<string, unknown> | null,
  sourceOperation: ActivityOperation,
  database: typeof db
): Promise<Record<string, unknown>> {
  const metadata = activity.metadata as Record<string, unknown> | null;
  const conversationType = metadata?.conversationType as string | undefined;
  const isGlobal = !activity.pageId || conversationType === 'global';
  const table = isGlobal ? messages : chatMessages;

  const updateData: Record<string, unknown> = {};

  switch (sourceOperation) {
    case 'message_update': {
      const content = targetValues?.content as string | undefined;
      if (!content) {
        throw new Error('No message content to apply');
      }
      updateData.content = content;
      updateData.editedAt = new Date();
      break;
    }

    case 'message_delete': {
      updateData.isActive = false;
      break;
    }

    case 'create': {
      updateData.isActive = true;
      break;
    }

    default:
      throw new Error(`Unsupported message operation: ${sourceOperation}`);
  }

  await database
    .update(table)
    .set(updateData)
    .where(eq(table.id, activity.resourceId));

  return updateData;
}

/**
 * Get version history for a page
 */
export async function getPageVersionHistory(
  pageId: string,
  userId: string,
  options: VersionHistoryOptions = {}
): Promise<{ activities: ActivityLogForRollback[]; total: number }> {
  const { limit = 50, offset = 0, startDate, endDate, actorId, operation, includeAiOnly } = options;

  loggers.api.debug('[History:Fetch] Fetching page version history', {
    pageId,
    userId,
    limit,
    offset,
    hasFilters: !!(startDate || endDate || actorId || operation || includeAiOnly),
  });

  try {
    const conditions = [eq(activityLogs.pageId, pageId)];

    if (startDate) {
      conditions.push(gte(activityLogs.timestamp, startDate));
    }
    if (endDate) {
      conditions.push(lte(activityLogs.timestamp, endDate));
    }
    if (actorId) {
      conditions.push(eq(activityLogs.userId, actorId));
    }
    if (operation && isValidOperation(operation)) {
      conditions.push(eq(activityLogs.operation, operation as typeof activityLogs.operation.enumValues[number]));
    }
    if (includeAiOnly) {
      conditions.push(eq(activityLogs.isAiGenerated, true));
    }

    const [activities, countResult] = await Promise.all([
      db
        .select()
        .from(activityLogs)
        .where(and(...conditions))
        .orderBy(desc(activityLogs.timestamp))
        .limit(limit)
        .offset(offset),
      db
        .select({ value: count() })
        .from(activityLogs)
        .where(and(...conditions)),
    ]);

    loggers.api.debug('[History:Fetch] Page history query complete', {
      pageId,
      activitiesCount: activities.length,
      total: countResult[0]?.value ?? 0,
    });

    return {
      activities: activities.map((a) => ({
        id: a.id,
        timestamp: a.timestamp,
        userId: a.userId,
        actorEmail: a.actorEmail,
        actorDisplayName: a.actorDisplayName,
        operation: a.operation,
        resourceType: a.resourceType as ActivityResourceType,
        resourceId: a.resourceId,
        resourceTitle: a.resourceTitle,
        driveId: a.driveId,
        pageId: a.pageId,
        isAiGenerated: a.isAiGenerated,
        aiProvider: a.aiProvider,
        aiModel: a.aiModel,
        contentSnapshot: a.contentSnapshot,
        contentRef: a.contentRef,
        contentFormat: a.contentFormat as PageContentFormat | null,
        contentSize: a.contentSize,
        updatedFields: a.updatedFields as string[] | null,
        previousValues: a.previousValues as Record<string, unknown> | null,
        newValues: a.newValues as Record<string, unknown> | null,
        metadata: a.metadata as Record<string, unknown> | null,
        streamId: a.streamId,
        streamSeq: a.streamSeq,
        changeGroupId: a.changeGroupId,
        changeGroupType: a.changeGroupType as ChangeGroupType | null,
        stateHashBefore: a.stateHashBefore,
        stateHashAfter: a.stateHashAfter,
        rollbackFromActivityId: a.rollbackFromActivityId,
        rollbackSourceOperation: a.rollbackSourceOperation as ActivityOperation | null,
        rollbackSourceTimestamp: a.rollbackSourceTimestamp,
        rollbackSourceTitle: a.rollbackSourceTitle,
      })),
      total: countResult[0]?.value ?? 0,
    };
  } catch (error) {
    loggers.api.error('[RollbackService] Error fetching page version history', {
      pageId,
      error: error instanceof Error ? error.message : String(error),
    });
    return { activities: [], total: 0 };
  }
}

/**
 * Get version history for a drive (admin view)
 */
export async function getDriveVersionHistory(
  driveId: string,
  userId: string,
  options: VersionHistoryOptions = {}
): Promise<{ activities: ActivityLogForRollback[]; total: number }> {
  const { limit = 50, offset = 0, startDate, endDate, actorId, operation, resourceType } = options;

  loggers.api.debug('[History:Fetch] Fetching drive version history', {
    driveId,
    userId,
    limit,
    offset,
    hasFilters: !!(startDate || endDate || actorId || operation || resourceType),
  });

  try {
    const conditions = [eq(activityLogs.driveId, driveId)];

    if (startDate) {
      conditions.push(gte(activityLogs.timestamp, startDate));
    }
    if (endDate) {
      conditions.push(lte(activityLogs.timestamp, endDate));
    }
    if (actorId) {
      conditions.push(eq(activityLogs.userId, actorId));
    }
    if (operation && isValidOperation(operation)) {
      conditions.push(eq(activityLogs.operation, operation as typeof activityLogs.operation.enumValues[number]));
    }
    if (resourceType) {
      conditions.push(eq(activityLogs.resourceType, resourceType as typeof activityLogs.resourceType.enumValues[number]));
    }

    const [activities, countResult] = await Promise.all([
      db
        .select()
        .from(activityLogs)
        .where(and(...conditions))
        .orderBy(desc(activityLogs.timestamp))
        .limit(limit)
        .offset(offset),
      db
        .select({ value: count() })
        .from(activityLogs)
        .where(and(...conditions)),
    ]);

    loggers.api.debug('[History:Fetch] Drive history query complete', {
      driveId,
      activitiesCount: activities.length,
      total: countResult[0]?.value ?? 0,
    });

    return {
      activities: activities.map((a) => ({
        id: a.id,
        timestamp: a.timestamp,
        userId: a.userId,
        actorEmail: a.actorEmail,
        actorDisplayName: a.actorDisplayName,
        operation: a.operation,
        resourceType: a.resourceType as ActivityResourceType,
        resourceId: a.resourceId,
        resourceTitle: a.resourceTitle,
        driveId: a.driveId,
        pageId: a.pageId,
        isAiGenerated: a.isAiGenerated,
        aiProvider: a.aiProvider,
        aiModel: a.aiModel,
        contentSnapshot: a.contentSnapshot,
        contentRef: a.contentRef,
        contentFormat: a.contentFormat as PageContentFormat | null,
        contentSize: a.contentSize,
        updatedFields: a.updatedFields as string[] | null,
        previousValues: a.previousValues as Record<string, unknown> | null,
        newValues: a.newValues as Record<string, unknown> | null,
        metadata: a.metadata as Record<string, unknown> | null,
        streamId: a.streamId,
        streamSeq: a.streamSeq,
        changeGroupId: a.changeGroupId,
        changeGroupType: a.changeGroupType as ChangeGroupType | null,
        stateHashBefore: a.stateHashBefore,
        stateHashAfter: a.stateHashAfter,
        rollbackFromActivityId: a.rollbackFromActivityId,
        rollbackSourceOperation: a.rollbackSourceOperation as ActivityOperation | null,
        rollbackSourceTimestamp: a.rollbackSourceTimestamp,
        rollbackSourceTitle: a.rollbackSourceTitle,
      })),
      total: countResult[0]?.value ?? 0,
    };
  } catch (error) {
    loggers.api.error('[RollbackService] Error fetching drive version history', {
      driveId,
      error: error instanceof Error ? error.message : String(error),
    });
    return { activities: [], total: 0 };
  }
}

/**
 * Get user's retention limit based on subscription tier
 */
export async function getUserRetentionDays(userId: string): Promise<number> {
  // Default retention days by tier (ordered: free < pro < founder < business)
  const defaultRetention: Record<string, number> = {
    free: 7,
    pro: 30,
    founder: 90,
    business: -1, // unlimited
  };

  try {
    // Get user's subscription tier
    const user = await db
      .select({ subscriptionTier: users.subscriptionTier })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);

    if (user.length === 0) {
      return defaultRetention.free;
    }

    const tier = user[0].subscriptionTier || 'free';
    return defaultRetention[tier] || defaultRetention.free;
  } catch (error) {
    loggers.api.error('[RollbackService] Error getting user retention days', {
      userId,
      error: error instanceof Error ? error.message : String(error),
    });
    return defaultRetention.free;
  }
}
