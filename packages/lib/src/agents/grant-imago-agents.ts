/**
 * Imago agents' drive grants (Imago plan, DEC-2; IMG-4.5, IMG-4.6a).
 *
 * A user's Imago agents live in their Home drive and reach other drives only
 * through `drive_agent_members` rows, the same membership every agent uses.
 * Every grant goes through `addAgentToDrive`'s checks
 * (`authorizeAgentDriveGrant`): the user must control the agent and the drive,
 * Home is refused, and the role is capped at MEMBER — which
 * `agent-permissions.ts` resolves to view-only on non-private pages.
 *
 * Where Imago is on is the user's stored choice, `imago_drive_access`, not the
 * memberships: the agent pages can be trashed, emptied from the trash and
 * recreated, and the choice must outlive them. With no row Imago is on in the
 * STANDARD drives the user owns (the DEC-2 default) and off everywhere else; a
 * row overrides that — an opt-out, or the toggle turned on in a drive the user
 * administers. Every grant path reads it: provisioning (sign-in, the backfill)
 * grants the agents it created wherever Imago is on, and drive creation grants
 * the new drive. Nothing else re-grants, so a grant removed by other means stays
 * removed until the toggle is used again; ownership transfer records the choice
 * for both users (`transferDriveOwnership`).
 *
 * Race safety: a grant re-reads the choice and inserts under the user-row lock
 * (`lockImagoUser`, the row provisioning locks), and the toggle writes the
 * choice and the memberships under the same lock — so a turn-off racing a
 * recreation at sign-in always ends off.
 *
 * Grants run after the creating transaction commits (the agent pages and the
 * drive must be visible to the checks' own connection), so they are best
 * effort: a failure is logged and never undoes the sign-in or the drive.
 */

import { db } from '@pagespace/db/db';
import { and, eq, inArray, isNotNull, ne, or, sql } from '@pagespace/db/operators';
import { users } from '@pagespace/db/schema/auth';
import { drives, pages } from '@pagespace/db/schema/core';
import { imagoDriveAccess } from '@pagespace/db/schema/imago-drive-access';
import { driveAgentMembers } from '@pagespace/db/schema/members';
import { userBuiltinAgents } from '@pagespace/db/schema/user-builtin-agents';
import { loggers } from '../logging/logger-config';
import { isDriveOwnerOrAdmin } from '../permissions/permissions';
import {
  authorizeAgentDriveGrant,
  insertAgentDriveMembership,
  type AuthorizedAgentDriveGrant,
} from '../services/drive-agent-service';

/** A Drizzle transaction handle, accepted alongside the module-level `db`. */
type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

export interface ImagoGrantScope {
  /** Only these agent pages (still the user's live Imago agents). Omitted ⇒ all of them. */
  agentPageIds?: readonly string[];
  /** Only these drives (where Imago is still on for the user). Omitted ⇒ every one. */
  driveIds?: readonly string[];
}

export interface ImagoGrantOutcome {
  agentPageId: string;
  driveId: string;
  /**
   * `already`: the membership existed; `refused`: the checks said no; `off`:
   * the drive was switched off before the grant landed; `failed`: it threw.
   */
  status: 'granted' | 'already' | 'refused' | 'off' | 'failed';
}

/**
 * Take the user-row lock that serialises Imago provisioning, grants and the
 * toggle for one user. Inside an open transaction only; held until it ends.
 */
export async function lockImagoUser(tx: Tx, userId: string): Promise<void> {
  await tx.execute(sql`SELECT 1 FROM ${users} WHERE ${users.id} = ${userId} FOR UPDATE`);
}

/**
 * The live STANDARD drives, among `driveIds` when given, where the user's
 * stored choice — or, with none stored, ownership — says Imago is on. A state
 * read, not a permission check: callers still require owner or admin rights.
 */
export async function imagoOnDriveIds(
  executor: Tx | typeof db,
  userId: string,
  driveIds?: readonly string[],
): Promise<string[]> {
  if (driveIds?.length === 0) return [];
  const rows = await executor
    .select({ id: drives.id, ownerId: drives.ownerId, enabled: imagoDriveAccess.enabled })
    .from(drives)
    .leftJoin(imagoDriveAccess, and(eq(imagoDriveAccess.driveId, drives.id), eq(imagoDriveAccess.userId, userId)))
    .where(and(
      // Only drives the user owns or made a choice for: the rest are off.
      or(eq(drives.ownerId, userId), isNotNull(imagoDriveAccess.userId)),
      eq(drives.kind, 'STANDARD'),
      eq(drives.isTrashed, false),
      driveIds ? inArray(drives.id, [...driveIds]) : undefined,
    ));
  return rows
    .filter((row) => row.enabled ?? row.ownerId === userId)
    .map((row) => row.id);
}

/**
 * Grant the user's live Imago agents MEMBER wherever Imago is on for them,
 * narrowed by `scope`: the drives `imagoOnDriveIds` returns that the user
 * still owns or administers. Idempotent; never throws (see the module comment).
 */
export async function grantImagoAgents(
  userId: string,
  scope: ImagoGrantScope = {},
): Promise<ImagoGrantOutcome[]> {
  if (scope.agentPageIds?.length === 0 || scope.driveIds?.length === 0) return [];

  const outcomes: ImagoGrantOutcome[] = [];
  const authorized: AuthorizedAgentDriveGrant[] = [];
  try {
    const agentRows = await db
      .select({ pageId: userBuiltinAgents.pageId })
      .from(userBuiltinAgents)
      .innerJoin(pages, eq(pages.id, userBuiltinAgents.pageId))
      .where(and(
        eq(userBuiltinAgents.userId, userId),
        eq(pages.isTrashed, false),
        scope.agentPageIds ? inArray(userBuiltinAgents.pageId, [...scope.agentPageIds]) : undefined,
      ));
    const agentIds = agentRows.map((row) => row.pageId);
    if (agentIds.length === 0) return [];

    const driveIds: string[] = [];
    for (const driveId of await imagoOnDriveIds(db, userId, scope.driveIds)) {
      if (await isDriveOwnerOrAdmin(userId, driveId)) driveIds.push(driveId);
    }
    if (driveIds.length === 0) return [];

    const memberRows = await db
      .select({ agentPageId: driveAgentMembers.agentPageId, driveId: driveAgentMembers.driveId })
      .from(driveAgentMembers)
      .where(and(inArray(driveAgentMembers.agentPageId, agentIds), inArray(driveAgentMembers.driveId, driveIds)));
    const existing = new Set(memberRows.map((row) => `${row.agentPageId}:${row.driveId}`));

    for (const driveId of driveIds) {
      for (const agentPageId of agentIds) {
        if (existing.has(`${agentPageId}:${driveId}`)) {
          outcomes.push({ agentPageId, driveId, status: 'already' });
          continue;
        }
        const result = await authorizeImagoGrant(userId, agentPageId, driveId);
        if (result === 'refused' || result === 'failed') outcomes.push({ agentPageId, driveId, status: result });
        else authorized.push(result);
      }
    }
  } catch (error) {
    loggers.ai.error('Imago agent grants: lookup failed', error as Error, { userId });
    return outcomes;
  }
  if (authorized.length === 0) return outcomes;

  try {
    const landed = await db.transaction(async (tx: Tx) => {
      await lockImagoUser(tx, userId);
      // Re-read under the lock: a turn-off that committed since the read above wins.
      const stillOn = new Set(await imagoOnDriveIds(tx, userId, [...new Set(authorized.map((grant) => grant.driveId))]));
      const statuses: ImagoGrantOutcome[] = [];
      for (const grant of authorized) {
        const status = !stillOn.has(grant.driveId)
          ? 'off'
          // 409: a concurrent grant or the toggle got there first.
          : (await insertAgentDriveMembership(tx, grant)).ok ? 'granted' : 'already';
        statuses.push({ agentPageId: grant.agentPageId, driveId: grant.driveId, status });
      }
      return statuses;
    });
    outcomes.push(...landed);
  } catch (error) {
    loggers.ai.error('Imago agent grants: insert failed', error as Error, { userId });
    outcomes.push(...authorized.map((grant) => ({ agentPageId: grant.agentPageId, driveId: grant.driveId, status: 'failed' as const })));
  }
  return outcomes;
}

/** `authorizeAgentDriveGrant` at MEMBER, folded to the outcome when it says no. */
async function authorizeImagoGrant(
  userId: string,
  agentPageId: string,
  driveId: string,
): Promise<AuthorizedAgentDriveGrant | 'refused' | 'failed'> {
  try {
    const result = await authorizeAgentDriveGrant({ actingUserId: userId, agentPageId, driveId, requestedRole: 'MEMBER' });
    if (result.ok) return result.grant;
    loggers.ai.warn('Imago agent grant refused', { userId, agentPageId, driveId, status: result.status, error: result.error });
    return 'refused';
  } catch (error) {
    loggers.ai.error('Imago agent grant failed', error as Error, { userId, agentPageId, driveId });
    return 'failed';
  }
}

/**
 * Remove the user's Imago agents' memberships in `driveId` (never their Home
 * membership): every page a `user_builtin_agents` pointer names, live or
 * trashed. A page provisioning has replaced keeps no membership outside its
 * own drive (`revokeCrossDriveMemberships`), so restoring it from the trash
 * brings nothing back. Used by the toggle and by ownership transfer; accepts a
 * transaction so it commits with them. Returns the agentPageIds whose
 * membership was removed.
 */
export async function revokeImagoAgentGrants(
  executor: Tx | typeof db,
  userId: string,
  driveId: string,
): Promise<string[]> {
  const rows = await executor
    .select({ id: driveAgentMembers.id, agentPageId: driveAgentMembers.agentPageId })
    .from(driveAgentMembers)
    .innerJoin(userBuiltinAgents, eq(userBuiltinAgents.pageId, driveAgentMembers.agentPageId))
    .innerJoin(pages, eq(pages.id, driveAgentMembers.agentPageId))
    .where(and(
      eq(userBuiltinAgents.userId, userId),
      eq(driveAgentMembers.driveId, driveId),
      ne(pages.driveId, driveId),
    ));

  if (rows.length === 0) return [];

  await executor
    .delete(driveAgentMembers)
    .where(inArray(driveAgentMembers.id, rows.map((row) => row.id)));

  return rows.map((row) => row.agentPageId);
}

/**
 * Remove every membership of `pageIds` outside the drive each page lives in.
 * Provisioning calls it for the trashed agent pages it replaces: once the
 * pointer moves on, the toggle can no longer find them, so they must not keep
 * a way into any drive.
 */
export async function revokeCrossDriveMemberships(
  executor: Tx | typeof db,
  pageIds: readonly string[],
): Promise<void> {
  if (pageIds.length === 0) return;
  const rows = await executor
    .select({ id: driveAgentMembers.id })
    .from(driveAgentMembers)
    .innerJoin(pages, eq(pages.id, driveAgentMembers.agentPageId))
    .where(and(inArray(driveAgentMembers.agentPageId, [...pageIds]), ne(pages.driveId, driveAgentMembers.driveId)));
  if (rows.length === 0) return;
  await executor.delete(driveAgentMembers).where(inArray(driveAgentMembers.id, rows.map((row) => row.id)));
}

/**
 * Store the user's Imago choice for a drive. Inside the caller's transaction,
 * which should hold `lockImagoUser`.
 */
export async function storeImagoDriveChoice(
  executor: Tx | typeof db,
  userId: string,
  driveId: string,
  enabled: boolean,
): Promise<void> {
  const now = new Date();
  await executor
    .insert(imagoDriveAccess)
    .values({ userId, driveId, enabled, createdAt: now, updatedAt: now })
    .onConflictDoUpdate({
      target: [imagoDriveAccess.userId, imagoDriveAccess.driveId],
      set: { enabled, updatedAt: now },
    });
}
