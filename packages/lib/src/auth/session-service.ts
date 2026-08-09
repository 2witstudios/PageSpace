import { generateOpaqueToken, isValidTokenFormat, type TokenType } from './opaque-tokens';
import { hashToken } from './token-utils';
import { IDLE_TIMEOUT_MS } from './constants';
import { sessionRepository } from './session-repository';
import { loggers } from '../logging/logger-config';

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

/**
 * Why a session token failed to validate. Additive diagnostics (D5) — surfaced in audit logs
 * so an incident is provable (expired vs revoked vs grace-expired vs never-existed) instead of
 * a bare `auth_failed`.
 */
export type SessionFailureReason =
  | 'bad_format'
  | 'not_found'
  | 'expired'
  | 'revoked'
  | 'wrong_type'
  | 'user_suspended'
  | 'token_version_mismatch'
  | 'idle_timeout';

export interface SessionValidationSuccess {
  claims: SessionClaims;
  failureReason?: undefined;
}

export interface SessionValidationFailure {
  claims?: undefined;
  failureReason: SessionFailureReason;
  /** For `revoked`: the reason recorded on the session row (e.g. `device_id_mismatch`). */
  revokedReason?: string;
  /** For `expired`/`revoked`: the session's expiry (≈ the retirement time for a grace-expiry). */
  expiresAt?: Date;
  /** First 8 chars of the session id — enough to correlate logs without exposing the full id. */
  sessionIdPrefix?: string;
}

export type SessionValidationResult = SessionValidationSuccess | SessionValidationFailure;

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
   * Validate token and return claims OR the reason it failed (D5).
   *
   * Behaviourally identical to the historical `validateSession` — same reject conditions, same
   * revoke/touch side effects — but instead of collapsing every failure to `null`, it names the
   * reason. When no ACTIVE session is found, it does a secondary any-state lookup to split
   * `revoked` vs `expired` (incl. #2176's grace-expiries: revokedAt null, expiresAt in the past)
   * vs a genuinely unknown `not_found`.
   *
   * `expectedType` scopes the token to one authentication surface: pass it at every boundary that
   * only serves a single session type (e.g. 'user' for browser cookie/bearer auth) so a token
   * leaked from one surface cannot be replayed on another.
   */
  async validateSessionWithReason(
    token: string,
    options?: { expectedType?: SessionClaims['type'] }
  ): Promise<SessionValidationResult> {
    if (!isValidTokenFormat(token)) {
      return { failureReason: 'bad_format' };
    }

    const tokenHash = hashToken(token);

    const session = await sessionRepository.findActiveSession(tokenHash);

    if (!session || !session.user) {
      // No usable active session — ask the any-state lookup WHY (revoked vs expired vs unknown).
      const anyState = await sessionRepository.findSessionByHashAnyState(tokenHash);
      if (!anyState) {
        return { failureReason: 'not_found' };
      }
      const sessionIdPrefix = anyState.id.slice(0, 8);
      if (anyState.revokedAt) {
        return {
          failureReason: 'revoked',
          revokedReason: anyState.revokedReason ?? undefined,
          expiresAt: anyState.expiresAt,
          sessionIdPrefix,
        };
      }
      // Not revoked. Classify by expiry, NOT by "not active" — because we also reach here for a
      // still-active row whose USER was deleted (findActiveSession left-joins the user, so a
      // userless row fails the `!session.user` guard above while its own expiry is still in the
      // future). Only an expiry actually in the past is `expired` (a grace-expiry from
      // expireSessionByHashSoon: revokedAt null, expiresAt clamped into the past). A future expiry
      // here means the session row exists but is unusable (orphaned by a deleted user) — that is
      // `not_found`, not `expired`.
      if (anyState.expiresAt.getTime() <= Date.now()) {
        return { failureReason: 'expired', expiresAt: anyState.expiresAt, sessionIdPrefix };
      }
      return { failureReason: 'not_found', sessionIdPrefix };
    }

    const sessionIdPrefix = session.id.slice(0, 8);

    // Wrong-surface token (e.g. a socket token presented as a session cookie):
    // reject without side effects — the token stays valid at its own surface.
    if (options?.expectedType && session.type !== options.expectedType) {
      return { failureReason: 'wrong_type', sessionIdPrefix };
    }

    // Check if user is suspended (administrative action)
    if (session.user.suspendedAt) {
      await this.revokeSession(token, 'user_suspended');
      return { failureReason: 'user_suspended', sessionIdPrefix };
    }

    if (session.tokenVersion !== session.user.tokenVersion) {
      await this.revokeSession(token, 'token_version_mismatch');
      return { failureReason: 'token_version_mismatch', sessionIdPrefix };
    }

    // HIPAA idle timeout: revoke session if idle too long
    // Falls back to createdAt when lastUsedAt is NULL (new session or failed touchSession)
    if (IDLE_TIMEOUT_MS > 0) {
      const lastActivity = session.lastUsedAt ?? session.createdAt;
      const lastUsed = lastActivity instanceof Date ? lastActivity : new Date(lastActivity);
      const idleDuration = Date.now() - lastUsed.getTime();
      if (idleDuration > IDLE_TIMEOUT_MS) {
        await this.revokeSession(token, 'idle_timeout');
        return { failureReason: 'idle_timeout', sessionIdPrefix };
      }
    }

    // Note: adminRoleVersion is NOT checked here - it's validated at the auth layer
    // by verifyAdminAuth() for admin operations. This allows demoted admins to
    // continue using their session for non-admin operations.

    // Update last used (non-blocking)
    sessionRepository.touchSession(tokenHash);

    return {
      claims: {
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
      },
    };
  }

  /**
   * Validate token and return claims - this is the ONLY way to get claims.
   *
   * Thin, non-breaking wrapper over `validateSessionWithReason`: returns the claims on success or
   * `null` on any failure, exactly as before. New callers that want the failure reason should use
   * `validateSessionWithReason` directly.
   */
  async validateSession(
    token: string,
    options?: { expectedType?: SessionClaims['type'] }
  ): Promise<SessionClaims | null> {
    const result = await this.validateSessionWithReason(token, options);
    return result.claims ?? null;
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
      // Make grace-expiries visible in prod: this is the mechanism that later surfaces as an
      // `expired` failure reason (D5), so logging the clamp lets an incident be traced end-to-end.
      loggers.auth.info('Session grace-expiry clamped', {
        // A short, non-reversible correlator (8 of 64 hex chars). Named to avoid the logger's
        // `token`/`hash` redaction so it survives as a usable trace key.
        sessionRef: tokenHash.slice(0, 8),
        graceMs,
        clampedTo: clamped.toISOString(),
        previousExpiresAt: currentExpiresAt.toISOString(),
      });
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
