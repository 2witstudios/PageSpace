/**
 * Session Repository - Database access layer for session operations.
 * Provides a clean seam for testing SessionService without ORM chain mocks.
 */

import { db, sessions, users, eq, and, or, isNull, gt, lt } from '@pagespace/db';

export interface SessionUserRecord {
  id: string;
  tokenVersion: number;
  role: 'user' | 'admin';
  adminRoleVersion: number;
}

export interface SessionRecord {
  id: string;
  userId: string;
  tokenHash: string;
  tokenVersion: number;
  adminRoleVersion: number;
  type: 'user' | 'service' | 'mcp' | 'device';
  scopes: string[];
  expiresAt: Date;
  lastUsedAt: Date | null;
  resourceType: string | null;
  resourceId: string | null;
  driveId: string | null;
  user: {
    id: string;
    tokenVersion: number;
    role: 'user' | 'admin';
    adminRoleVersion: number;
    suspendedAt: Date | null;
  } | null;
}

export const sessionRepository = {
  findUserById: async (userId: string): Promise<SessionUserRecord | undefined> => {
    return db.query.users.findFirst({
      where: eq(users.id, userId),
      columns: { id: true, tokenVersion: true, role: true, adminRoleVersion: true },
    }) as Promise<SessionUserRecord | undefined>;
  },

  findActiveSession: async (tokenHash: string): Promise<SessionRecord | undefined> => {
    return db.query.sessions.findFirst({
      where: and(
        eq(sessions.tokenHash, tokenHash),
        isNull(sessions.revokedAt),
        gt(sessions.expiresAt, new Date()),
      ),
      with: {
        user: {
          columns: { id: true, tokenVersion: true, role: true, adminRoleVersion: true, suspendedAt: true },
        },
      },
    }) as Promise<SessionRecord | undefined>;
  },

  insertSession: async (values: typeof sessions.$inferInsert): Promise<void> => {
    await db.insert(sessions).values(values);
  },

  touchSession: (tokenHash: string): void => {
    db.update(sessions)
      .set({ lastUsedAt: new Date() })
      .where(eq(sessions.tokenHash, tokenHash))
      .catch(() => {});
  },

  revokeByHash: async (tokenHash: string, reason: string): Promise<void> => {
    await db.update(sessions)
      .set({ revokedAt: new Date(), revokedReason: reason })
      .where(eq(sessions.tokenHash, tokenHash));
  },

  revokeAllForUser: async (userId: string, reason: string): Promise<number> => {
    const result = await db.update(sessions)
      .set({ revokedAt: new Date(), revokedReason: reason })
      .where(and(eq(sessions.userId, userId), isNull(sessions.revokedAt)));
    return result.rowCount ?? 0;
  },

  revokeForUserDevice: async (userId: string, deviceId: string, reason: string): Promise<number> => {
    // Revoke sessions matching this device OR legacy sessions with no device_id (pre-migration).
    // This ensures the first device-aware login after deploy cleans up old NULL sessions.
    const result = await db.update(sessions)
      .set({ revokedAt: new Date(), revokedReason: reason })
      .where(and(
        eq(sessions.userId, userId),
        or(eq(sessions.deviceId, deviceId), isNull(sessions.deviceId)),
        isNull(sessions.revokedAt),
      ));
    return result.rowCount ?? 0;
  },

  deleteExpired: async (retentionMs: number): Promise<number> => {
    const result = await db.delete(sessions)
      .where(lt(sessions.expiresAt, new Date(Date.now() - retentionMs)));
    return result.rowCount ?? 0;
  },
};
