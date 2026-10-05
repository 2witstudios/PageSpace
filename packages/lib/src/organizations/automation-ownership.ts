/**
 * [D-OW-36] An org's automations outlive their creator.
 *
 * Workflows (with their schedule, task triggers, calendar triggers and webhook wiring) and page
 * webhooks run on behalf of the person who created them ([D-OW-34]). When that person leaves the org
 * (or is removed) or deletes their account, the automations they made in the org's drives are NOT
 * deleted: they are disabled and flagged `ownerLeftAt`, for an org Owner or Admin to reassign to an
 * accepted member or to delete. The creator columns are ON DELETE SET NULL, so once the account is
 * gone an owner-left automation names nobody: it keeps no personal data of the person who left.
 *
 * Nothing runs under a missing person: every executor asks permissions/automation-ownership
 * `automationRunOwner` before any hold, and records `owner_left` as the reason it skipped.
 *
 * A personal drive's automations keep the behaviour they had: account deletion removes them (what
 * the creator column's cascade used to do), and leaving an org never reaches them.
 *
 * The disable step runs inside the caller's transaction (leaveOrganization, account deletion); the
 * `org.automation.owner_left` events are written after it commits (recordOwnerLeftAutomations).
 */
import { db } from '@pagespace/db/db';
import { and, asc, eq, inArray, isNotNull, isNull, or, sql } from '@pagespace/db/operators';
import { drives, pages } from '@pagespace/db/schema/core';
import { workflows } from '@pagespace/db/schema/workflows';
import { pageWebhooks } from '@pagespace/db/schema/page-webhooks';
import { calendarTriggers } from '@pagespace/db/schema/calendar-triggers';
import { calendarEvents } from '@pagespace/db/schema/calendar';
import { taskItems } from '@pagespace/db/schema/tasks';
import { taskTriggers } from '@pagespace/db/schema/task-triggers';
import { orgMembers, type OrgRole } from '@pagespace/db/schema/organizations';
import { recordOrgAuditEvent, recordOrgAuditEventAfterCommit } from '../audit/org-audit';
import { loadDriveSpendStanding } from '../permissions/spend-standing';
import {
  decideOwnerLeftAutomationAction,
  type CreatorDepartureReason,
  type OwnerLeftAutomationDecision,
} from '../permissions/automation-ownership';

/** A Drizzle transaction handle. */
type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

export type AutomationKind = 'workflow' | 'page_webhook';

/** One automation disabled and flagged because its creator left. Ids only. */
export interface OwnerLeftAutomation {
  orgId: string;
  kind: AutomationKind;
  id: string;
  driveId: string;
  /** The person who left (a still-existing user on a departure; deleted with the account). */
  formerOwnerId: string;
  reason: CreatorDepartureReason;
}

const utcNow = () => sql`(now() at time zone 'utc')`;

/**
 * Disable and flag every automation `userId` created in an org drive: in `orgId`'s drives when given
 * (leaving or being removed from one org), else in every org's drives (account deletion, which also
 * reaches orgs the person was never a member of, as a guest creator). Already-flagged rows are left as
 * they are. A workflow is also flagged when the person scheduled one of its calendar triggers.
 */
export async function disableDepartedCreatorAutomations(
  tx: Tx,
  input: { userId: string; orgId?: string; reason: CreatorDepartureReason },
): Promise<OwnerLeftAutomation[]> {
  const orgDrives = await tx
    .select({ id: drives.id, orgId: drives.orgId })
    .from(drives)
    .where(input.orgId ? eq(drives.orgId, input.orgId) : isNotNull(drives.orgId));
  if (orgDrives.length === 0) return [];
  const orgOf = new Map(orgDrives.map((d) => [d.id, d.orgId as string]));
  const driveIds = [...orgOf.keys()];

  const flaggedWorkflows = await tx
    .update(workflows)
    .set({ isEnabled: false, ownerLeftAt: utcNow() })
    .where(and(
      inArray(workflows.driveId, driveIds),
      isNull(workflows.ownerLeftAt),
      or(
        eq(workflows.createdBy, input.userId),
        inArray(workflows.id, tx.select({ id: calendarTriggers.workflowId }).from(calendarTriggers).where(eq(calendarTriggers.scheduledById, input.userId))),
      ),
    ))
    .returning({ id: workflows.id, driveId: workflows.driveId });

  const flaggedWebhooks = await tx
    .update(pageWebhooks)
    .set({ isEnabled: false, ownerLeftAt: utcNow() })
    .where(and(
      eq(pageWebhooks.createdBy, input.userId),
      isNull(pageWebhooks.ownerLeftAt),
      inArray(pageWebhooks.pageId, tx.select({ id: pages.id }).from(pages).where(inArray(pages.driveId, driveIds))),
    ))
    .returning({ id: pageWebhooks.id, pageId: pageWebhooks.pageId });
  const webhookDrives = flaggedWebhooks.length === 0
    ? new Map<string, string>()
    : new Map((await tx.select({ id: pages.id, driveId: pages.driveId }).from(pages).where(inArray(pages.id, flaggedWebhooks.map((w) => w.pageId)))).map((p) => [p.id, p.driveId]));

  const item = (kind: AutomationKind, id: string, driveId: string): OwnerLeftAutomation => ({
    orgId: orgOf.get(driveId) as string, kind, id, driveId, formerOwnerId: input.userId, reason: input.reason,
  });
  return [
    ...flaggedWorkflows.map((w) => item('workflow', w.id, w.driveId)),
    ...flaggedWebhooks.map((w) => item('page_webhook', w.id, webhookDrives.get(w.pageId) as string)),
  ];
}

/**
 * Account deletion's half of [D-OW-36], in the deletion's transaction BEFORE the users row goes (after
 * the person has left every org and their led drives were reassigned):
 *
 * 1. Every automation they created in any org drive is disabled and flagged; the users delete then
 *    clears its creator (SET NULL), so it keeps nothing of theirs.
 * 2. The rows an org-drive trigger hangs from must survive the account too: a calendar trigger's
 *    calendar event and a task trigger's task item each cascade from their own creator. Where the
 *    person created one that carries a trigger, it is re-attributed to the drive's lead, as [D-OW-28]
 *    hands a departing creator's compute to the lead. Their other events and tasks are untouched.
 * 3. A personal drive's automations are deleted, as the creator cascade did before.
 */
export async function prepareAutomationsForAccountDeletion(tx: Tx, userId: string): Promise<OwnerLeftAutomation[]> {
  const flagged = await disableDepartedCreatorAutomations(tx, { userId, reason: 'account_deleted' });

  const triggerEvents = await tx
    .select({ id: calendarEvents.id, leadId: drives.ownerId })
    .from(calendarEvents)
    .innerJoin(drives, eq(drives.id, calendarEvents.driveId))
    .where(and(
      eq(calendarEvents.createdById, userId),
      isNotNull(drives.orgId),
      inArray(calendarEvents.id, tx.select({ id: calendarTriggers.calendarEventId }).from(calendarTriggers)),
    ));
  for (const [leadId, ids] of groupByLead(triggerEvents)) {
    await tx.update(calendarEvents).set({ createdById: leadId }).where(inArray(calendarEvents.id, ids));
  }

  const triggerTasks = await tx
    .select({ id: taskItems.id, leadId: drives.ownerId })
    .from(taskItems)
    .innerJoin(pages, eq(pages.id, taskItems.pageId))
    .innerJoin(drives, eq(drives.id, pages.driveId))
    .where(and(
      eq(taskItems.userId, userId),
      isNotNull(drives.orgId),
      inArray(taskItems.id, tx.select({ id: taskTriggers.taskItemId }).from(taskTriggers)),
    ));
  for (const [leadId, ids] of groupByLead(triggerTasks)) {
    await tx.update(taskItems).set({ userId: leadId }).where(inArray(taskItems.id, ids));
  }

  const personalDriveIds = tx.select({ id: drives.id }).from(drives).where(isNull(drives.orgId));
  await tx.delete(calendarTriggers).where(and(eq(calendarTriggers.scheduledById, userId), inArray(calendarTriggers.driveId, personalDriveIds)));
  await tx.delete(workflows).where(and(eq(workflows.createdBy, userId), inArray(workflows.driveId, personalDriveIds)));
  await tx.delete(pageWebhooks).where(and(
    eq(pageWebhooks.createdBy, userId),
    inArray(pageWebhooks.pageId, tx.select({ id: pages.id }).from(pages).where(inArray(pages.driveId, personalDriveIds))),
  ));

  return flagged;
}

function groupByLead(rows: { id: string; leadId: string }[]): Map<string, string[]> {
  const groups = new Map<string, string[]>();
  for (const row of rows) groups.set(row.leadId, [...(groups.get(row.leadId) ?? []), row.id]);
  return groups;
}

/**
 * Record each flagged automation as `org.automation.owner_left`, AFTER the departure's transaction
 * commits (a rolled-back leave leaves no event). Ids only, never names or content.
 */
export async function recordOwnerLeftAutomations(items: readonly OwnerLeftAutomation[], actorId?: string): Promise<void> {
  for (const item of items) {
    await recordOrgAuditEventAfterCommit({
      orgId: item.orgId,
      eventType: 'org.automation.owner_left',
      ...(actorId ? { actorId } : {}),
      resourceType: item.kind,
      resourceId: item.id,
      driveId: item.driveId,
      details: { formerOwnerId: item.formerOwnerId, reason: item.reason },
    });
  }
}

// ── Admin: list, reassign, delete ──────────────────────────────────────────────

export interface OwnerLeftAutomationRow {
  kind: AutomationKind;
  id: string;
  driveId: string;
  name: string;
  ownerLeftAt: Date;
}

/** The org's owner-left automations, for an Owner or Admin (the caller authorizes with requireOrgRole). */
export async function listOwnerLeftAutomations(orgId: string, limit = 200): Promise<OwnerLeftAutomationRow[]> {
  const orgDriveIds = db.select({ id: drives.id }).from(drives).where(eq(drives.orgId, orgId));
  const wf = await db
    .select({ id: workflows.id, driveId: workflows.driveId, name: workflows.name, ownerLeftAt: workflows.ownerLeftAt })
    .from(workflows)
    .where(and(inArray(workflows.driveId, orgDriveIds), isNotNull(workflows.ownerLeftAt)))
    .limit(limit);
  const wh = await db
    .select({ id: pageWebhooks.id, driveId: pages.driveId, name: pageWebhooks.name, ownerLeftAt: pageWebhooks.ownerLeftAt })
    .from(pageWebhooks)
    .innerJoin(pages, eq(pages.id, pageWebhooks.pageId))
    .where(and(inArray(pages.driveId, orgDriveIds), isNotNull(pageWebhooks.ownerLeftAt)))
    .limit(limit);
  return [
    ...wf.map((r) => ({ kind: 'workflow' as const, id: r.id, driveId: r.driveId, name: r.name, ownerLeftAt: r.ownerLeftAt as Date })),
    ...wh.map((r) => ({ kind: 'page_webhook' as const, id: r.id, driveId: r.driveId, name: r.name, ownerLeftAt: r.ownerLeftAt as Date })),
  ];
}

interface LockedAutomation {
  orgId: string | null;
  driveId: string;
  ownerLeftAt: Date | null;
  cronExpression: string | null;
  timezone: string | null;
}

/**
 * The accepted org roles of `userIds`, their org_members rows held FOR SHARE in `tx` (review #2831 P2-2).
 * leaveOrganization and removeMember lock the same rows FOR UPDATE as their first step and delete them, so a
 * departure either commits first (the row is gone here: not a member) or waits for this transaction to
 * commit (its disable step then sees what this one wrote). Taken BEFORE the automation row, the order a
 * departure takes them in (its member row, then the automations it flags), so the two never deadlock.
 * Ordered by user id, as removeMember orders its pair.
 */
async function lockOrgRoles(tx: Tx, orgId: string, userIds: string[]): Promise<Map<string, OrgRole>> {
  const rows = await tx
    .select({ userId: orgMembers.userId, role: orgMembers.role })
    .from(orgMembers)
    .where(and(eq(orgMembers.orgId, orgId), inArray(orgMembers.userId, [...new Set(userIds)])))
    .orderBy(asc(orgMembers.userId))
    .for('share');
  return new Map(rows.map((r) => [r.userId, r.role]));
}

/** The automation and its drive's org, locked FOR UPDATE so a concurrent reassign or delete serializes. */
async function lockAutomation(tx: Tx, kind: AutomationKind, id: string): Promise<LockedAutomation | null> {
  if (kind === 'workflow') {
    const [row] = await tx
      .select({ driveId: workflows.driveId, ownerLeftAt: workflows.ownerLeftAt, cronExpression: workflows.cronExpression, timezone: workflows.timezone })
      .from(workflows)
      .where(eq(workflows.id, id))
      .for('update');
    if (!row) return null;
    const [drive] = await tx.select({ orgId: drives.orgId }).from(drives).where(eq(drives.id, row.driveId));
    return { ...row, orgId: drive?.orgId ?? null };
  }
  const [row] = await tx
    .select({ pageId: pageWebhooks.pageId, ownerLeftAt: pageWebhooks.ownerLeftAt })
    .from(pageWebhooks)
    .where(eq(pageWebhooks.id, id))
    .for('update');
  if (!row) return null;
  const [page] = await tx.select({ driveId: pages.driveId }).from(pages).where(eq(pages.id, row.pageId));
  if (!page) return null;
  const [drive] = await tx.select({ orgId: drives.orgId }).from(drives).where(eq(drives.id, page.driveId));
  return { driveId: page.driveId, ownerLeftAt: row.ownerLeftAt, orgId: drive?.orgId ?? null, cronExpression: null, timezone: null };
}

export type OwnerLeftAutomationResult = OwnerLeftAutomationDecision;

export interface ReassignOwnerLeftAutomationInput {
  orgId: string;
  actorId: string;
  kind: AutomationKind;
  id: string;
  newOwnerId: string;
  /** The next cron fire for a scheduled workflow (the web cron-utils); null leaves it unscheduled. */
  nextRunAt?: (cronExpression: string, timezone: string) => Date | null;
}

/**
 * Hand an owner-left automation to `newOwnerId` and switch it back on. From then on it runs as the new
 * owner and their per-consumer caps bind it ([D-OW-34]); a calendar trigger of the workflow is
 * scheduled by them too. Owner/Admin only, for an accepted member who can reach the drive
 * (permissions/automation-ownership). Audited `org.automation.reassigned` inside the transaction, so
 * a reassignment the chain refuses does not happen.
 */
export async function reassignOwnerLeftAutomation(input: ReassignOwnerLeftAutomationInput): Promise<OwnerLeftAutomationResult> {
  return db.transaction(async (tx) => {
    const roles = await lockOrgRoles(tx, input.orgId, [input.actorId, input.newOwnerId]);
    const actorRole = roles.get(input.actorId) ?? null;
    const automation = actorRole === null ? null : await lockAutomation(tx, input.kind, input.id);
    // Read through tx, under the membership locks just taken: a departure cannot commit in between.
    const standing = automation ? await loadDriveSpendStanding(input.newOwnerId, automation.driveId, tx) : null;
    const decision = decideOwnerLeftAutomationAction({
      actorRole,
      orgId: input.orgId,
      automation,
      action: { kind: 'reassign', newOwner: standing ? { isOrgMember: standing.isOrgMember, isDriveMember: standing.isDriveMember } : null },
    });
    if (!decision.ok || !automation) return decision;

    if (input.kind === 'workflow') {
      const nextRunAt = automation.cronExpression && input.nextRunAt
        ? input.nextRunAt(automation.cronExpression, automation.timezone ?? 'UTC')
        : null;
      await tx
        .update(workflows)
        .set({ createdBy: input.newOwnerId, ownerLeftAt: null, isEnabled: true, ...(automation.cronExpression ? { nextRunAt } : {}) })
        .where(eq(workflows.id, input.id));
      await tx.update(calendarTriggers).set({ scheduledById: input.newOwnerId }).where(eq(calendarTriggers.workflowId, input.id));
    } else {
      await tx
        .update(pageWebhooks)
        .set({ createdBy: input.newOwnerId, ownerLeftAt: null, isEnabled: true })
        .where(eq(pageWebhooks.id, input.id));
    }
    await recordOrgAuditEvent({
      orgId: input.orgId,
      eventType: 'org.automation.reassigned',
      actorId: input.actorId,
      resourceType: input.kind,
      resourceId: input.id,
      driveId: automation.driveId,
      details: { newOwnerId: input.newOwnerId },
    });
    return decision;
  });
}

/**
 * Delete an owner-left automation (a workflow takes its triggers with it). Owner/Admin only. Audited
 * `org.automation.deleted` inside the transaction.
 */
export async function deleteOwnerLeftAutomation(input: { orgId: string; actorId: string; kind: AutomationKind; id: string }): Promise<OwnerLeftAutomationResult> {
  return db.transaction(async (tx) => {
    const actorRole = (await lockOrgRoles(tx, input.orgId, [input.actorId])).get(input.actorId) ?? null;
    const automation = actorRole === null ? null : await lockAutomation(tx, input.kind, input.id);
    const decision = decideOwnerLeftAutomationAction({ actorRole, orgId: input.orgId, automation, action: { kind: 'delete' } });
    if (!decision.ok || !automation) return decision;

    if (input.kind === 'workflow') await tx.delete(workflows).where(eq(workflows.id, input.id));
    else await tx.delete(pageWebhooks).where(eq(pageWebhooks.id, input.id));
    await recordOrgAuditEvent({
      orgId: input.orgId,
      eventType: 'org.automation.deleted',
      actorId: input.actorId,
      resourceType: input.kind,
      resourceId: input.id,
      driveId: automation.driveId,
    });
    return decision;
  });
}

/**
 * The person a workflow runs as right now, read fresh (for the executor, inside its run claim): the
 * creator and the owner-left flag. Null when the workflow no longer exists.
 */
export async function readWorkflowOwnership(workflowId: string): Promise<{ createdBy: string | null; ownerLeftAt: Date | null } | null> {
  const [row] = await db
    .select({ createdBy: workflows.createdBy, ownerLeftAt: workflows.ownerLeftAt })
    .from(workflows)
    .where(eq(workflows.id, workflowId));
  return row ?? null;
}
