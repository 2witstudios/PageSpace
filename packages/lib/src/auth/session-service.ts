import { generateOpaqueToken, isValidTokenFormat, type TokenType } from './opaque-tokens';
import { hashToken } from './token-utils';
import { IDLE_TIMEOUT_MS } from './constants';
import { sessionRepository } from './session-repository';

const SESSION_CLEANUP_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

export interface SessionClaims {
  sessionId: string;
  userId: string;
  userRole: 'user' | 'admin';
  tokenVersion: number;
  adminRoleVersion: number;
  type: 'user' | 'service' | 'mcp' | 'device';
  scopes: string[];
  expiresAt: Date; // When this session expires - critical for enforcing TTL on persistent connections
  resourceType?: string;
  resourceId?: string;
  driveId?: string;
}

export interface CreateSessionOptions {
  userId: string;
  type: 'user' | 'service' | 'mcp' | 'device';
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
      options.type === 'device' ? 'dev' : 'sess';

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
   */
  async validateSession(token: string): Promise<SessionClaims | null> {
    if (!isValidTokenFormat(token)) {
      return null;
    }

    const tokenHash = hashToken(token);

    const session = await sessionRepository.findActiveSession(tokenHash);

    if (!session) return null;
    if (!session.user) return null;

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
    if (IDLE_TIMEOUT_MS > 0 && session.lastUsedAt) {
      const lastUsed = session.lastUsedAt instanceof Date ? session.lastUsedAt : new Date(session.lastUsedAt);
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

  async revokeSession(token: string, reason: string): Promise<void> {
    const tokenHash = hashToken(token);
    await sessionRepository.revokeByHash(tokenHash, reason);
  }

  async revokeAllUserSessions(userId: string, reason: string): Promise<number> {
    return sessionRepository.revokeAllForUser(userId, reason);
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
