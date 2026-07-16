/**
 * Redo op-plans (undo a rollback).
 *
 * Pure functions turning a rollback-of-a-rollback into an op-plan describing the
 * forward DB mutation. Mirrors rollback-plans.ts: effects (cascade reads,
 * writes) live in the executor; `now` is injected for determinism.
 */
import { restoreFields } from './page-mutation-plan';
import type { ActivityLogForRollback } from './types';
import type { ActivityOperation } from '@pagespace/lib/monitoring/activity-logger';
import type {
  PermissionInsertValues,
  MemberInsertValues,
  RoleInsertValues,
} from './rollback-plans';

type Values = Record<string, unknown>;

/** Shared update-data resolution for page/drive redo (identical cascade shape). */
function resolveTrashableRedoUpdateData(
  targetValues: Values | null,
  sourceOperation: ActivityOperation
): Values {
  const updateData: Values = {};
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
  return updateData;
}

// ─── Page ──────────────────────────────────────────────────────────────────

/** Plan the update-data for a page redo; the executor applies the isTrashed cascade. */
export function planPageRedo(targetValues: Values | null, sourceOperation: ActivityOperation): Values {
  return resolveTrashableRedoUpdateData(targetValues, sourceOperation);
}

// ─── Drive ─────────────────────────────────────────────────────────────────

/** Plan the update-data for a drive redo; the executor applies the isTrashed cascade. */
export function planDriveRedo(targetValues: Values | null, sourceOperation: ActivityOperation): Values {
  return resolveTrashableRedoUpdateData(targetValues, sourceOperation);
}

// ─── Permission ────────────────────────────────────────────────────────────

export interface PermissionRedoInsertValues extends PermissionInsertValues {
  note: string | null;
  expiresAt: Date | null;
  grantedBy: string | null;
}

export type PermissionRedoPlan =
  | { op: 'upsert'; pageId: string; userId: string; values: PermissionRedoInsertValues }
  | { op: 'update'; pageId: string; userId: string; set: Values }
  | { op: 'delete'; pageId: string; userId: string };

export function planPermissionRedo(
  activity: ActivityLogForRollback,
  targetValues: Values | null,
  sourceOperation: ActivityOperation
): PermissionRedoPlan {
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
      return {
        op: 'upsert',
        pageId: activity.pageId,
        userId: targetUserId,
        values: {
          pageId: activity.pageId,
          userId: targetUserId,
          canView: (targetValues.canView as boolean) ?? false,
          canEdit: (targetValues.canEdit as boolean) ?? false,
          canShare: (targetValues.canShare as boolean) ?? false,
          canDelete: (targetValues.canDelete as boolean) ?? false,
          note: (targetValues.note as string) ?? null,
          expiresAt: (targetValues.expiresAt as Date | null) ?? null,
          grantedBy: (targetValues.grantedBy as string) ?? null,
        },
      };
    }

    case 'permission_update': {
      if (!targetValues) {
        throw new Error('No permission values to apply');
      }
      const set = restoreFields(['canView', 'canEdit', 'canShare', 'canDelete', 'note', 'expiresAt', 'grantedBy'], targetValues);
      if (Object.keys(set).length === 0) {
        throw new Error('No permission values to apply');
      }
      return { op: 'update', pageId: activity.pageId, userId: targetUserId, set };
    }

    case 'permission_revoke':
      return { op: 'delete', pageId: activity.pageId, userId: targetUserId };

    default:
      throw new Error(`Unsupported permission operation: ${sourceOperation}`);
  }
}

// ─── Agent ─────────────────────────────────────────────────────────────────

export function planAgentRedo(
  activity: ActivityLogForRollback,
  targetValues: Values | null,
  agentFields: readonly string[]
): { updateData: Values } {
  if (!activity.pageId) {
    throw new Error('Page ID not found in activity');
  }
  if (!targetValues) {
    throw new Error('No agent values to apply');
  }
  const updateData = restoreFields(agentFields, targetValues);
  if (Object.keys(updateData).length === 0) {
    throw new Error('No agent values to apply');
  }
  return { updateData };
}

// ─── Member ────────────────────────────────────────────────────────────────

function parseDate(value: unknown): Date | null {
  if (!value) return null;
  return value instanceof Date ? value : new Date(value as string);
}

export interface MemberRedoInsertValues extends Omit<MemberInsertValues, 'acceptedAt'> {
  acceptedAt: Date | null;
}

export type MemberRedoPlan =
  | { op: 'upsert'; values: MemberRedoInsertValues }
  | { op: 'delete'; driveId: string; userId: string }
  | { op: 'update'; driveId: string; userId: string; set: Values };

export function planMemberRedo(
  activity: ActivityLogForRollback,
  targetValues: Values | null,
  sourceOperation: ActivityOperation,
  now: Date
): MemberRedoPlan {
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

  switch (sourceOperation) {
    case 'member_add':
      return {
        op: 'upsert',
        values: {
          driveId: activity.driveId,
          userId: targetUserId,
          role: (targetValues?.role as 'OWNER' | 'ADMIN' | 'MEMBER') || 'MEMBER',
          customRoleId: (targetValues?.customRoleId as string | null) ?? null,
          invitedBy: (targetValues?.invitedBy as string | null) ?? null,
          invitedAt: parseDate(targetValues?.invitedAt) ?? now,
          acceptedAt: parseDate(targetValues?.acceptedAt),
        },
      };

    case 'member_remove':
      return { op: 'delete', driveId: activity.driveId, userId: targetUserId };

    case 'member_role_change': {
      if (!targetValues) {
        throw new Error('No member values to apply');
      }
      const set = restoreFields(['role', 'customRoleId'], targetValues);
      if (Object.keys(set).length === 0) {
        throw new Error('No member values to apply');
      }
      return { op: 'update', driveId: activity.driveId, userId: targetUserId, set };
    }

    default:
      throw new Error(`Unsupported member operation: ${sourceOperation}`);
  }
}

// ─── Role ──────────────────────────────────────────────────────────────────

export type RoleRedoPlan =
  | { op: 'reorder'; order: string[] }
  | { op: 'insert-role'; values: RoleInsertValues }
  | { op: 'delete-role'; roleId: string }
  | { op: 'update-role'; roleId: string; set: Values };

export function planRoleRedo(
  activity: ActivityLogForRollback,
  targetValues: Values | null,
  sourceOperation: ActivityOperation,
  now: Date
): RoleRedoPlan {
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
    return { op: 'reorder', order };
  }

  switch (sourceOperation) {
    case 'create': {
      if (!targetValues) {
        throw new Error('No role values to apply');
      }
      return {
        op: 'insert-role',
        values: {
          id: roleId,
          driveId: activity.driveId,
          name: (targetValues.name as string) || 'Restored Role',
          description: (targetValues.description as string | null) ?? null,
          color: (targetValues.color as string | null) ?? null,
          isDefault: (targetValues.isDefault as boolean) ?? false,
          permissions: (targetValues.permissions as RoleInsertValues['permissions']) || {},
          position: (targetValues.position as number) ?? 0,
          updatedAt: now,
        },
      };
    }

    case 'delete':
      return { op: 'delete-role', roleId };

    case 'update': {
      if (!targetValues) {
        throw new Error('No role values to apply');
      }
      const set = restoreFields(['name', 'description', 'color', 'isDefault', 'permissions', 'position'], targetValues);
      if (Object.keys(set).length === 0) {
        throw new Error('No role values to apply');
      }
      set.updatedAt = now;
      return { op: 'update-role', roleId, set };
    }

    default:
      throw new Error(`Unsupported role operation: ${sourceOperation}`);
  }
}

// ─── Message ───────────────────────────────────────────────────────────────

/**
 * Plan the update-data for a message redo. `isChannel` decides whether editedAt
 * is stamped (channelMessages has no editedAt column). `now` is the edit time.
 */
export function planMessageRedo(
  targetValues: Values | null,
  sourceOperation: ActivityOperation,
  isChannel: boolean,
  now: Date
): Values {
  const updateData: Values = {};

  switch (sourceOperation) {
    case 'message_update': {
      const content = targetValues?.content as string | undefined;
      if (!content) {
        throw new Error('No message content to apply');
      }
      updateData.content = content;
      if (!isChannel) {
        updateData.editedAt = now;
      }
      break;
    }

    case 'message_delete':
      updateData.isActive = false;
      break;

    case 'create':
      updateData.isActive = true;
      break;

    default:
      throw new Error(`Unsupported message operation: ${sourceOperation}`);
  }

  return updateData;
}
