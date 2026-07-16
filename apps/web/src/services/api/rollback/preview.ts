/**
 * Preview shell.
 *
 * Builds a rollback/redo preview against the injected deps: fetches the current
 * resource state, runs the pure eligibility/no-op/conflict decisions, and reports
 * whether the action can execute. `previewFromActivity` takes an already-fetched
 * activity + resolved snapshot so executeRollback can fetch them once and reuse.
 */
import { eq, and, gt, asc, not, inArray } from '@pagespace/db/operators';
import { pages, drives } from '@pagespace/db/schema/core';
import { driveMembers, driveRoles, pagePermissions } from '@pagespace/db/schema/members';
import { activityLogs } from '@pagespace/db/schema/monitoring';
import type { ActivityAction, ActivityActionPreview } from '@/types/activity-actions';
import type { ActivityResourceType } from '@pagespace/lib/monitoring/activity-logger';
import type { RollbackContext } from '@pagespace/lib/permissions/rollback-permissions';
import { getConflictFields, classifyUndoGroupConflict, isNoOpChange } from './conflict';
import {
  buildActionTargetValues,
  buildChangeSummary,
  getEffectiveOperation,
  isRollingBackRollback,
} from './target-values';
import { REDO_ALLOW_MISSING_TARGET, ROLLBACK_ALLOW_MISSING_TARGET } from './operations';
import { buildPreview, evaluateEligibility, evaluateCreateNoOp } from './preview-eligibility';
import { pickConversationTable } from './page-mutation-plan';
import { getActivityById } from './activity-repo';
import { resolveActivityContentSnapshot } from './content-snapshot';
import type { RollbackDeps } from './deps';
import type { ActivityLogForRollback } from './types';

/**
 * Resolve the effective conflict fields for a preview: detect raw conflicts,
 * then (when an undo group is in play) query for a later modification made
 * *outside* the group and classify accordingly. The DB lookup is the only
 * effect here — the branch decision lives in the pure classifyUndoGroupConflict.
 */
async function resolveConflictFields(
  deps: RollbackDeps,
  activity: ActivityLogForRollback,
  currentValues: Record<string, unknown> | null,
  resourceType: ActivityResourceType,
  undoGroupActivityIds: string[]
): Promise<string[]> {
  const conflictFields = getConflictFields(activity.newValues, currentValues);
  if (conflictFields.length === 0) {
    return conflictFields;
  }

  deps.logger.debug('[Rollback:Preview] Conflict detected', {
    activityId: activity.id,
    resourceId: activity.resourceId,
    resourceType,
    timestamp: activity.timestamp?.toISOString(),
    conflictFields,
    undoGroupSize: undoGroupActivityIds.length,
  });

  if (undoGroupActivityIds.length === 0) {
    return classifyUndoGroupConflict({
      conflictFields,
      hasUndoGroupContext: false,
      hasExternalModification: false,
    });
  }

  const externalModifications = await deps.db
    .select({ id: activityLogs.id })
    .from(activityLogs)
    .where(
      and(
        eq(activityLogs.resourceId, activity.resourceId),
        eq(activityLogs.resourceType, resourceType),
        gt(activityLogs.timestamp, activity.timestamp),
        not(inArray(activityLogs.id, undoGroupActivityIds))
      )
    )
    .limit(1);

  const resolved = classifyUndoGroupConflict({
    conflictFields,
    hasUndoGroupContext: true,
    hasExternalModification: externalModifications.length > 0,
  });

  if (resolved.length === 0) {
    deps.logger.debug('[Rollback:Preview] Conflict is internal to undo group, ignoring', {
      activityId: activity.id,
      resourceType,
      conflictFields,
    });
  }

  return resolved;
}

/**
 * Preview from an already-fetched activity and resolved content snapshot.
 */
export async function previewFromActivity(
  deps: RollbackDeps,
  action: ActivityAction,
  activity: ActivityLogForRollback,
  resolvedContentSnapshot: string | null,
  userId: string,
  context: RollbackContext,
  options?: { force?: boolean; undoGroupActivityIds?: string[] }
): Promise<ActivityActionPreview> {
  const force = options?.force ?? false;
  const undoGroupActivityIds = options?.undoGroupActivityIds ?? [];
  const targetValues = buildActionTargetValues(activity, resolvedContentSnapshot);
  const changes = buildChangeSummary(activity, targetValues);
  const affectedResources = [
    {
      type: activity.resourceType,
      id: activity.resourceId,
      title: activity.resourceTitle || 'Untitled',
    },
  ];

  const basePreview = (overrides: Partial<ActivityActionPreview>): ActivityActionPreview =>
    buildPreview({ action, targetValues, changes, affectedResources }, overrides);

  // When rolling back a rollback activity, we need the source operation to know what handler to use
  const rollingBackRollback = isRollingBackRollback(activity);

  const effectiveOperation = getEffectiveOperation(activity);
  const isRollbackable = effectiveOperation ? deps.isRollbackableOperation(effectiveOperation) : false;
  const hasTargetValues = !!targetValues && Object.keys(targetValues).length > 0;
  // Content snapshots are only relevant for regular rollbacks, not rollback of rollbacks
  const hasContentSnapshot = !rollingBackRollback && !!resolvedContentSnapshot;
  // When rolling back a rollback, use the redo allow list since we're restoring forward
  const allowMissingTarget = !!effectiveOperation && (rollingBackRollback
    ? REDO_ALLOW_MISSING_TARGET.has(effectiveOperation)
    : ROLLBACK_ALLOW_MISSING_TARGET.has(effectiveOperation));
  deps.logger.debug('[Rollback:Preview] Checking eligibility', {
    action,
    operation: effectiveOperation,
    isRollbackable,
    rollingBackRollback,
    hasTargetValues,
    hasContentSnapshot,
    allowMissingTarget,
    previousValuesFields: targetValues ? Object.keys(targetValues) : [],
  });

  const eligibility = evaluateEligibility({
    action,
    rollingBackRollback,
    effectiveOperation,
    isRollbackable,
    hasTargetValues,
    hasContentSnapshot,
    allowMissingTarget,
  });
  if (eligibility.kind === 'reject') {
    return basePreview({ reason: eligibility.reason });
  }

  // Check permissions
  deps.logger.debug('[Rollback:Preview] Checking permissions', {
    userId,
    context,
    resourceType: activity.resourceType,
  });

  const permissionCheck = await deps.canUserRollback(userId, activity, context);

  deps.logger.debug('[Rollback:Preview] Permission check result', {
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

  deps.logger.debug('[Rollback:Preview] Fetching current resource state', {
    resourceType: activity.resourceType,
    resourceId: activity.resourceId,
  });

  if (activity.resourceType === 'page' && activity.pageId) {
    const currentPage = await deps.db
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
      const parentDrive = await deps.db
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

    // Check if create operation is a no-op (page already in desired state)
    if (effectiveOperation === 'create') {
      // When rolling back a rollback of create, we should RESTORE (not trash)
      const shouldBeTrashed = action === 'rollback' && !rollingBackRollback;
      const createNoOp = evaluateCreateNoOp({
        isCreateNoOp: currentPage[0].isTrashed === shouldBeTrashed,
        shouldBeTrashed,
        // For AI undo, a no-op is silently skippable so stale activities from
        // previous sessions can be filtered out; outside an undo group it errors.
        hasUndoGroup: undoGroupActivityIds.length > 0,
        allowUndoGroupSkip: true,
        trashedReason: 'Page is already in trash',
        restoredReason: 'Page is already restored',
      });
      if (createNoOp.kind === 'skippable') {
        return basePreview({ canExecute: true, isNoOp: true, currentValues });
      }
      if (createNoOp.kind === 'error') {
        return basePreview({ reason: createNoOp.reason, currentValues, isNoOp: true });
      }
    }

    // For 'create' operations, skip conflict check - we're just trashing the page
    // For update operations, check for conflicts and distinguish internal vs external
    if (effectiveOperation !== 'create') {
      conflictFields = await resolveConflictFields(deps, activity, currentValues, 'page', undoGroupActivityIds);
    }

    if (conflictFields.length > 0) {
      hasConflict = true;
      requiresForce = true;
      deps.logger.debug('[Rollback:Preview] Conflict check', {
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
    const currentDrive = await deps.db
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
      // When rolling back a rollback of create, we should RESTORE (not trash)
      const shouldBeTrashed = action === 'rollback' && !rollingBackRollback;
      const createNoOp = evaluateCreateNoOp({
        isCreateNoOp: currentDrive[0].isTrashed === shouldBeTrashed,
        shouldBeTrashed,
        // Drive create no-ops always error (no silent undo-group skip).
        hasUndoGroup: undoGroupActivityIds.length > 0,
        allowUndoGroupSkip: false,
        trashedReason: 'Drive is already in trash',
        restoredReason: 'Drive is already restored',
      });
      if (createNoOp.kind === 'error') {
        return basePreview({
          reason: createNoOp.reason,
          currentValues,
          isNoOp: true,
        });
      }
    }

    // Check for conflicts and distinguish internal vs external
    conflictFields = await resolveConflictFields(deps, activity, currentValues, 'drive', undoGroupActivityIds);

    if (conflictFields.length > 0) {
      hasConflict = true;
      requiresForce = true;
      deps.logger.debug('[Rollback:Preview] Drive conflict check', {
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
      const currentMember = await deps.db
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
        // Check for conflicts and distinguish internal vs external
        conflictFields = await resolveConflictFields(deps, activity, currentValues, 'member', undoGroupActivityIds);

        if (conflictFields.length > 0) {
          hasConflict = true;
          requiresForce = true;
          deps.logger.debug('[Rollback:Preview] Member conflict check', {
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
      const currentPermission = await deps.db
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
        // Check for conflicts and distinguish internal vs external
        conflictFields = await resolveConflictFields(deps, activity, currentValues, 'permission', undoGroupActivityIds);

        if (conflictFields.length > 0) {
          hasConflict = true;
          requiresForce = true;
          deps.logger.debug('[Rollback:Preview] Permission conflict check', {
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
      const currentRoles = await deps.db
        .select({ id: driveRoles.id, position: driveRoles.position })
        .from(driveRoles)
        .where(eq(driveRoles.driveId, activity.driveId))
        .orderBy(asc(driveRoles.position));

      currentValues = {
        order: currentRoles.map(role => role.id),
      };

      // Skip conflict detection for AI undo - all changes are from the same conversation
      if (undoGroupActivityIds.length === 0) {
        conflictFields = getConflictFields(activity.newValues, currentValues);
      }
      if (conflictFields.length > 0) {
        hasConflict = true;
        requiresForce = true;
        deps.logger.debug('[Rollback:Preview] Role reorder conflict check', {
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
      const currentRole = await deps.db
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
        // Check for conflicts and distinguish internal vs external
        conflictFields = await resolveConflictFields(deps, activity, currentValues, 'role', undoGroupActivityIds);

        if (conflictFields.length > 0) {
          hasConflict = true;
          requiresForce = true;
          deps.logger.debug('[Rollback:Preview] Role conflict check', {
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
    const currentAgent = await deps.db
      .select({
        systemPrompt: pages.systemPrompt,
        enabledTools: pages.enabledTools,
        aiProvider: pages.aiProvider,
        aiModel: pages.aiModel,
        includeDrivePrompt: pages.includeDrivePrompt,
        agentDefinition: pages.agentDefinition,
        visibleToGlobalAssistant: pages.visibleToGlobalAssistant,
        includePageTree: pages.includePageTree,
        pageTreeScope: pages.pageTreeScope,
        toolExposureMode: pages.toolExposureMode,
        userScopedAccess: pages.userScopedAccess,
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
      includePageTree: currentAgent[0].includePageTree,
      pageTreeScope: currentAgent[0].pageTreeScope,
      toolExposureMode: currentAgent[0].toolExposureMode,
      userScopedAccess: currentAgent[0].userScopedAccess,
    };

    // Check for conflicts and distinguish internal vs external
    conflictFields = await resolveConflictFields(deps, activity, currentValues, 'agent', undoGroupActivityIds);

    if (conflictFields.length > 0) {
      hasConflict = true;
      requiresForce = true;
      deps.logger.debug('[Rollback:Preview] Agent conflict check', {
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
    const { table } = pickConversationTable({ conversationType, hasPageId: !!activity.pageId });

    const currentMessage = await deps.db
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

    // Check for conflicts and distinguish internal vs external
    conflictFields = await resolveConflictFields(deps, activity, currentValues, 'message', undoGroupActivityIds);

    if (conflictFields.length > 0) {
      hasConflict = true;
      requiresForce = true;
      deps.logger.debug('[Rollback:Preview] Message conflict check', {
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

  // Skip no-op detection for AI undo - operations may appear as no-ops
  // but the resource will be affected by other operations in the undo group
  const noOp = undoGroupActivityIds.length === 0 && isNoOpChange(targetValues, currentValues);
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

  deps.logger.debug('[Rollback:Preview] Preview complete', {
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
 * Preview what a rollback or redo would do — fetches the activity + snapshot,
 * then delegates to previewFromActivity.
 */
export async function previewActivityAction(
  deps: RollbackDeps,
  action: ActivityAction,
  activityId: string,
  userId: string,
  context: RollbackContext,
  options?: { force?: boolean; undoGroupActivityIds?: string[] }
): Promise<ActivityActionPreview> {
  deps.logger.debug('[Rollback:Preview] Starting preview', { action, activityId, userId, context, force: options?.force ?? false });

  const activity = await getActivityById(deps, activityId);
  if (!activity) {
    deps.logger.debug('[Rollback:Preview] Activity not found', { activityId });
    return buildPreview({ action, targetValues: null, changes: [], affectedResources: [] }, { reason: 'Activity not found' });
  }

  const resolvedContentSnapshot = await resolveActivityContentSnapshot(deps, activity);
  return previewFromActivity(deps, action, activity, resolvedContentSnapshot, userId, context, options);
}
