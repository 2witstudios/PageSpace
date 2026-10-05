/**
 * What a built-in Imago agent is told about its own reach (IMG-4.7).
 *
 * An Imago agent lives in the user's Home drive and reaches other drives only
 * through explicit `drive_agent_members` grants (Imago plan, DEC-2) — unlike
 * the Global Assistant, whose reach was every drive the user could see. So its
 * turn carries two things an ordinary page agent's does not:
 *
 *  - a stable summary of the drives it is granted, by name and role only, in
 *    the system prompt (it changes only when a grant does);
 *  - beside the per-turn LOCATION block, whether the drive the user is looking
 *    at is one it can work in — so "put this here" in an ungranted drive is
 *    answered honestly instead of attempted and refused.
 *
 * TRUST BOUNDARY. The summary lists only grants, never every drive the user
 * can see, and only grants on drives the user can still reach and the caller's
 * token scope allows: a drive name is never surfaced to someone who could not
 * already list it. The location itself is resolved and permission-checked
 * upstream (`resolveRequestContext`); this module only annotates it.
 *
 * "Imago agent" means the page is one of THIS user's `user_builtin_agents`
 * pointers. Any other agent — including another user's Imago agent — gets
 * nothing from here, and its prompt is byte-identical to before.
 */

import { db } from '@pagespace/db/db';
import { and, asc, eq } from '@pagespace/db/operators';
import { drives, pages } from '@pagespace/db/schema/core';
import { driveAgentMembers, type GrantableMemberRole } from '@pagespace/db/schema/members';
import { userBuiltinAgents } from '@pagespace/db/schema/user-builtin-agents';
import { getDriveIdsForUser } from '@pagespace/lib/permissions/permissions';
import type { LocationContext } from '@/lib/ai/shared/chat-types';
import type { LocationAgentAccess } from './location-prompt';

export interface ImagoDriveGrant {
  driveId: string;
  name: string;
  role: GrantableMemberRole;
}

export interface ImagoAgentContext {
  /** The drive the agent page lives in — the user's Home drive. */
  homeDriveId: string;
  /** Granted drives, sorted by name. */
  grants: ImagoDriveGrant[];
}

/**
 * The Imago context for `agentPageId` when it is one of `userId`'s built-in
 * agents, else `null`. `allowedDriveIds` is the caller's token scope (empty =
 * unscoped session), applied as a ceiling exactly like the member-drive
 * context beside it in the page turn.
 */
export async function loadImagoAgentContext(input: {
  userId: string;
  agentPageId: string;
  allowedDriveIds: readonly string[];
}): Promise<ImagoAgentContext | null> {
  const { userId, agentPageId, allowedDriveIds } = input;

  const [pointer] = await db
    .select({ homeDriveId: pages.driveId })
    .from(userBuiltinAgents)
    .innerJoin(pages, eq(pages.id, userBuiltinAgents.pageId))
    .where(and(
      eq(userBuiltinAgents.userId, userId),
      eq(userBuiltinAgents.pageId, agentPageId),
      eq(pages.isTrashed, false),
    ))
    .limit(1);
  if (!pointer) return null;

  const [rows, reachable] = await Promise.all([
    db
      .select({ driveId: driveAgentMembers.driveId, name: drives.name, role: driveAgentMembers.role })
      .from(driveAgentMembers)
      .innerJoin(drives, eq(drives.id, driveAgentMembers.driveId))
      .where(and(eq(driveAgentMembers.agentPageId, agentPageId), eq(drives.isTrashed, false)))
      .orderBy(asc(drives.name), asc(drives.id)),
    getDriveIdsForUser(userId),
  ]);

  const reachableIds = new Set(reachable);
  const grants = rows.filter((row) =>
    row.driveId !== pointer.homeDriveId &&
    reachableIds.has(row.driveId) &&
    (allowedDriveIds.length === 0 || allowedDriveIds.includes(row.driveId)),
  );

  return { homeDriveId: pointer.homeDriveId, grants };
}

/** The stable system-prompt block. Names and roles only — no ids. */
export function buildGrantedDrivesPrompt(context: ImagoAgentContext): string {
  const header = '\n\n## GRANTED WORKSPACES\n\n';
  if (context.grants.length === 0) {
    return `${header}No workspaces are granted to you yet: you can work only in the user's Home drive. If the user asks about another workspace, tell them they can grant you access from that workspace.`;
  }
  const lines = context.grants.map((grant) => `• "${grant.name}" — ${grant.role}`);
  return `${header}The user has granted you these workspaces, with these roles. Besides the user's Home drive, they are the only workspaces you can work in; any other workspace is out of your reach even when the user can see it:\n${lines.join('\n')}`;
}

/** Whether the agent can work in the drive the user is looking at, or undefined with no drive in view. */
export function resolveImagoLocationAccess(
  location: LocationContext | null,
  context: ImagoAgentContext,
): LocationAgentAccess | undefined {
  const driveId = location?.currentDrive?.id;
  if (!driveId) return undefined;
  if (driveId === context.homeDriveId) return { kind: 'home' };
  const grant = context.grants.find((g) => g.driveId === driveId);
  return grant ? { kind: 'granted', role: grant.role } : { kind: 'not-granted' };
}

/**
 * The drive whose drive-level integrations the agent may use this turn: the
 * drive in view when it is the Home drive or a granted one, else null — an
 * ungranted drive's integrations never reach the agent (IMG-4.8).
 */
export function resolveImagoIntegrationDriveId(
  location: LocationContext | null,
  context: ImagoAgentContext,
): string | null {
  const access = resolveImagoLocationAccess(location, context);
  return access?.kind === 'home' || access?.kind === 'granted' ? location?.currentDrive?.id ?? null : null;
}
