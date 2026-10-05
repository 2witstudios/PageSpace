/**
 * The per-drive Imago access toggle (Imago plan, DEC-2; IMG-4.6).
 *
 * "Imago access" for a drive is whether the viewer's own Imago agents are
 * members of it — the `drive_agent_members` rows every agent's reach comes
 * from. Reading it reads those rows; turning it on grants each live Imago
 * agent MEMBER through `addAgentToDrive` (the one membership seam, with its
 * checks and role cap); turning it off removes the viewer's Imago agents from
 * the drive (`revokeImagoAgentGrants`).
 *
 * Only a drive owner or an accepted admin may read or set it: the grant
 * rights on a drive are theirs. Home is refused — the agents live there and
 * their access to it is native. Off is authoritative without stored state:
 * re-provisioning grants a recreated agent only where Imago is still on
 * (`grantNewImagoAgents`), so a drive switched off stays off.
 */

import { db } from '@pagespace/db/db';
import { and, eq, inArray } from '@pagespace/db/operators';
import { drives, pages } from '@pagespace/db/schema/core';
import { driveAgentMembers } from '@pagespace/db/schema/members';
import { userBuiltinAgents } from '@pagespace/db/schema/user-builtin-agents';
import { isDriveOwnerOrAdmin } from '../permissions/permissions';
import { addAgentToDrive, type ServiceFailure } from '../services/drive-agent-service';
import { homeDriveActionError } from '../services/drive-guards';
import { BUILTIN_AGENT_KEYS, type BuiltinAgentKey } from './builtin-agents';
import { revokeImagoAgentGrants } from './grant-imago-agents';

export interface ImagoDriveAccessAgent {
  key: BuiltinAgentKey;
  agentPageId: string;
  isMember: boolean;
}

export interface ImagoDriveAccess {
  driveId: string;
  /** True when any of the viewer's live Imago agents is a member of the drive. */
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
    await revokeImagoAgentGrants(db, userId, driveId);
    return { ok: true, access: await readAccess(userId, driveId) };
  }

  const before = await readAccess(userId, driveId);
  if (before.agents.length === 0) {
    return { ok: false, status: 409, error: 'Your Imago agents are not set up yet' };
  }
  for (const agent of before.agents) {
    if (agent.isMember) continue;
    const granted = await addAgentToDrive({
      actingUserId: userId,
      agentPageId: agent.agentPageId,
      driveId,
      requestedRole: 'MEMBER',
    });
    // 409: a concurrent toggle or grant got there first.
    if (!granted.ok && granted.status !== 409) return granted;
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
  return { driveId, enabled: agents.some((agent) => agent.isMember), agents };
}
