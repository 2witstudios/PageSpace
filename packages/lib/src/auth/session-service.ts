import { generateOpaqueToken, isValidTokenFormat, type TokenType } from './opaque-tokens';
import { hashToken } from './token-utils';
import { IDLE_TIMEOUT_MS } from './constants';
import { sessionRepository } from './session-repository';

const SESSION_CLEANUP_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Pure clamp: the earlier of `currentExpiresAt` and `notLaterThan`. Never
 * returns a time later than `currentExpiresAt`, so a grace-expiry can only ever
 * bring a session's death forward — never postpone it.
 */
export function clampExpiry(currentExpiresAt: Date, notLaterThan: Date): Date {
  return currentExpiresAt.getTime() <= notLaterThan.getTime() ? currentExpiresAt : notLaterThan;
}

export interface SessionClaims {
  sessionId: string;
  userId: string;
  userRole: 'user' | 'admin';
  tokenVersion: number;
  adminRoleVersion: number;
  type: 'user' | 'service' | 'mcp' | 'device' | 'socket';
  scopes: string[];
  expiresAt: Date; // When this session expires - critical for enforcing TTL on persistent connections
  resourceType?: string;
  resourceId?: string;
  driveId?: string;
}

export interface CreateSessionOptions {
  userId: string;
  type: 'user' | 'service' | 'mcp' | 'device' | 'socket';
  scopes: string[];
  expiresInMs: number;
  deviceId?: string;
  resourceType?: string;
  resourceId?: string;
  driveId?: string;
  createdByService?: string;
  createdByIp?: string;
}

export class SessionService {
  /**
   * Create new session - returns raw token ONCE (never stored)
   */
  async createSession(options: CreateSessionOptions): Promise<string> {
    const user = await sessionRepository.findUserById(options.userId);

    if (!user) {
      throw new Error('User not found');
    }

    const tokenType: TokenType =
      options.type === 'service' ? 'svc' :
      options.type === 'mcp' ? 'mcp' :
      options.type === 'device' ? 'dev' :
      options.type === 'socket' ? 'sock' : 'sess';

    const { token, tokenHash, tokenPrefix } = generateOpaqueToken(tokenType);

    await sessionRepository.insertSession({
      tokenHash,
      tokenPrefix,
      userId: options.userId,
      deviceId: options.deviceId,
      type: options.type,
      scopes: options.scopes,
      resourceType: options.resourceType,
      resourceId: options.resourceId,
      driveId: options.driveId,
      tokenVersion: user.tokenVersion,
      adminRoleVersion: user.adminRoleVersion,
      createdByService: options.createdByService,
      createdByIp: options.createdByIp,
      expiresAt: new Date(Date.now() + options.expiresInMs),
    });

    return token;
  }

  /**
   * Validate token and return claims - this is the ONLY way to get claims
   *
   * `expectedType` scopes the token to one authentication surface: pass it at
   * every boundary that only serves a single session type (e.g. 'user' for
   * browser cookie/bearer auth, 'socket' for the Socket.IO handshake) so a
   * token leaked from one surface cannot be replayed on another.
   */
  async validateSession(
    token: string,
    options?: { expectedType?: SessionClaims['type'] }
  ): Promise<SessionClaims | null> {
    if (!isValidTokenFormat(token)) {
      return null;
    }

    const tokenHash = hashToken(token);

    const session = await sessionRepository.findActiveSession(tokenHash);

    if (!session) return null;
    if (!session.user) return null;

    // Wrong-surface token (e.g. a socket token presented as a session cookie):
    // reject without side effects — the token stays valid at its own surface.
    if (options?.expectedType && session.type !== options.expectedType) {
      return null;
    }

    // Check if user is suspended (administrative action)
    if (session.user.suspendedAt) {
      await this.revokeSession(token, 'user_suspended');
      return null;
    }

    if (session.tokenVersion !== session.user.tokenVersion) {
      await this.revokeSession(token, 'token_version_mismatch');
      return null;
    }

    // HIPAA idle timeout: revoke session if idle too long
    // Falls back to createdAt when lastUsedAt is NULL (new session or failed touchSession)
    if (IDLE_TIMEOUT_MS > 0) {
      const lastActivity = session.lastUsedAt ?? session.createdAt;
      const lastUsed = lastActivity instanceof Date ? lastActivity : new Date(lastActivity);
      const idleDuration = Date.now() - lastUsed.getTime();
      if (idleDuration > IDLE_TIMEOUT_MS) {
        await this.revokeSession(token, 'idle_timeout');
        return null;
      }
    }

    // Note: adminRoleVersion is NOT checked here - it's validated at the auth layer
    // by verifyAdminAuth() for admin operations. This allows demoted admins to
    // continue using their session for non-admin operations.

    // Update last used (non-blocking)
    sessionRepository.touchSession(tokenHash);

    return {
      sessionId: session.id,
      userId: session.userId,
      userRole: session.user.role,
      tokenVersion: session.tokenVersion,
      adminRoleVersion: session.adminRoleVersion,
      type: session.type,
      scopes: session.scopes,
      expiresAt: session.expiresAt,
      resourceType: session.resourceType ?? undefined,
      resourceId: session.resourceId ?? undefined,
      driveId: session.driveId ?? undefined,
    };
  }

  /**
   * Bring a session's expiry forward to at most `now + graceMs`, clamping so it
   * NEVER extends a live session (`min(current, now+grace)`). Used by device
   * refresh to retire the session it replaces WITHOUT an instant hard-revoke, so
   * in-flight requests (e.g. the 1s active-streams poll) stay valid for the
   * grace window instead of 401-storming. The retired session then dies on its
   * own via `validateSession`'s expiry check.
   *
   * No active session for the hash → no-op (never throws).
   */
  async expireSessionByHashSoon(tokenHash: string, graceMs: number): Promise<void> {
    const currentExpiresAt = await sessionRepository.getActiveSessionExpiry(tokenHash);
    if (!currentExpiresAt) return;

    const notLaterThan = new Date(Date.now() + graceMs);
    const clamped = clampExpiry(currentExpiresAt, notLaterThan);
    if (clamped.getTime() < currentExpiresAt.getTime()) {
      await sessionRepository.setExpiresAtByHash(tokenHash, clamped);
    }
  }

  async revokeSession(token: string, reason: string): Promise<void> {
    const tokenHash = hashToken(token);
    await sessionRepository.revokeByHash(tokenHash, reason);
  }

  /**
   * Revoke a single session by its already-hashed token. Used when the caller
   * has computed the hash itself (e.g. device refresh retiring the session it
   * replaces) and must not re-hash a raw token.
   */
  async revokeSessionByHash(tokenHash: string, reason: string): Promise<void> {
    await sessionRepository.revokeByHash(tokenHash, reason);
  }

  async revokeAllUserSessions(userId: string, reason: string): Promise<number> {
    return sessionRepository.revokeAllForUser(userId, reason);
  }

  /**
   * Revoke the user's sessions EXCEPT admin-console sessions. Used by web login
   * flows so signing into the web app does not log the user out of the admin app.
   */
  async revokeWebUserSessions(userId: string, reason: string): Promise<number> {
    return sessionRepository.revokeWebForUser(userId, reason);
  }

  /**
   * Revoke ONLY the user's admin-console sessions. Used by the admin login flow
   * so signing into the admin app does not log the user out of the web app.
   */
  async revokeAdminUserSessions(userId: string, reason: string): Promise<number> {
    return sessionRepository.revokeAdminForUser(userId, reason);
  }

  /**
   * Revoke sessions for a specific device only, enabling multi-device login.
   * Used by login endpoints when deviceId is available. Falls back to
   * revokeAllUserSessions when deviceId is absent (backward compat).
   */
  async revokeDeviceSessions(userId: string, deviceId: string, reason: string): Promise<number> {
    return sessionRepository.revokeForUserDevice(userId, deviceId, reason);
  }

  async cleanupExpiredSessions(): Promise<number> {
    return sessionRepository.deleteExpired(SESSION_CLEANUP_RETENTION_MS);
  }
}

export const sessionService = new SessionService();
