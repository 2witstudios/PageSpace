/**
 * Rollback op-plans.
 *
 * Pure functions that turn a recorded activity into an op-plan describing the
 * DB mutation a rollback should perform — as data, not effects. The thin
 * executor shell interprets each plan against the database. Timestamps are
 * injected as `now` so the planning stays deterministic and testable; reads
 * needed for a cascade (children, affected members) are performed by the
 * executor, not baked into the plan.
 */
import { restoreFields } from './page-mutation-plan';
import type { ActivityLogForRollback } from './types';

type Values = Record<string, unknown>;

/**
 * Restore the changed fields for a page/drive rollback: the listed updatedFields
 * from previousValues, or — when no updatedFields were recorded — every
 * previousValue. Shared by the page and drive plans.
 */
function restoreChangedFields(activity: ActivityLogForRollback): Values {
  const previousValues = activity.previousValues || {};
  const updateData: Values = {};
  if (activity.updatedFields) {
    Object.assign(updateData, restoreFields(activity.updatedFields, previousValues));
  } else if (Object.keys(previousValues).length > 0) {
    Object.assign(updateData, previousValues);
  }
  return updateData;
}

// ─── Page ──────────────────────────────────────────────────────────────────

export type PageRollbackPlan =
  | { kind: 'trash-created' }
  | { kind: 'apply-update'; updateData: Values; restoreOrphanedChildren: boolean };

/**
 * Plan a page rollback. A create is undone by trashing the page and orphaning
 * its children to the grandparent (the executor performs those reads/writes);
 * otherwise the recorded fields are restored, and if the page is being
 * un-trashed its orphaned children are re-parented.
 */
export function planPageRollback(
  activity: ActivityLogForRollback,
  resolvedContentSnapshot: string | null
): PageRollbackPlan {
  if (!activity.pageId) {
    throw new Error('Page ID not found in activity');
  }

  if (activity.operation === 'create') {
    return { kind: 'trash-created' };
  }

  const updateData = restoreChangedFields(activity);

  // A create already returned above, so only an update injects the snapshot here.
  if (resolvedContentSnapshot && activity.operation === 'update') {
    updateData.content = resolvedContentSnapshot;
  }

  if (Object.keys(updateData).length === 0) {
    throw new Error('No values to restore');
  }

  return {
    kind: 'apply-update',
    updateData,
    restoreOrphanedChildren: updateData.isTrashed === false,
  };
}

// ─── Drive ─────────────────────────────────────────────────────────────────

export type DriveRollbackPlan =
  | { kind: 'trash-created' }
  | { kind: 'apply-update'; updateData: Values };

/** Plan a drive rollback: a create trashes the drive and its pages; else restore fields. */
export function planDriveRollback(activity: ActivityLogForRollback): DriveRollbackPlan {
  if (!activity.driveId) {
    throw new Error('Drive ID not found in activity');
  }

  if (activity.operation === 'create') {
    return { kind: 'trash-created' };
  }

  const updateData = restoreChangedFields(activity);

  if (Object.keys(updateData).length === 0) {
    throw new Error('No values to restore');
  }

  return { kind: 'apply-update', updateData };
}

// ─── Permission ────────────────────────────────────────────────────────────

export interface PermissionInsertValues {
  pageId: string;
  userId: string;
  canView: boolean;
  canEdit: boolean;
  canShare: boolean;
  canDelete: boolean;
  grantedBy: string | null;
  note: string | null;
}

export type PermissionRollbackPlan =
  | { op: 'delete'; pageId: string; userId: string }
  | { op: 'insert'; values: PermissionInsertValues }
  | { op: 'update'; pageId: string; userId: string; set: Values };

/** Plan a permission rollback: delete a granted permission, re-insert a revoked one, or restore updated fields. */
export function planPermissionRollback(activity: ActivityLogForRollback): PermissionRollbackPlan {
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
    case 'permission_grant':
      return { op: 'delete', pageId: activity.pageId, userId: targetUserId };

    case 'permission_revoke':
      return {
        op: 'insert',
        values: {
          pageId: activity.pageId,
          userId: targetUserId,
          canView: (previousValues.canView as boolean) ?? false,
          canEdit: (previousValues.canEdit as boolean) ?? false,
          canShare: (previousValues.canShare as boolean) ?? false,
          canDelete: (previousValues.canDelete as boolean) ?? false,
          grantedBy: previousValues.grantedBy as string | null,
          note: previousValues.note as string | null,
        },
      };

    case 'permission_update': {
      const set = restoreFields(['canView', 'canEdit', 'canShare', 'canDelete', 'note', 'expiresAt'], previousValues);
      if (Object.keys(set).length === 0) {
        throw new Error('No permission values to restore');
      }
      return { op: 'update', pageId: activity.pageId, userId: targetUserId, set };
    }

    default:
      throw new Error(`Unsupported permission operation: ${activity.operation}`);
  }
}

// ─── Agent ─────────────────────────────────────────────────────────────────

/** Plan an agent-config rollback: restore the whitelisted config fields onto the page. */
export function planAgentRollback(
  activity: ActivityLogForRollback,
  agentFields: readonly string[]
): { updateData: Values } {
  if (!activity.pageId) {
    throw new Error('Page ID not found in activity');
  }
  const previousValues = activity.previousValues || {};
  const updateData = restoreFields(agentFields, previousValues);
  if (Object.keys(updateData).length === 0) {
    throw new Error('No agent config values to restore');
  }
  return { updateData };
}

// ─── Member ────────────────────────────────────────────────────────────────

export interface MemberInsertValues {
  driveId: string;
  userId: string;
  role: 'OWNER' | 'ADMIN' | 'MEMBER';
  customRoleId: string | null;
  invitedBy: string | null;
  invitedAt: Date;
  acceptedAt: Date;
}

export type MemberRollbackPlan =
  | { op: 'delete'; driveId: string; userId: string }
  | { op: 'insert'; values: MemberInsertValues }
  | { op: 'update'; driveId: string; userId: string; set: Values };

/** Plan a member rollback: remove an added member, re-insert a removed one (dates default to now), or restore a changed role. */
export function planMemberRollback(activity: ActivityLogForRollback, now: Date): MemberRollbackPlan {
  const metadata = activity.metadata as { memberId?: string; targetUserId?: string } | null;
  const previousValues = activity.previousValues || {};

  if (!activity.driveId) {
    throw new Error('Drive ID not found in activity');
  }

  const targetUserId = metadata?.targetUserId || (previousValues.userId as string);
  if (!targetUserId) {
    throw new Error('Target user ID not found in activity');
  }

  const wasAdded = activity.operation === 'create' || activity.operation === 'member_add' || !previousValues.role;
  const wasRemoved = activity.operation === 'delete' || activity.operation === 'trash' || activity.operation === 'member_remove';

  if (wasAdded && !wasRemoved) {
    return { op: 'delete', driveId: activity.driveId, userId: targetUserId };
  }

  if (wasRemoved) {
    return {
      op: 'insert',
      values: {
        driveId: activity.driveId,
        userId: targetUserId,
        role: (previousValues.role as 'OWNER' | 'ADMIN' | 'MEMBER') || 'MEMBER',
        customRoleId: previousValues.customRoleId as string | null,
        invitedBy: previousValues.invitedBy as string | null,
        invitedAt: previousValues.invitedAt ? new Date(previousValues.invitedAt as string) : now,
        acceptedAt: previousValues.acceptedAt ? new Date(previousValues.acceptedAt as string) : now,
      },
    };
  }

  // Reaching here means wasAdded is false, which requires previousValues.role to
  // be truthy, so restoreFields always yields at least the role — the original's
  // empty-set guard here was unreachable and is intentionally dropped.
  const set = restoreFields(['role', 'customRoleId'], previousValues);
  return { op: 'update', driveId: activity.driveId, userId: targetUserId, set };
}

// ─── Role ──────────────────────────────────────────────────────────────────

export interface RoleInsertValues {
  id: string;
  driveId: string;
  name: string;
  description: string | null;
  color: string | null;
  isDefault: boolean;
  permissions: Record<string, { canView: boolean; canEdit: boolean; canShare: boolean }>;
  position: number;
  updatedAt: Date;
}

export type RoleRollbackPlan =
  | { op: 'reorder'; order: string[] }
  | { op: 'delete-role'; roleId: string }
  | { op: 'insert-role'; values: RoleInsertValues }
  | { op: 'update-role'; roleId: string; set: Values };

/** Plan a role rollback: restore a reorder, delete a created role, re-insert a deleted one, or restore updated fields (stamped with now). */
export function planRoleRollback(activity: ActivityLogForRollback, now: Date): RoleRollbackPlan {
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
    return { op: 'reorder', order: previousOrder };
  }

  const roleId = activity.resourceId || metadata?.roleId;
  if (!roleId) {
    throw new Error('Role ID not found in activity');
  }

  const wasCreated = activity.operation === 'create';
  const wasDeleted = activity.operation === 'delete' || activity.operation === 'trash';

  if (wasCreated) {
    return { op: 'delete-role', roleId };
  }

  if (wasDeleted) {
    return {
      op: 'insert-role',
      values: {
        id: roleId,
        driveId: activity.driveId,
        name: (previousValues.name as string) || 'Restored Role',
        description: previousValues.description as string | null,
        color: previousValues.color as string | null,
        isDefault: (previousValues.isDefault as boolean) ?? false,
        permissions: (previousValues.permissions as RoleInsertValues['permissions']) || {},
        position: (previousValues.position as number) ?? 0,
        updatedAt: now,
      },
    };
  }

  const set = restoreFields(['name', 'description', 'color', 'isDefault', 'permissions', 'position'], previousValues);
  if (Object.keys(set).length === 0) {
    throw new Error('No role values to restore');
  }
  set.updatedAt = now;
  return { op: 'update-role', roleId, set };
}

// ─── Message ───────────────────────────────────────────────────────────────

export interface MessageRollbackPlan {
  set: Values;
  returnValue: Values;
}

/**
 * Plan a message rollback. `isChannel` (from pickConversationTable) decides
 * whether editedAt is cleared: channelMessages has no editedAt column, so a
 * channel edit restores content only, while the return value is uniform.
 */
export function planMessageRollback(activity: ActivityLogForRollback, isChannel: boolean): MessageRollbackPlan {
  const previousValues = activity.previousValues || {};

  switch (activity.operation) {
    case 'create':
      return { set: { isActive: false }, returnValue: { deactivated: true, isActive: false } };

    case 'message_update': {
      const previousContent = previousValues.content as string;
      if (!previousContent) {
        throw new Error('No previous content found for message rollback');
      }
      return {
        set: isChannel ? { content: previousContent } : { content: previousContent, editedAt: null },
        returnValue: { content: previousContent, editedAt: null },
      };
    }

    case 'message_delete':
      return { set: { isActive: true }, returnValue: { restored: true, isActive: true } };

    default:
      throw new Error(`Unsupported message operation: ${activity.operation}`);
  }
}
