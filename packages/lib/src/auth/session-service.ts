import { db, sessions, users } from '@pagespace/db';
import { eq, and, isNull, gt, lt } from 'drizzle-orm';
import { generateOpaqueToken, isValidTokenFormat, type TokenType } from './opaque-tokens';
import { hashToken } from './token-utils';

export interface SessionClaims {
  sessionId: string;
  userId: string;
  userRole: 'user' | 'admin';
  tokenVersion: number;
  type: 'user' | 'service' | 'mcp' | 'device';
  scopes: string[];
  resourceType?: string;
  resourceId?: string;
}

export interface CreateSessionOptions {
  userId: string;
  type: 'user' | 'service' | 'mcp' | 'device';
  scopes: string[];
  expiresInMs: number;
  resourceType?: string;
  resourceId?: string;
  createdByService?: string;
  createdByIp?: string;
}

export class SessionService {
  /**
   * Create new session - returns raw token ONCE (never stored)
   */
  async createSession(options: CreateSessionOptions): Promise<string> {
    const user = await db.query.users.findFirst({
      where: eq(users.id, options.userId),
      columns: { id: true, tokenVersion: true, role: true },
    });

    if (!user) {
      throw new Error('User not found');
    }

    const tokenType: TokenType =
      options.type === 'service' ? 'svc' :
      options.type === 'mcp' ? 'mcp' :
      options.type === 'device' ? 'dev' : 'sess';

    const { token, tokenHash, tokenPrefix } = generateOpaqueToken(tokenType);

    await db.insert(sessions).values({
      tokenHash,
      tokenPrefix,
      userId: options.userId,
      type: options.type,
      scopes: options.scopes,
      resourceType: options.resourceType,
      resourceId: options.resourceId,
      tokenVersion: user.tokenVersion,
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

    const session = await db.query.sessions.findFirst({
      where: and(
        eq(sessions.tokenHash, tokenHash),
        isNull(sessions.revokedAt),
        gt(sessions.expiresAt, new Date())
      ),
      with: {
        user: {
          columns: { id: true, tokenVersion: true, role: true }
        }
      }
    });

    if (!session) return null;
    if (!session.user) return null;
    if (session.tokenVersion !== session.user.tokenVersion) {
      await this.revokeSession(token, 'token_version_mismatch');
      return null;
    }

    // Update last used (non-blocking)
    db.update(sessions)
      .set({ lastUsedAt: new Date() })
      .where(eq(sessions.tokenHash, tokenHash))
      .catch(() => {});

    return {
      sessionId: session.id,
      userId: session.userId,
      userRole: session.user.role,
      tokenVersion: session.tokenVersion,
      type: session.type,
      scopes: session.scopes,
      resourceType: session.resourceType ?? undefined,
      resourceId: session.resourceId ?? undefined,
    };
  }

  async revokeSession(token: string, reason: string): Promise<void> {
    const tokenHash = hashToken(token);
    await db.update(sessions)
      .set({ revokedAt: new Date(), revokedReason: reason })
      .where(eq(sessions.tokenHash, tokenHash));
  }

  async revokeAllUserSessions(userId: string, reason: string): Promise<number> {
    const result = await db.update(sessions)
      .set({ revokedAt: new Date(), revokedReason: reason })
      .where(and(
        eq(sessions.userId, userId),
        isNull(sessions.revokedAt)
      ));
    return result.rowCount ?? 0;
  }

  async cleanupExpiredSessions(): Promise<number> {
    const result = await db.delete(sessions)
      .where(lt(sessions.expiresAt, new Date(Date.now() - 7 * 24 * 60 * 60 * 1000)));
    return result.rowCount ?? 0;
  }
}

export const sessionService = new SessionService();
