/**
 * Imago agents' drive grants (Imago plan, DEC-2).
 *
 * A user's Imago agents live in their Home drive and reach other drives only
 * through `drive_agent_members` rows, the same membership every agent uses.
 * The default reach is the STANDARD drives the user owns, granted at two
 * moments: when an agent is provisioned (all owned STANDARD drives) and when
 * the user creates a STANDARD drive (that drive). Every grant goes through
 * `addAgentToDrive`, so its checks apply unchanged: the user must control the
 * agent and the drive, Home is refused, and the role is capped at MEMBER —
 * which `agent-permissions.ts` resolves to view-only on non-private pages.
 *
 * Nothing re-grants later: re-provisioning grants only agents it created, so a
 * grant the user removed (the per-drive Imago access toggle) stays removed, and
 * a drive acquired by ownership transfer is left to the new owner's decision.
 * Drives the user merely belongs to are never granted here.
 *
 * Grants run after the creating transaction commits (the agent pages and the
 * drive must be visible to `addAgentToDrive`'s own connection), so they are
 * best effort: a failure is logged and never undoes the sign-in or the drive.
 */

import { db } from '@pagespace/db/db';
import { and, eq, inArray, ne } from '@pagespace/db/operators';
import { drives, pages } from '@pagespace/db/schema/core';
import { driveAgentMembers } from '@pagespace/db/schema/members';
import { userBuiltinAgents } from '@pagespace/db/schema/user-builtin-agents';
import { loggers } from '../logging/logger-config';
import { addAgentToDrive } from '../services/drive-agent-service';

/** A Drizzle transaction handle, accepted alongside the module-level `db`. */
type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

export interface ImagoGrantScope {
  /** Only these agent pages (still the user's live Imago agents). Omitted ⇒ all of them. */
  agentPageIds?: readonly string[];
  /** Only these drives (still owned, STANDARD and live). Omitted ⇒ every one. */
  driveIds?: readonly string[];
}

export interface ImagoGrantOutcome {
  agentPageId: string;
  driveId: string;
  /** `already`: the membership existed; `refused`: addAgentToDrive said no; `failed`: it threw. */
  status: 'granted' | 'already' | 'refused' | 'failed';
}

/**
 * Grant the user's Imago agents MEMBER in the STANDARD drives the user owns,
 * narrowed by `scope`. Idempotent; never throws (see the module comment).
 */
export async function grantImagoAgentsToOwnedDrives(
  userId: string,
  scope: ImagoGrantScope = {},
): Promise<ImagoGrantOutcome[]> {
  if (scope.agentPageIds?.length === 0 || scope.driveIds?.length === 0) return [];

  let agentIds: string[];
  let driveIds: string[];
  let existing: Set<string>;
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
    agentIds = agentRows.map((row) => row.pageId);
    if (agentIds.length === 0) return [];

    const driveRows = await db
      .select({ id: drives.id })
      .from(drives)
      .where(and(
        eq(drives.ownerId, userId),
        eq(drives.kind, 'STANDARD'),
        eq(drives.isTrashed, false),
        scope.driveIds ? inArray(drives.id, [...scope.driveIds]) : undefined,
      ));
    driveIds = driveRows.map((row) => row.id);
    if (driveIds.length === 0) return [];

    const memberRows = await db
      .select({ agentPageId: driveAgentMembers.agentPageId, driveId: driveAgentMembers.driveId })
      .from(driveAgentMembers)
      .where(and(inArray(driveAgentMembers.agentPageId, agentIds), inArray(driveAgentMembers.driveId, driveIds)));
    existing = new Set(memberRows.map((row) => `${row.agentPageId}:${row.driveId}`));
  } catch (error) {
    loggers.ai.error('Imago agent grants: lookup failed', error as Error, { userId });
    return [];
  }

  const outcomes: ImagoGrantOutcome[] = [];
  for (const driveId of driveIds) {
    for (const agentPageId of agentIds) {
      if (existing.has(`${agentPageId}:${driveId}`)) {
        outcomes.push({ agentPageId, driveId, status: 'already' });
        continue;
      }
      outcomes.push({ agentPageId, driveId, status: await grantOne(userId, agentPageId, driveId) });
    }
  }
  return outcomes;
}

async function grantOne(userId: string, agentPageId: string, driveId: string): Promise<ImagoGrantOutcome['status']> {
  try {
    const result = await addAgentToDrive({ actingUserId: userId, agentPageId, driveId, requestedRole: 'MEMBER' });
    if (result.ok) return 'granted';
    // A concurrent grant (or the toggle) got there first.
    if (result.status === 409) return 'already';
    loggers.ai.warn('Imago agent grant refused', { userId, agentPageId, driveId, status: result.status, error: result.error });
    return 'refused';
  } catch (error) {
    loggers.ai.error('Imago agent grant failed', error as Error, { userId, agentPageId, driveId });
    return 'failed';
  }
}

/**
 * Remove the user's Imago agents' memberships in `driveId` (never their Home
 * membership). Used when the user hands the drive to a new owner: the grant
 * came from their ownership, and the new owner decides whose agents get in.
 * Accepts a transaction so it commits with the ownership change. Returns the
 * agentPageIds whose membership was removed.
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
