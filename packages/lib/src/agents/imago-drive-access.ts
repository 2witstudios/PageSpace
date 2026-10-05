/**
 * The per-drive Imago access toggle (Imago plan, DEC-2; IMG-4.6, IMG-4.6a).
 *
 * "Imago access" for a drive is the viewer's stored choice
 * (`imago_drive_access`; with none stored, on in a drive they own and off
 * elsewhere) together with the `drive_agent_members` rows of their Imago
 * agents, which are what the agents' reach comes from. The toggle keeps the two
 * in step: turning it on stores the choice and grants each live Imago agent
 * MEMBER (checked by `authorizeAgentDriveGrant`, the membership seam's checks
 * and role cap); turning it off stores the opt-out and removes every Imago
 * agent page of the viewer from the drive (`revokeImagoAgentGrants`). Each runs
 * in one transaction under the user-row lock that provisioning and the grant
 * paths take, so neither a refusal nor a concurrent sign-in leaves it half
 * done, and a stored opt-out is read by every grant path.
 *
 * Only a drive owner or an accepted admin may read or set it: the grant
 * rights on a drive are theirs. Home is refused — the agents live there and
 * their access to it is native.
 */

import { db } from '@pagespace/db/db';
import { and, eq, inArray } from '@pagespace/db/operators';
import { drives, pages } from '@pagespace/db/schema/core';
import { driveAgentMembers } from '@pagespace/db/schema/members';
import { userBuiltinAgents } from '@pagespace/db/schema/user-builtin-agents';
import { isDriveOwnerOrAdmin } from '../permissions/permissions';
import {
  authorizeAgentDriveGrant,
  insertAgentDriveMembership,
  type AuthorizedAgentDriveGrant,
  type ServiceFailure,
} from '../services/drive-agent-service';
import { homeDriveActionError } from '../services/drive-guards';
import { BUILTIN_AGENT_KEYS, type BuiltinAgentKey } from './builtin-agents';
import {
  imagoOnDriveIds,
  liveImagoAgentPageIds,
  lockImagoUser,
  revokeImagoAgentGrants,
  storeImagoDriveChoice,
} from './grant-imago-agents';

/**
 * Turn-on passes before giving up on agents a concurrent sign-in keeps
 * replacing; any left over are granted by that sign-in, which reads the stored
 * choice.
 */
const MAX_TURN_ON_PASSES = 3;

export interface ImagoDriveAccessAgent {
  key: BuiltinAgentKey;
  agentPageId: string;
  isMember: boolean;
}

export interface ImagoDriveAccess {
  driveId: string;
  /**
   * The viewer's choice for the drive — stored, or the default (on in a drive
   * they own) — and false while they have no live Imago agent.
   */
  enabled: boolean;
  /** The viewer's live Imago agents, in registry order. */
  agents: ImagoDriveAccessAgent[];
}

export type ImagoDriveAccessResult = { ok: true; access: ImagoDriveAccess } | ServiceFailure;

const FORBIDDEN: ServiceFailure = {
  ok: false,
  status: 403,
  error: 'Only drive owners and admins can manage Imago access',
};

/** Read the viewer's Imago access to a drive. */
export async function getImagoDriveAccess(userId: string, driveId: string): Promise<ImagoDriveAccessResult> {
  if (!(await isDriveOwnerOrAdmin(userId, driveId))) return FORBIDDEN;
  return { ok: true, access: await readAccess(userId, driveId) };
}

/** Turn the viewer's Imago access to a drive on or off; returns the new state. */
export async function setImagoDriveAccess(
  userId: string,
  driveId: string,
  enabled: boolean,
): Promise<ImagoDriveAccessResult> {
  if (!(await isDriveOwnerOrAdmin(userId, driveId))) return FORBIDDEN;

  const [drive] = await db.select({ kind: drives.kind }).from(drives).where(eq(drives.id, driveId)).limit(1);
  if (!drive) return FORBIDDEN;
  const homeError = homeDriveActionError(drive, 'imago-access');
  if (homeError) return { ok: false, status: 403, error: homeError };

  if (!enabled) {
    await db.transaction(async (tx) => {
      await lockImagoUser(tx, userId);
      await storeImagoDriveChoice(tx, userId, driveId, false);
      await revokeImagoAgentGrants(tx, userId, driveId);
    });
    return { ok: true, access: await readAccess(userId, driveId) };
  }

  // A sign-in can trash-and-replace an agent page between the reads and the
  // locked write; the replaced page is skipped under the lock and its
  // replacement granted on the next pass.
  for (let pass = 0; pass < MAX_TURN_ON_PASSES; pass++) {
    const before = await readAccess(userId, driveId);
    if (before.agents.length === 0) {
      return { ok: false, status: 409, error: 'Your Imago agents are not set up yet' };
    }
    // Every check before anything is written: one refusal changes nothing.
    const grants: AuthorizedAgentDriveGrant[] = [];
    for (const agent of before.agents) {
      if (agent.isMember) continue;
      const authorized = await authorizeAgentDriveGrant({
        actingUserId: userId,
        agentPageId: agent.agentPageId,
        driveId,
        requestedRole: 'MEMBER',
      });
      if (!authorized.ok) return authorized;
      grants.push(authorized.grant);
    }
    await db.transaction(async (tx) => {
      await lockImagoUser(tx, userId);
      await storeImagoDriveChoice(tx, userId, driveId, true);
      const live = await liveImagoAgentPageIds(tx, userId, grants.map((grant) => grant.agentPageId));
      // 409: a concurrent toggle or grant got there first.
      for (const grant of grants) if (live.has(grant.agentPageId)) await insertAgentDriveMembership(tx, grant);
    });
    const after = await readAccess(userId, driveId);
    if (after.agents.every((agent) => agent.isMember)) return { ok: true, access: after };
  }
  return { ok: true, access: await readAccess(userId, driveId) };
}

async function readAccess(userId: string, driveId: string): Promise<ImagoDriveAccess> {
  const liveAgents = await db
    .select({ key: userBuiltinAgents.key, pageId: userBuiltinAgents.pageId })
    .from(userBuiltinAgents)
    .innerJoin(pages, eq(pages.id, userBuiltinAgents.pageId))
    .where(and(eq(userBuiltinAgents.userId, userId), eq(pages.isTrashed, false)));
  const pageIdByKey = new Map(liveAgents.map((row) => [row.key, row.pageId]));

  const pageIds = liveAgents.map((row) => row.pageId);
  const memberRows = pageIds.length === 0
    ? []
    : await db
      .select({ agentPageId: driveAgentMembers.agentPageId })
      .from(driveAgentMembers)
      .where(and(eq(driveAgentMembers.driveId, driveId), inArray(driveAgentMembers.agentPageId, pageIds)));
  const members = new Set(memberRows.map((row) => row.agentPageId));

  const agents = BUILTIN_AGENT_KEYS.flatMap((key) => {
    const agentPageId = pageIdByKey.get(key);
    return agentPageId ? [{ key, agentPageId, isMember: members.has(agentPageId) }] : [];
  });
  const on = (await imagoOnDriveIds(db, userId, [driveId])).length > 0;
  return { driveId, enabled: on && agents.length > 0, agents };
}
