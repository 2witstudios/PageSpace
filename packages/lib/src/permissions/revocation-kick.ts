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
 * (kick transport + enumeration).
 *
 * **THE EPIC'S ROOMS ARE ENUMERATED** (security review HIGH 3). Drive- and
 * page-scoped rooms are DERIVABLE from the revoked id; the Agent-Session SSoT
 * epic's two new rooms are not. `conv:<conversationId>` carries full message
 * content and `session:<workspaceId>` carries node trees, both keyed by ids a
 * revocation does not know — so both hooks now enumerate what the revoked
 * grant covered and kick those rooms too. Before this, a member who lost page
 * access (or the whole drive) was evicted from the page/drive rooms and kept
 * receiving `conversation:message_created` payloads and
 * `workspace:nodes-updated` trees until their socket happened to reconnect,
 * because outbound fan-out
 * has no re-check by design. Note the asymmetry that gave it away:
 * conversation UN-SHARE got a bespoke wildcard kick; permission revocation —
 * the wider case — did not.
 *
 * Enumeration rather than periodic re-auth, deliberately: `/stream-join`'s 5s
 * re-auth suits a subscription the server already polls, but re-authorizing
 * every `conv:`/`session:` room member on a timer would put a permission query
 * per member per interval on the realtime server forever — to shorten a window
 * a kick closes at once. Two bounded queries at the revocation is the cheaper
 * and more immediate answer. Both enumerations EXCLUDE rows the user still
 * owns: an owner's access to their own conversation or workspace does not come
 * from the grant being revoked, so kicking them would be a bug, not caution.
 */

import { db } from '@pagespace/db/db';
import { and, eq, inArray, ne } from '@pagespace/db/operators';
import { pages } from '@pagespace/db/schema/core';
import { conversations } from '@pagespace/db/schema/conversations';
import { agentWorkspaces } from '@pagespace/db/schema/agent-workspaces';
import { loggers } from '../logging/logger-config';
import { kickUserFromRooms, type KickPayload, type KickReason, type KickResult } from '../realtime/kick-client';
import {
  roomsForConversationKick,
  roomsForDriveKick,
  roomsForPageKick,
  roomsForWorkspaceKick,
} from '../realtime/rooms';

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

/**
 * One kick payload per conversation CONTENT room a revocation reached. These
 * ids come from enumeration (see the module doc): `conv:<id>` is keyed by
 * conversation, so neither a page id nor a drive id can produce it.
 */
export function conversationRevocationKickPayloads({
  userId,
  conversationIds,
  pageId,
  reason,
}: {
  userId: string;
  conversationIds: string[];
  /** The page whose revocation reached these conversations, when there is one. */
  pageId?: string;
  reason: KickReason;
}): KickPayload[] {
  const metadata = pageId === undefined ? undefined : { pageId };
  return conversationIds.flatMap((conversationId) =>
    roomsForConversationKick(conversationId).map((roomPattern) => ({
      userId,
      roomPattern,
      reason,
      ...(metadata ? { metadata } : {}),
    })),
  );
}

/** One kick payload per agent-workspace LAYOUT room in the revoked drive. */
export function workspaceRevocationKickPayloads({
  userId,
  workspaceIds,
  driveId,
  reason,
}: {
  userId: string;
  workspaceIds: string[];
  driveId: string;
  reason: DriveRevocationReason;
}): KickPayload[] {
  return workspaceIds.flatMap((workspaceId) =>
    roomsForWorkspaceKick(workspaceId).map((roomPattern) => ({
      userId,
      roomPattern,
      reason,
      metadata: { driveId },
    })),
  );
}

// ---------------------------------------------------------------------------
// Imperative shell — injected deps, best-effort execution
// ---------------------------------------------------------------------------

export interface RevocationKickDeps {
  kick: (payload: KickPayload) => Promise<KickResult>;
  listDrivePageIds: (driveId: string) => Promise<string[]>;
  /**
   * Conversations hanging off these pages that `userId` does NOT own — the
   * `conv:` rooms a page (or drive) revocation must evict them from. Their own
   * conversations are excluded because ownership, not the revoked grant, is
   * what admits them there.
   */
  listRevocableConversationIds: (input: { pageIds: string[]; userId: string }) => Promise<string[]>;
  /**
   * Agent workspaces in this drive that `userId` does NOT own — the `session:`
   * rooms a drive-membership revocation must evict them from. Same ownership
   * carve-out: `decideAgentSessionAccess` admits the owner regardless of
   * membership.
   */
  listRevocableWorkspaceIds: (input: { driveId: string; userId: string }) => Promise<string[]>;
}

const defaultDeps: RevocationKickDeps = {
  kick: kickUserFromRooms,
  listDrivePageIds: async (driveId) => {
    const rows = await db.select({ id: pages.id }).from(pages).where(eq(pages.driveId, driveId));
    return rows.map((row) => row.id);
  },
  listRevocableConversationIds: async ({ pageIds, userId }) => {
    if (pageIds.length === 0) return [];
    const rows = await db
      .select({ id: conversations.id })
      .from(conversations)
      .where(
        and(
          eq(conversations.type, 'page'),
          inArray(conversations.contextId, pageIds),
          // Their own threads are theirs regardless of the revoked grant.
          ne(conversations.userId, userId),
        ),
      );
    return rows.map((row) => row.id);
  },
  listRevocableWorkspaceIds: async ({ driveId, userId }) => {
    const rows = await db
      .select({ id: agentWorkspaces.id })
      .from(agentWorkspaces)
      .where(and(eq(agentWorkspaces.driveId, driveId), ne(agentWorkspaces.ownerId, userId)));
    return rows.map((row) => row.id);
  },
};

/**
 * Run one enumeration, swallowing (and logging) its failure as an empty list.
 * An enumeration that fails must never stop the kicks that do not depend on
 * it, and must never throw out of a best-effort hook.
 */
async function enumerateOrNone<T>(
  enumerate: () => Promise<T[]>,
  message: string,
  context: Record<string, string>,
): Promise<T[]> {
  try {
    return await enumerate();
  } catch (error) {
    loggers.realtime.error(message, error instanceof Error ? error : undefined, context);
    return [];
  }
}

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
  const context = { pageId: args.pageId, reason: args.reason };
  // The page rooms need no lookup, so they fire immediately rather than
  // queueing behind the conversation enumeration — same reasoning the drive
  // hook below applies to its own page enumeration.
  const pageKicks = executeKicks(pageRevocationKickPayloads(args), deps, context);

  // The `conv:` rooms this page's conversations carry. Pre-epic, page-chat
  // content rode the page room above; the epic moved it here and this is what
  // keeps revocation reaching it.
  const conversationKicks = enumerateOrNone(
    () => deps.listRevocableConversationIds({ pageIds: [args.pageId], userId: args.userId }),
    'Revocation kick: conversation enumeration failed; kicking page rooms only',
    context,
  ).then((conversationIds) =>
    executeKicks(
      conversationRevocationKickPayloads({
        userId: args.userId,
        conversationIds,
        pageId: args.pageId,
        reason: args.reason,
      }),
      deps,
      context,
    ),
  );

  await Promise.all([pageKicks, conversationKicks]);
}

/**
 * Kick a user from every room a drive membership granted — the drive-scoped
 * rooms, every page room in the drive, every `conv:` content room those pages
 * carry, and every `session:` layout room in the drive — after their
 * membership was revoked. Never throws.
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

  const context = { driveId: args.driveId, reason: args.reason };

  // Pages, then the page rooms AND the conversation content rooms those pages
  // carry — `conv:` is keyed by conversation, so this is the only route to it.
  const pageAndConversationKicks = enumerateOrNone(
    () => deps.listDrivePageIds(args.driveId),
    'Revocation kick: drive page enumeration failed; kicking drive rooms only',
    { driveId: args.driveId },
  ).then(async (pageIds) => {
    const pageKicks = executeKicks(
      pageIds.flatMap((pageId) => pageRevocationKickPayloads({ userId: args.userId, pageId, reason: args.reason })),
      deps,
      context,
    );
    const conversationIds = await enumerateOrNone(
      () => deps.listRevocableConversationIds({ pageIds, userId: args.userId }),
      'Revocation kick: conversation enumeration failed; kicking drive and page rooms only',
      { driveId: args.driveId },
    );
    const conversationKicks = executeKicks(
      conversationRevocationKickPayloads({ userId: args.userId, conversationIds, reason: args.reason }),
      deps,
      context,
    );
    await Promise.all([pageKicks, conversationKicks]);
  });

  // Workspace layout rooms hang off the DRIVE, not off its pages, so they run
  // independently — a page enumeration failure must not cost them.
  const workspaceKicks = enumerateOrNone(
    () => deps.listRevocableWorkspaceIds({ driveId: args.driveId, userId: args.userId }),
    'Revocation kick: workspace enumeration failed; kicking drive rooms only',
    { driveId: args.driveId },
  ).then((workspaceIds) =>
    executeKicks(
      workspaceRevocationKickPayloads({
        userId: args.userId,
        workspaceIds,
        driveId: args.driveId,
        reason: args.reason,
      }),
      deps,
      context,
    ),
  );

  await Promise.all([driveKicks, pageAndConversationKicks, workspaceKicks]);
}
