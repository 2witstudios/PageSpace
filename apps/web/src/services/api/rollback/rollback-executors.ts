/**
 * Rollback executor shells.
 *
 * Thin interpreters of the pure rollback op-plans against the injected deps.db.
 * Cascade reads (children, pages, affected members) happen here; the decision
 * logic lives in rollback-plans.ts.
 */
import { eq, and } from '@pagespace/db/operators';
import { pages, drives } from '@pagespace/db/schema/core';
import { driveMembers, driveRoles, pagePermissions } from '@pagespace/db/schema/members';
import { resolveActivityContentSnapshot } from './content-snapshot';
import { applyPageUpdateWithRevision } from './page-mutation';
import { pickConversationTable } from './page-mutation-plan';
import {
  planPageRollback,
  planDriveRollback,
  planPermissionRollback,
  planAgentRollback,
  planMemberRollback,
  planRoleRollback,
  planMessageRollback,
} from './rollback-plans';
import type { RollbackDeps, PageUpdateContext, PageChangeResult } from './deps';
import type { ActivityLogForRollback } from './types';

export async function rollbackPageChange(
  deps: RollbackDeps,
  activity: ActivityLogForRollback,
  pageUpdateContext: PageUpdateContext
): Promise<PageChangeResult> {
  if (!activity.pageId) {
    throw new Error('Page ID not found in activity');
  }

  const resolvedContentSnapshot = await resolveActivityContentSnapshot(deps, activity);
  const plan = planPageRollback(activity, resolvedContentSnapshot);

  if (plan.kind === 'trash-created') {
    const [page] = await deps.db
      .select({ parentId: pages.parentId, isTrashed: pages.isTrashed })
      .from(pages)
      .where(eq(pages.id, activity.pageId));

    if (page?.isTrashed) {
      return { restoredValues: { isTrashed: true }, pageMutationMeta: undefined };
    }

    const childPages = await deps.db
      .select({ id: pages.id })
      .from(pages)
      .where(eq(pages.parentId, activity.pageId));

    const nextParentId = page?.parentId ?? null;
    for (const child of childPages) {
      await applyPageUpdateWithRevision(deps, child.id, { parentId: nextParentId, originalParentId: activity.pageId }, pageUpdateContext);
    }

    const pageMutationMeta = await applyPageUpdateWithRevision(deps, activity.pageId, { isTrashed: true, trashedAt: deps.clock() }, pageUpdateContext);
    return { restoredValues: { isTrashed: true }, pageMutationMeta };
  }

  const { updateData, restoreOrphanedChildren } = plan;
  const pageMutationMeta = await applyPageUpdateWithRevision(deps, activity.pageId, updateData, pageUpdateContext);

  if (restoreOrphanedChildren) {
    const restoredChildren = await deps.db
      .select({ id: pages.id })
      .from(pages)
      .where(eq(pages.originalParentId, activity.pageId));

    for (const child of restoredChildren) {
      await applyPageUpdateWithRevision(deps, child.id, { parentId: activity.pageId, originalParentId: null }, pageUpdateContext);
    }
  }

  return { restoredValues: updateData, pageMutationMeta };
}

export async function rollbackDriveChange(
  deps: RollbackDeps,
  activity: ActivityLogForRollback,
  pageUpdateContext: PageUpdateContext
): Promise<Record<string, unknown>> {
  if (!activity.driveId) {
    throw new Error('Drive ID not found in activity');
  }

  const plan = planDriveRollback(activity);

  if (plan.kind === 'trash-created') {
    const trashedAt = deps.clock();
    const drivePages = await deps.db
      .select({ id: pages.id })
      .from(pages)
      .where(eq(pages.driveId, activity.driveId));

    for (const page of drivePages) {
      await applyPageUpdateWithRevision(deps, page.id, { isTrashed: true, trashedAt }, pageUpdateContext);
    }

    await deps.db
      .update(drives)
      .set({ isTrashed: true, trashedAt: deps.clock(), updatedAt: deps.clock() })
      .where(eq(drives.id, activity.driveId));

    return { trashed: true, driveId: activity.driveId, pagesTrashed: true };
  }

  await deps.db
    .update(drives)
    .set({ ...plan.updateData, updatedAt: deps.clock() })
    .where(eq(drives.id, activity.driveId));

  return plan.updateData;
}

export async function rollbackPermissionChange(
  deps: RollbackDeps,
  activity: ActivityLogForRollback
): Promise<Record<string, unknown>> {
  const plan = planPermissionRollback(activity);

  switch (plan.op) {
    case 'delete': {
      await deps.db
        .delete(pagePermissions)
        .where(and(eq(pagePermissions.pageId, plan.pageId), eq(pagePermissions.userId, plan.userId)));
      deps.logger.info('[RollbackService] Deleted permission that was granted', { pageId: plan.pageId, userId: plan.userId });
      return { deleted: true, pageId: plan.pageId, userId: plan.userId };
    }
    case 'insert': {
      await deps.db.insert(pagePermissions).values(plan.values);
      deps.logger.info('[RollbackService] Re-created revoked permission', { pageId: plan.values.pageId, userId: plan.values.userId });
      return { ...plan.values };
    }
    case 'update': {
      await deps.db
        .update(pagePermissions)
        .set(plan.set)
        .where(and(eq(pagePermissions.pageId, plan.pageId), eq(pagePermissions.userId, plan.userId)));
      deps.logger.info('[RollbackService] Restored previous permission values', { pageId: plan.pageId, userId: plan.userId, restoredFields: Object.keys(plan.set) });
      return plan.set;
    }
  }
}

export async function rollbackAgentConfigChange(
  deps: RollbackDeps,
  activity: ActivityLogForRollback,
  pageUpdateContext: PageUpdateContext,
  agentFields: readonly string[]
): Promise<PageChangeResult> {
  const { updateData } = planAgentRollback(activity, agentFields);
  const pageMutationMeta = await applyPageUpdateWithRevision(deps, activity.pageId as string, updateData, pageUpdateContext);
  return { restoredValues: updateData, pageMutationMeta };
}

export async function rollbackMemberChange(
  deps: RollbackDeps,
  activity: ActivityLogForRollback
): Promise<Record<string, unknown>> {
  const plan = planMemberRollback(activity, deps.clock());

  switch (plan.op) {
    case 'delete': {
      await deps.db
        .delete(driveMembers)
        .where(and(eq(driveMembers.driveId, plan.driveId), eq(driveMembers.userId, plan.userId)));
      deps.logger.info('[RollbackService] Removed member that was added', { driveId: plan.driveId, userId: plan.userId });
      return { deleted: true, driveId: plan.driveId, userId: plan.userId };
    }
    case 'insert': {
      await deps.db.insert(driveMembers).values(plan.values);
      deps.logger.info('[RollbackService] Re-added removed member', { driveId: plan.values.driveId, userId: plan.values.userId, role: plan.values.role });
      return { ...plan.values };
    }
    case 'update': {
      await deps.db
        .update(driveMembers)
        .set(plan.set)
        .where(and(eq(driveMembers.driveId, plan.driveId), eq(driveMembers.userId, plan.userId)));
      deps.logger.info('[RollbackService] Restored previous member values', { driveId: plan.driveId, userId: plan.userId, restoredFields: Object.keys(plan.set) });
      return plan.set;
    }
  }
}

export async function rollbackRoleChange(
  deps: RollbackDeps,
  activity: ActivityLogForRollback
): Promise<Record<string, unknown>> {
  const now = deps.clock();
  const plan = planRoleRollback(activity, now);

  switch (plan.op) {
    case 'reorder': {
      for (const [index, roleId] of plan.order.entries()) {
        await deps.db.update(driveRoles).set({ position: index, updatedAt: now }).where(eq(driveRoles.id, roleId));
      }
      deps.logger.info('[RollbackService] Restored previous role order', { driveId: activity.driveId, roleCount: plan.order.length });
      return { order: plan.order };
    }
    case 'delete-role': {
      const affectedMembers = await deps.db
        .select({ userId: driveMembers.userId })
        .from(driveMembers)
        .where(eq(driveMembers.customRoleId, plan.roleId));
      await deps.db.delete(driveRoles).where(eq(driveRoles.id, plan.roleId));
      deps.logger.info('[RollbackService] Deleted role that was created', { driveId: activity.driveId, roleId: plan.roleId, affectedMemberCount: affectedMembers.length });
      return { deleted: true, roleId: plan.roleId, affectedMemberUserIds: affectedMembers.map(m => m.userId) };
    }
    case 'insert-role': {
      await deps.db.insert(driveRoles).values(plan.values);
      deps.logger.info('[RollbackService] Re-created deleted role', { driveId: activity.driveId, roleId: plan.values.id, name: plan.values.name });
      return { ...plan.values };
    }
    case 'update-role': {
      await deps.db.update(driveRoles).set(plan.set).where(eq(driveRoles.id, plan.roleId));
      deps.logger.info('[RollbackService] Restored previous role values', { driveId: activity.driveId, roleId: plan.roleId, restoredFields: Object.keys(plan.set) });
      return plan.set;
    }
  }
}

export async function rollbackMessageChange(
  deps: RollbackDeps,
  activity: ActivityLogForRollback
): Promise<Record<string, unknown>> {
  const messageId = activity.resourceId;
  const metadata = activity.metadata as Record<string, unknown> | null;
  const conversationType = metadata?.conversationType as string | undefined;

  const { table, isChannel, label: tableLabel } = pickConversationTable({
    conversationType,
    hasPageId: !!activity.pageId,
  });

  const plan = planMessageRollback(activity, isChannel);

  await deps.db.update(table).set(plan.set).where(eq(table.id, messageId));

  deps.logger.info(`[RollbackService] Applied message rollback (${tableLabel})`, {
    messageId,
    operation: activity.operation,
    pageId: activity.pageId,
  });

  return plan.returnValue;
}
