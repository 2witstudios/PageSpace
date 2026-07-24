/**
 * Revocation→kick hook (#2158).
 *
 * The ONE place a permission revocation turns into Socket.IO room kicks.
 * Previously every web route that revoked access had to remember its own
 * kickUserFrom* calls (drive member removal, page-permission delete, activity
 * rollback, page-goes-private) — any new revocation path that forgot left the
 * user's sockets in rooms until their next reconnect. Centralizing the kick at
 * the permission mutation layer makes forgetting impossible:
 * `revokePagePermission` calls `kickForPagePermissionRevocation` itself, and
 * the routes that revoke access outside that function (member removal,
 * rollback, page-private) call these hooks instead of hand-picking rooms.
 *
 * Room membership is a delivery optimization over the authoritative per-event
 * permission recheck (see ../realtime/rooms.ts, TRUST MODEL) — so both hooks
 * are best-effort: they log failures and NEVER throw. A failed kick must never
 * fail (or roll back) the revocation that triggered it; the per-event recheck
 * in apps/realtime/src/per-event-auth.ts remains the enforcement boundary
 * either way.
 *
 * Functional core / imperative shell: the payload builders are pure and fully
 * branch-covered; the exported hooks are thin shells over injected deps
 * (kick transport + drive-page enumeration).
 */

import { db } from '@pagespace/db/db';
import { eq } from '@pagespace/db/operators';
import { pages } from '@pagespace/db/schema/core';
import { loggers } from '../logging/logger-config';
import { kickUserFromRooms, type KickPayload, type KickReason, type KickResult } from '../realtime/kick-client';
import { roomsForDriveKick, roomsForPageKick } from '../realtime/rooms';

/** Reasons a user can lose page-scoped access. */
export type PageRevocationReason = Extract<KickReason, 'permission_revoked' | 'page_private' | 'member_removed'>;

/**
 * Reasons a full drive-membership revocation can carry. Deliberately just
 * `member_removed`: a role CHANGE (still a member) never cascades to kicking
 * page rooms the way membership loss does, so it isn't modeled here.
 */
export type DriveRevocationReason = 'member_removed';

// ---------------------------------------------------------------------------
// Pure core — payload builders
// ---------------------------------------------------------------------------

/** One kick payload per page-scoped room (page room + page activity room). */
export function pageRevocationKickPayloads({
  userId,
  pageId,
  reason,
}: {
  userId: string;
  pageId: string;
  reason: PageRevocationReason;
}): KickPayload[] {
  return roomsForPageKick(pageId).map((roomPattern) => ({
    userId,
    roomPattern,
    reason,
    metadata: { pageId },
  }));
}

/** One kick payload per drive-scoped room (drive, drive calendar, drive activity) — no page enumeration needed. */
export function driveScopedKickPayloads({
  userId,
  driveId,
  driveName,
  reason,
}: {
  userId: string;
  driveId: string;
  driveName?: string;
  reason: DriveRevocationReason;
}): KickPayload[] {
  const metadata = driveName === undefined ? { driveId } : { driveId, driveName };
  return roomsForDriveKick(driveId).map((roomPattern) => ({ userId, roomPattern, reason, metadata }));
}

/**
 * One kick payload per room a drive membership grants: the drive-scoped rooms
 * (drive, drive calendar, drive activity) plus every page in the drive (page
 * rooms are keyed by bare pageId, so a `drive:` pattern cannot reach them).
 */
export function driveRevocationKickPayloads({
  userId,
  driveId,
  pageIds,
  driveName,
  reason,
}: {
  userId: string;
  driveId: string;
  pageIds: string[];
  driveName?: string;
  reason: DriveRevocationReason;
}): KickPayload[] {
  const pagePayloads = pageIds.flatMap((pageId) =>
    pageRevocationKickPayloads({ userId, pageId, reason }),
  );
  return [...driveScopedKickPayloads({ userId, driveId, driveName, reason }), ...pagePayloads];
}

// ---------------------------------------------------------------------------
// Imperative shell — injected deps, best-effort execution
// ---------------------------------------------------------------------------

export interface RevocationKickDeps {
  kick: (payload: KickPayload) => Promise<KickResult>;
  listDrivePageIds: (driveId: string) => Promise<string[]>;
}

const defaultDeps: RevocationKickDeps = {
  kick: kickUserFromRooms,
  listDrivePageIds: async (driveId) => {
    const rows = await db.select({ id: pages.id }).from(pages).where(eq(pages.driveId, driveId));
    return rows.map((row) => row.id);
  },
};

/** Fire every kick; swallow (and log) any failure — kicks are best-effort. */
async function executeKicks(payloads: KickPayload[], deps: RevocationKickDeps, context: Record<string, string>): Promise<void> {
  const results = await Promise.allSettled(payloads.map((payload) => deps.kick(payload)));
  const failed = results.filter((result) => result.status === 'rejected');
  if (failed.length > 0) {
    loggers.realtime.error('Revocation kick failed (best-effort, revocation itself already applied)',
      failed[0].status === 'rejected' && failed[0].reason instanceof Error ? failed[0].reason : undefined,
      { ...context, failedCount: String(failed.length) },
    );
  }
}

/**
 * Kick a user from a page's rooms after their page access was revoked.
 * Never throws.
 */
export async function kickForPagePermissionRevocation(
  args: { userId: string; pageId: string; reason: PageRevocationReason },
  deps: RevocationKickDeps = defaultDeps,
): Promise<void> {
  await executeKicks(pageRevocationKickPayloads(args), deps, { pageId: args.pageId, reason: args.reason });
}

/**
 * Kick a user from every room a drive membership granted — the drive-scoped
 * rooms plus every page room in the drive — after their membership was
 * revoked. Never throws.
 *
 * The drive-scoped kicks don't need the page list, so they fire immediately
 * rather than waiting on the page-enumeration DB query: for "immediately
 * revoke real-time access," gating drive-room kicks behind an unrelated
 * round-trip would only widen the window. If page enumeration fails, the
 * drive-scoped kicks still run (unaffected by the failure).
 */
export async function kickForDriveMembershipRevocation(
  args: { userId: string; driveId: string; driveName?: string; reason: DriveRevocationReason },
  deps: RevocationKickDeps = defaultDeps,
): Promise<void> {
  const driveKicks = executeKicks(
    driveScopedKickPayloads(args),
    deps,
    { driveId: args.driveId, reason: args.reason },
  );

  const pageKicks = deps.listDrivePageIds(args.driveId)
    .catch((error): string[] => {
      loggers.realtime.error('Revocation kick: drive page enumeration failed; kicking drive rooms only',
        error instanceof Error ? error : undefined,
        { driveId: args.driveId },
      );
      return [];
    })
    .then((pageIds) =>
      executeKicks(
        pageIds.flatMap((pageId) => pageRevocationKickPayloads({ userId: args.userId, pageId, reason: args.reason })),
        deps,
        { driveId: args.driveId, reason: args.reason },
      )
    );

  await Promise.all([driveKicks, pageKicks]);
}
