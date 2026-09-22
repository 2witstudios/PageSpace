/**
 * User-to-user blocking (App Review Guideline 1.2).
 *
 * A block is a `connections` row with status BLOCKED, whichever direction the
 * pair was stored in. It needs no prior connection: people who share a drive can
 * message each other without one, so blocking inserts the row when none exists.
 * Existing readers already honour it — conversation creation refuses a BLOCKED
 * pair — and `isBlockedBetween` extends that to messages in an existing
 * conversation.
 */
import { db } from '@pagespace/db/db';
import { and, eq, or } from '@pagespace/db/operators';
import { connections } from '@pagespace/db/schema/social';

const pair = (a: string, b: string) =>
  or(
    and(eq(connections.user1Id, a), eq(connections.user2Id, b)),
    and(eq(connections.user1Id, b), eq(connections.user2Id, a)),
  );

export async function isBlockedBetween(userA: string, userB: string): Promise<boolean> {
  const [row] = await db
    .select({ id: connections.id })
    .from(connections)
    .where(and(pair(userA, userB), eq(connections.status, 'BLOCKED')))
    .limit(1);
  return row !== undefined;
}

export async function blockUser(blockerId: string, targetId: string): Promise<void> {
  const now = new Date();
  const [existing] = await db
    .select({ id: connections.id })
    .from(connections)
    .where(pair(blockerId, targetId))
    .limit(1);

  if (existing) {
    await db
      .update(connections)
      .set({ status: 'BLOCKED', blockedBy: blockerId, blockedAt: now })
      .where(eq(connections.id, existing.id));
    return;
  }

  await db.insert(connections).values({
    user1Id: blockerId,
    user2Id: targetId,
    status: 'BLOCKED',
    requestedBy: blockerId,
    blockedBy: blockerId,
    blockedAt: now,
  });
}

/** Lifts a block this user placed. Mirrors the existing unblock: the row is removed. */
export async function unblockUser(blockerId: string, targetId: string): Promise<boolean> {
  const removed = await db
    .delete(connections)
    .where(and(pair(blockerId, targetId), eq(connections.status, 'BLOCKED'), eq(connections.blockedBy, blockerId)))
    .returning({ id: connections.id });
  return removed.length > 0;
}
