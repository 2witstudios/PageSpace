/**
 * Session Repository - Database access layer for session operations.
 * Provides a clean seam for testing SessionService without ORM chain mocks.
 */

import { db } from '@pagespace/db/db';
import { eq, ne, and, or, isNull, gt, lt } from '@pagespace/db/operators';
import { users } from '@pagespace/db/schema/auth';
import { sessions } from '@pagespace/db/schema/sessions';
import { ADMIN_SESSION_SERVICE } from './constants';

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
  type: 'user' | 'service' | 'mcp' | 'device' | 'socket';
  scopes: string[];
  expiresAt: Date;
  lastUsedAt: Date | null;
  createdAt: Date;
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

/**
 * A session row read WITHOUT the active-only filter (any revoked/expired state), for
 * explaining WHY there is no active session (D5). Deliberately minimal: just the columns the
 * failure-reason classifier needs, no user join.
 */
export interface SessionAnyStateRecord {
  id: string;
  type: 'user' | 'service' | 'mcp' | 'device' | 'socket';
  revokedAt: Date | null;
  revokedReason: string | null;
  expiresAt: Date;
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

  // Look up a session by hash in ANY state (revoked, expired, or active). Used by the
  // failure-reason classifier when findActiveSession finds nothing, to split "revoked" vs
  // "grace-expired" vs "genuinely never existed". No revoked/expiry predicate, no user join.
  findSessionByHashAnyState: async (tokenHash: string): Promise<SessionAnyStateRecord | undefined> => {
    return db.query.sessions.findFirst({
      where: eq(sessions.tokenHash, tokenHash),
      columns: { id: true, type: true, revokedAt: true, revokedReason: true, expiresAt: true },
    }) as Promise<SessionAnyStateRecord | undefined>;
  },

  insertSession: async (values: typeof sessions.$inferInsert): Promise<void> => {
    await db.insert(sessions).values(values);
  },

  touchSession: (tokenHash: string): void => {
    db.update(sessions)
      .set({ lastUsedAt: new Date() })
      .where(eq(sessions.tokenHash, tokenHash))
      .catch((err) => { console.error('[auth] Failed to update session lastUsedAt', err); });
  },

  // Read the expiry of a single active (non-revoked, unexpired) session by hash.
  // Used by the grace-expiry op to clamp — returns undefined when there is no
  // such session (already revoked/expired/absent), so the caller no-ops.
  getActiveSessionExpiry: async (tokenHash: string): Promise<Date | undefined> => {
    const row = await db.query.sessions.findFirst({
      where: and(
        eq(sessions.tokenHash, tokenHash),
        isNull(sessions.revokedAt),
        gt(sessions.expiresAt, new Date()),
      ),
      columns: { expiresAt: true },
    });
    return row?.expiresAt;
  },

  // Bring a session's expiry forward (grace-expiry). The `gt` guard makes this
  // update physically unable to EXTEND a session even under a stale-read race —
  // it only ever writes an earlier expiry.
  setExpiresAtByHash: async (tokenHash: string, expiresAt: Date): Promise<void> => {
    await db.update(sessions)
      .set({ expiresAt })
      .where(and(
        eq(sessions.tokenHash, tokenHash),
        isNull(sessions.revokedAt),
        gt(sessions.expiresAt, expiresAt),
      ));
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

  // Revoke every active session for the user EXCEPT admin-console sessions, so a
  // web login does not knock the user out of the admin app.
  revokeWebForUser: async (userId: string, reason: string): Promise<number> => {
    const result = await db.update(sessions)
      .set({ revokedAt: new Date(), revokedReason: reason })
      .where(and(
        eq(sessions.userId, userId),
        or(
          ne(sessions.createdByService, ADMIN_SESSION_SERVICE),
          isNull(sessions.createdByService),
        ),
        isNull(sessions.revokedAt),
      ));
    return result.rowCount ?? 0;
  },

  // Revoke ONLY admin-console sessions for the user, so an admin login does not
  // knock the user out of the main web app.
  revokeAdminForUser: async (userId: string, reason: string): Promise<number> => {
    const result = await db.update(sessions)
      .set({ revokedAt: new Date(), revokedReason: reason })
      .where(and(
        eq(sessions.userId, userId),
        eq(sessions.createdByService, ADMIN_SESSION_SERVICE),
        isNull(sessions.revokedAt),
      ));
    return result.rowCount ?? 0;
  },

  revokeForUserDevice: async (userId: string, deviceId: string, reason: string): Promise<number> => {
    // Revoke sessions matching this device OR legacy sessions with no device_id (pre-migration).
    // This ensures the first device-aware login after deploy cleans up old NULL sessions.
    // Exclude admin-console sessions: they always have a NULL device_id and must not be
    // collaterally revoked by a web/desktop device login.
    const result = await db.update(sessions)
      .set({ revokedAt: new Date(), revokedReason: reason })
      .where(and(
        eq(sessions.userId, userId),
        or(eq(sessions.deviceId, deviceId), isNull(sessions.deviceId)),
        or(
          ne(sessions.createdByService, ADMIN_SESSION_SERVICE),
          isNull(sessions.createdByService),
        ),
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
