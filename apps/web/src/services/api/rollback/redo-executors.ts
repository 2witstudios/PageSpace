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
import type { ReentryDecision } from '@pagespace/lib/permissions/guest-holds';
import { assertRestoredLeadEligible } from './lead-eligibility';
import type { ActivityLogForRollback } from './types';

/** POL-2: the result of a rollback or redo write the org's guests policy did not let through (nothing was written). */
function guestPolicySkip(decision: ReentryDecision, ids: Record<string, string>): Record<string, unknown> {
  return { skipped: true, reason: decision.outcome === 'refused' ? 'guest_policy_off' : 'guest_approval_pending', ...ids };
}

const grantFlags = (v: { canView?: unknown; canEdit?: unknown; canShare?: unknown; canDelete?: unknown }) => ({
  canView: v.canView === true,
  canEdit: v.canEdit === true,
  canShare: v.canShare === true,
  canDelete: v.canDelete === true,
});

/** The drive a page lives in (a page permission's drive), or null when the page is gone. */
async function pageDriveId(deps: RollbackDeps, pageId: string): Promise<string | null> {
  const [row] = await deps.db.select({ driveId: pages.driveId }).from(pages).where(eq(pages.id, pageId)).limit(1);
  return row?.driveId ?? null;
}

/** POL-2: may this page grant (re-)enter? Asked only when it gives some access. */
async function admitGrant(deps: RollbackDeps, pageId: string, userId: string, values: { canView?: unknown; canEdit?: unknown; canShare?: unknown; canDelete?: unknown }): Promise<ReentryDecision> {
  const flags = grantFlags(values);
  if (!flags.canView && !flags.canEdit && !flags.canShare && !flags.canDelete) return { outcome: 'admit' };
  const driveId = await pageDriveId(deps, pageId);
  if (!driveId) return { outcome: 'admit' };
  return deps.admitReentry(deps.db, { driveId, userId, grants: [{ pageId, ...flags }], requestedBy: null });
}

/** POL-2: may this member row (re-)enter? A row that already exists is a role change, not an admission. */
async function admitMember(deps: RollbackDeps, driveId: string, userId: string, values: object): Promise<ReentryDecision> {
  const [row] = await deps.db.select({ id: driveMembers.id }).from(driveMembers).where(and(eq(driveMembers.driveId, driveId), eq(driveMembers.userId, userId))).limit(1);
  if (row) return { outcome: 'admit' };
  return deps.admitReentry(deps.db, { driveId, userId, member: JSON.parse(JSON.stringify(values)) as Record<string, unknown>, requestedBy: null });
}


/** Execute a page redo: apply the redo update-data with the isTrashed cascade (orphan/restore children). */
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

/** Execute a drive redo: apply the redo update-data with the drive-page trash/restore cascade. */
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

  await assertRestoredLeadEligible(deps, activity.driveId, updateData);
  await deps.db.update(drives).set({ ...updateData, updatedAt: deps.clock() }).where(eq(drives.id, activity.driveId));

  return updateData;
}

/** Execute a permission redo plan against pagePermissions (upsert/update/delete). */
export async function redoPermissionChange(
  deps: RollbackDeps,
  activity: ActivityLogForRollback,
  targetValues: Record<string, unknown> | null,
  sourceOperation: ActivityOperation
): Promise<Record<string, unknown>> {
  const plan = planPermissionRedo(activity, targetValues, sourceOperation);

  switch (plan.op) {
    case 'upsert': {
      const decision = await admitGrant(deps, plan.values.pageId, plan.values.userId, plan.values);
      if (decision.outcome !== 'admit') return guestPolicySkip(decision, { pageId: plan.values.pageId, userId: plan.values.userId });
      await deps.db
        .insert(pagePermissions)
        .values(plan.values)
        .onConflictDoUpdate({ target: [pagePermissions.pageId, pagePermissions.userId], set: plan.values });
      return { ...plan.values };
    }
    case 'update': {
      const decision = await admitGrant(deps, plan.pageId, plan.userId, plan.set);
      if (decision.outcome !== 'admit') return guestPolicySkip(decision, { pageId: plan.pageId, userId: plan.userId });
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

/** Execute a member redo plan against driveMembers (upsert/delete/update). */
export async function redoMemberChange(
  deps: RollbackDeps,
  activity: ActivityLogForRollback,
  targetValues: Record<string, unknown> | null,
  sourceOperation: ActivityOperation
): Promise<Record<string, unknown>> {
  const plan = planMemberRedo(activity, targetValues, sourceOperation, deps.clock());

  switch (plan.op) {
    case 'upsert': {
      const decision = await admitMember(deps, plan.values.driveId, plan.values.userId, plan.values);
      if (decision.outcome !== 'admit') return guestPolicySkip(decision, { driveId: plan.values.driveId, userId: plan.values.userId });
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

/** Execute a role redo plan against driveRoles (reorder/insert/delete/update). */
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

/** Execute an agent-config redo: apply the whitelisted fields onto the page via a revision-guarded write. */
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

/** Execute a message redo: apply the redo update-data to the conversation table. */
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
