/**
 * The tenant/membership FACTS a session's Sprite-key fold and its access
 * decision both need — gathered ONCE so a change to either rule cannot land
 * on one tier (web routes, the realtime shell bridge) and miss the other.
 *
 * `resolveSessionTenantId` folds the Sprite key's tenant: the agent session's
 * drive OWNER for a drive-scoped session, the session's own owner for a
 * global-assistant one. A drive that no longer exists is NOT the global case
 * — it fails closed (`drive_not_found`) rather than silently falling back to
 * the session owner, which would mint a Sprite under a DIFFERENT tenant than
 * the one this session's key already folded under, splitting one session
 * across two Sprite identities.
 *
 * `resolveDriveMembership` is the requester's relationship to a drive (owner,
 * accepted admin, accepted member, or neither) — the ONE membership read
 * `checkAgentSessionAccess`'s gather calls for a drive-scoped session.
 * `canRunCodeForSession` reduces the centralized `canRunCode` capability check
 * to the boolean the access decider consumes.
 */

import { db } from '@pagespace/db/db';
import { and, eq, isNotNull } from '@pagespace/db/operators';
import { drives } from '@pagespace/db/schema/core';
import { driveMembers } from '@pagespace/db/schema/members';
import { canRunCode } from '../sandbox/can-run-code';
import type { DriveMembership } from '../../agent-workspaces/decide-workspace-access';

export type ResolveSessionTenantIdResult =
  | { ok: true; tenantId: string }
  | { ok: false; reason: 'drive_not_found' };

/**
 * The tenant a session's Sprite key folds under. Fails CLOSED on a vanished
 * drive row rather than falling back to the session owner — see module doc.
 */
export async function resolveSessionTenantId(session: {
  driveId: string | null;
  ownerId: string;
}): Promise<ResolveSessionTenantIdResult> {
  if (session.driveId === null) return { ok: true, tenantId: session.ownerId };
  const drive = await db.query.drives.findFirst({
    where: eq(drives.id, session.driveId),
    columns: { ownerId: true },
  });
  if (!drive) return { ok: false, reason: 'drive_not_found' };
  return { ok: true, tenantId: drive.ownerId };
}

/**
 * The requester's relationship to a drive: its owner, an accepted member, or
 * neither. The ONE membership read both access checks (main + end) share.
 */
export async function resolveDriveMembership({
  userId,
  driveId,
}: {
  userId: string;
  driveId: string;
}): Promise<DriveMembership> {
  const drive = await db.query.drives.findFirst({
    where: eq(drives.id, driveId),
    columns: { ownerId: true },
  });
  if (!drive) return 'none';
  if (drive.ownerId === userId) return 'owner';
  const membership = await db.query.driveMembers.findFirst({
    where: and(eq(driveMembers.driveId, driveId), eq(driveMembers.userId, userId), isNotNull(driveMembers.acceptedAt)),
    columns: { role: true },
  });
  if (!membership) return 'none';
  // ADMIN is surfaced distinctly because the END decision requires drive
  // delete authority (owner/admin) — plain members may not tear down another
  // member's session (codex round 12).
  return membership.role === 'ADMIN' ? 'admin' : 'member';
}

/** The centralized `canRunCode` capability check, reduced to the boolean the access decider consumes. */
export async function canRunCodeForSession({
  userId,
  driveId,
  ownerId,
}: {
  userId: string;
  driveId: string | null;
  ownerId: string;
}): Promise<boolean> {
  const result = await canRunCode({ userId, driveId: driveId ?? undefined, ownerId, requestOrigin: 'user' });
  return result.ok;
}
