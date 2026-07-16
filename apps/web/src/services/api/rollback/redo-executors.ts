/**
 * Redo executor shells (undo a rollback).
 *
 * Thin interpreters of the pure redo op-plans against the injected deps.db.
 */
import { eq, and } from '@pagespace/db/operators';
import { pages, drives } from '@pagespace/db/schema/core';
import { driveMembers, driveRoles, pagePermissions } from '@pagespace/db/schema/members';
import { applyPageUpdateWithRevision } from './page-mutation';
import { pickConversationTable } from './page-mutation-plan';
import {
  planPageRedo,
  planDriveRedo,
  planPermissionRedo,
  planAgentRedo,
  planMemberRedo,
  planRoleRedo,
  planMessageRedo,
} from './redo-plans';
import type { ActivityOperation } from '@pagespace/lib/monitoring/activity-logger';
import type { RollbackDeps, PageUpdateContext, PageChangeResult } from './deps';
import type { ActivityLogForRollback } from './types';

export async function redoPageChange(
  deps: RollbackDeps,
  activity: ActivityLogForRollback,
  targetValues: Record<string, unknown> | null,
  sourceOperation: ActivityOperation,
  pageUpdateContext: PageUpdateContext
): Promise<PageChangeResult> {
  if (!activity.pageId) {
    throw new Error('Page ID not found in activity');
  }

  const updateData = planPageRedo(targetValues, sourceOperation);

  if (updateData.isTrashed === true) {
    const [page] = await deps.db
      .select({ parentId: pages.parentId })
      .from(pages)
      .where(eq(pages.id, activity.pageId));

    const childPages = await deps.db
      .select({ id: pages.id })
      .from(pages)
      .where(eq(pages.parentId, activity.pageId));

    const nextParentId = page?.parentId ?? null;
    for (const child of childPages) {
      await applyPageUpdateWithRevision(deps, child.id, { parentId: nextParentId, originalParentId: activity.pageId }, pageUpdateContext);
    }

    updateData.trashedAt = deps.clock();
  }

  if (updateData.isTrashed === false) {
    updateData.trashedAt = null;
  }

  const pageMutationMeta = await applyPageUpdateWithRevision(deps, activity.pageId, updateData, pageUpdateContext);

  if (updateData.isTrashed === false) {
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

export async function redoDriveChange(
  deps: RollbackDeps,
  activity: ActivityLogForRollback,
  targetValues: Record<string, unknown> | null,
  sourceOperation: ActivityOperation,
  pageUpdateContext: PageUpdateContext
): Promise<Record<string, unknown>> {
  if (!activity.driveId) {
    throw new Error('Drive ID not found in activity');
  }

  const updateData = planDriveRedo(targetValues, sourceOperation);

  if (updateData.isTrashed === true) {
    const trashedAt = deps.clock();
    const drivePages = await deps.db.select({ id: pages.id }).from(pages).where(eq(pages.driveId, activity.driveId));
    for (const page of drivePages) {
      await applyPageUpdateWithRevision(deps, page.id, { isTrashed: true, trashedAt }, pageUpdateContext);
    }
    updateData.trashedAt = trashedAt;
  }

  if (updateData.isTrashed === false) {
    const drivePages = await deps.db.select({ id: pages.id }).from(pages).where(eq(pages.driveId, activity.driveId));
    for (const page of drivePages) {
      await applyPageUpdateWithRevision(deps, page.id, { isTrashed: false, trashedAt: null }, pageUpdateContext);
    }
    updateData.trashedAt = null;
  }

  await deps.db.update(drives).set({ ...updateData, updatedAt: deps.clock() }).where(eq(drives.id, activity.driveId));

  return updateData;
}

export async function redoPermissionChange(
  deps: RollbackDeps,
  activity: ActivityLogForRollback,
  targetValues: Record<string, unknown> | null,
  sourceOperation: ActivityOperation
): Promise<Record<string, unknown>> {
  const plan = planPermissionRedo(activity, targetValues, sourceOperation);

  switch (plan.op) {
    case 'upsert': {
      await deps.db
        .insert(pagePermissions)
        .values(plan.values)
        .onConflictDoUpdate({ target: [pagePermissions.pageId, pagePermissions.userId], set: plan.values });
      return { ...plan.values };
    }
    case 'update': {
      await deps.db
        .update(pagePermissions)
        .set(plan.set)
        .where(and(eq(pagePermissions.pageId, plan.pageId), eq(pagePermissions.userId, plan.userId)));
      return plan.set;
    }
    case 'delete': {
      await deps.db
        .delete(pagePermissions)
        .where(and(eq(pagePermissions.pageId, plan.pageId), eq(pagePermissions.userId, plan.userId)));
      return { deleted: true, pageId: plan.pageId, userId: plan.userId };
    }
  }
}

export async function redoMemberChange(
  deps: RollbackDeps,
  activity: ActivityLogForRollback,
  targetValues: Record<string, unknown> | null,
  sourceOperation: ActivityOperation
): Promise<Record<string, unknown>> {
  const plan = planMemberRedo(activity, targetValues, sourceOperation, deps.clock());

  switch (plan.op) {
    case 'upsert': {
      await deps.db
        .insert(driveMembers)
        .values(plan.values)
        .onConflictDoUpdate({ target: [driveMembers.driveId, driveMembers.userId], set: plan.values });
      return { ...plan.values };
    }
    case 'delete': {
      await deps.db
        .delete(driveMembers)
        .where(and(eq(driveMembers.driveId, plan.driveId), eq(driveMembers.userId, plan.userId)));
      return { deleted: true, driveId: plan.driveId, userId: plan.userId };
    }
    case 'update': {
      await deps.db
        .update(driveMembers)
        .set(plan.set)
        .where(and(eq(driveMembers.driveId, plan.driveId), eq(driveMembers.userId, plan.userId)));
      return plan.set;
    }
  }
}

export async function redoRoleChange(
  deps: RollbackDeps,
  activity: ActivityLogForRollback,
  targetValues: Record<string, unknown> | null,
  sourceOperation: ActivityOperation
): Promise<Record<string, unknown>> {
  const now = deps.clock();
  const plan = planRoleRedo(activity, targetValues, sourceOperation, now);

  switch (plan.op) {
    case 'reorder': {
      for (const [index, targetRoleId] of plan.order.entries()) {
        await deps.db.update(driveRoles).set({ position: index, updatedAt: now }).where(eq(driveRoles.id, targetRoleId));
      }
      return { order: plan.order };
    }
    case 'insert-role': {
      await deps.db.insert(driveRoles).values(plan.values);
      return { ...plan.values };
    }
    case 'delete-role': {
      const affectedMembers = await deps.db
        .select({ userId: driveMembers.userId })
        .from(driveMembers)
        .where(eq(driveMembers.customRoleId, plan.roleId));
      await deps.db.delete(driveRoles).where(eq(driveRoles.id, plan.roleId));
      return { deleted: true, roleId: plan.roleId, affectedMemberUserIds: affectedMembers.map(member => member.userId) };
    }
    case 'update-role': {
      await deps.db.update(driveRoles).set(plan.set).where(eq(driveRoles.id, plan.roleId));
      return plan.set;
    }
  }
}

export async function redoAgentConfigChange(
  deps: RollbackDeps,
  activity: ActivityLogForRollback,
  targetValues: Record<string, unknown> | null,
  pageUpdateContext: PageUpdateContext,
  agentFields: readonly string[]
): Promise<PageChangeResult> {
  const { updateData } = planAgentRedo(activity, targetValues, agentFields);
  const pageMutationMeta = await applyPageUpdateWithRevision(deps, activity.pageId as string, updateData, pageUpdateContext);
  return { restoredValues: updateData, pageMutationMeta };
}

export async function redoMessageChange(
  deps: RollbackDeps,
  activity: ActivityLogForRollback,
  targetValues: Record<string, unknown> | null,
  sourceOperation: ActivityOperation
): Promise<Record<string, unknown>> {
  const metadata = activity.metadata as Record<string, unknown> | null;
  const conversationType = metadata?.conversationType as string | undefined;
  const { table, isChannel } = pickConversationTable({ conversationType, hasPageId: !!activity.pageId });

  const updateData = planMessageRedo(targetValues, sourceOperation, isChannel, deps.clock());

  await deps.db.update(table).set(updateData).where(eq(table.id, activity.resourceId));

  return updateData;
}
