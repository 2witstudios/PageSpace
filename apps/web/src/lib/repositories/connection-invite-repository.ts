/**
 * Repository for connection-by-email invitation database operations.
 * Mirrors the shape of `drive-invite-repository.ts`.
 *
 * Connection acceptance creates a `connections` row in PENDING state — not
 * ACCEPTED. The design (see every-invite-flow plan) treats connect-as-collab
 * as a personal user-to-user choice that should not be auto-granted by an
 * email-control proof alone. The invited user still confirms from the
 * connections UI.
 */

import { db } from '@pagespace/db/db'
import { eq, and, gt, lte, isNull, or } from '@pagespace/db/operators'
import { users } from '@pagespace/db/schema/auth'
import { connections } from '@pagespace/db/schema/social';
import { pendingConnectionInvites } from '@pagespace/db/schema/pending-connection-invites';

// Returns [user1Id, user2Id] in sorted order so the
// `connections_user_pair_key` unique constraint behaves consistently
// regardless of which side initiates.
const sortedPair = (a: string, b: string): [string, string] =>
  a < b ? [a, b] : [b, a];

export const connectionInviteRepository = {
  async findPendingInviteByTokenHash(tokenHash: string): Promise<{
    id: string;
    email: string;
    invitedBy: string;
    inviterName: string;
    requestMessage: string | null;
    expiresAt: Date;
    consumedAt: Date | null;
  } | null> {
    const results = await db
      .select({
        id: pendingConnectionInvites.id,
        email: pendingConnectionInvites.email,
        invitedBy: pendingConnectionInvites.invitedBy,
        inviterName: users.name,
        requestMessage: pendingConnectionInvites.requestMessage,
        expiresAt: pendingConnectionInvites.expiresAt,
        consumedAt: pendingConnectionInvites.consumedAt,
      })
      .from(pendingConnectionInvites)
      .innerJoin(users, eq(users.id, pendingConnectionInvites.invitedBy))
      .where(eq(pendingConnectionInvites.tokenHash, tokenHash))
      .limit(1);
    return results.at(0) ?? null;
  },

  async createPendingInvite(input: {
    tokenHash: string;
    email: string;
    invitedBy: string;
    requestMessage: string | null;
    expiresAt: Date;
    now: Date;
  }) {
    const { tokenHash, email, invitedBy, requestMessage, expiresAt, now } = input;
    return db.transaction(async (tx) => {
      // Sweep already-expired unconsumed rows for the same (invitedBy, email)
      // pair so the partial unique index doesn't block a legitimate re-invite.
      await tx.delete(pendingConnectionInvites).where(
        and(
          eq(pendingConnectionInvites.invitedBy, invitedBy),
          eq(pendingConnectionInvites.email, email),
          isNull(pendingConnectionInvites.consumedAt),
          lte(pendingConnectionInvites.expiresAt, now),
        )
      );
      const [row] = await tx
        .insert(pendingConnectionInvites)
        .values({ tokenHash, email, invitedBy, requestMessage, expiresAt })
        .returning();
      return row;
    });
  },

  async deletePendingInvite(inviteId: string): Promise<void> {
    await db.delete(pendingConnectionInvites).where(
      eq(pendingConnectionInvites.id, inviteId),
    );
  },

  async findActivePendingInviteByOwnerAndEmail(
    invitedBy: string,
    email: string,
    now: Date,
  ): Promise<{ id: string } | null> {
    const results = await db
      .select({ id: pendingConnectionInvites.id })
      .from(pendingConnectionInvites)
      .where(
        and(
          eq(pendingConnectionInvites.invitedBy, invitedBy),
          eq(pendingConnectionInvites.email, email),
          isNull(pendingConnectionInvites.consumedAt),
          gt(pendingConnectionInvites.expiresAt, now),
        )
      )
      .limit(1);
    return results.at(0) ?? null;
  },

  async findExistingConnection(
    userId: string,
    inviterId: string,
  ): Promise<{ id: string; status: 'PENDING' | 'ACCEPTED' | 'BLOCKED' } | null> {
    const [u1, u2] = sortedPair(userId, inviterId);
    const results = await db
      .select({ id: connections.id, status: connections.status })
      .from(connections)
      .where(
        or(
          and(eq(connections.user1Id, u1), eq(connections.user2Id, u2)),
          and(eq(connections.user1Id, u2), eq(connections.user2Id, u1)),
        ),
      )
      .limit(1);
    return results.at(0) ?? null;
  },

  async findUnconsumedActiveInvitesByEmail(
    email: string,
    now: Date,
  ): Promise<Array<{ id: string; invitedBy: string; requestMessage: string | null }>> {
    return db
      .select({
        id: pendingConnectionInvites.id,
        invitedBy: pendingConnectionInvites.invitedBy,
        requestMessage: pendingConnectionInvites.requestMessage,
      })
      .from(pendingConnectionInvites)
      .where(
        and(
          eq(pendingConnectionInvites.email, email),
          isNull(pendingConnectionInvites.consumedAt),
          gt(pendingConnectionInvites.expiresAt, now),
        ),
      );
  },

  async consumeInviteAndCreateConnection(input: {
    inviteId: string;
    invitedBy: string;
    userId: string;
    requestMessage: string | null;
    now: Date;
  }): Promise<
    | { ok: true; connectionId: string; status: 'PENDING' | 'ACCEPTED' }
    | { ok: false; reason: 'TOKEN_CONSUMED' | 'ALREADY_CONNECTED' }
  > {
    const ALREADY_CONNECTED = Symbol('ALREADY_CONNECTED');
    try {
      const result = await db.transaction(async (tx) => {
        const consumed = await tx
          .update(pendingConnectionInvites)
          .set({ consumedAt: input.now })
          .where(
            and(
              eq(pendingConnectionInvites.id, input.inviteId),
              isNull(pendingConnectionInvites.consumedAt),
            ),
          )
          .returning({ id: pendingConnectionInvites.id });
        if (consumed.length === 0) {
          throw 'TOKEN_CONSUMED';
        }

        const [user1Id, user2Id] = sortedPair(input.userId, input.invitedBy);
        try {
          const [row] = await tx
            .insert(connections)
            .values({
              user1Id,
              user2Id,
              status: 'PENDING',
              requestedBy: input.invitedBy,
              requestMessage: input.requestMessage,
            })
            .returning({ id: connections.id, status: connections.status });
          return { connectionId: row.id, status: row.status };
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          const isUniqueViolation =
            message.includes('connections_user_pair_key') ||
            (message.includes('duplicate key') && message.includes('connections'));
          if (isUniqueViolation) {
            throw ALREADY_CONNECTED;
          }
          throw error;
        }
      });
      return {
        ok: true,
        connectionId: result.connectionId,
        status: result.status === 'BLOCKED' ? 'PENDING' : result.status,
      };
    } catch (error) {
      if (error === 'TOKEN_CONSUMED') {
        return { ok: false, reason: 'TOKEN_CONSUMED' };
      }
      if (error === ALREADY_CONNECTED) {
        return { ok: false, reason: 'ALREADY_CONNECTED' };
      }
      throw error;
    }
  },

  async findInviterDisplay(userId: string): Promise<{ name: string; email: string } | null> {
    const user = await db.query.users.findFirst({
      where: eq(users.id, userId),
      columns: { name: true, email: true },
    });
    return user ? { name: user.name, email: user.email } : null;
  },
};

export type ConnectionInviteRepository = typeof connectionInviteRepository;
