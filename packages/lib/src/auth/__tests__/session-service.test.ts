import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { db, users, sessions } from '@pagespace/db';
import { eq, and, isNull } from 'drizzle-orm';
import { createId } from '@paralleldrive/cuid2';
import { sessionService } from '../session-service';

describe('Session Service', () => {
  let testUserId: string;

  beforeEach(async () => {
    const [user] = await db.insert(users).values({
      id: createId(),
      name: 'Test Session User',
      email: `test-session-${Date.now()}@example.com`,
      password: 'hashed_password',
      provider: 'email',
      role: 'user',
      tokenVersion: 1,
    }).returning();
    testUserId = user.id;
  });

  afterEach(async () => {
    await db.delete(sessions).where(eq(sessions.userId, testUserId));
    await db.delete(users).where(eq(users.id, testUserId));
  });

  describe('createSession', () => {
    it('creates session with valid user', async () => {
      const token = await sessionService.createSession({
        userId: testUserId,
        type: 'user',
        scopes: ['*'],
        expiresInMs: 3600000,
      });

      expect(token).toMatch(/^ps_sess_/);
      expect(token.length).toBeGreaterThan(40);
    });

    it('throws for non-existent user', async () => {
      await expect(
        sessionService.createSession({
          userId: 'non-existent',
          type: 'user',
          scopes: ['*'],
          expiresInMs: 3600000,
        })
      ).rejects.toThrow('User not found');
    });

    it('stores tokenHash, not raw token', async () => {
      const token = await sessionService.createSession({
        userId: testUserId,
        type: 'user',
        scopes: ['*'],
        expiresInMs: 3600000,
      });

      const allSessions = await db.query.sessions.findMany({
        where: eq(sessions.userId, testUserId),
      });

      expect(allSessions).toHaveLength(1);
      expect(allSessions[0].tokenHash).not.toBe(token);
      expect(allSessions[0].tokenHash).toHaveLength(64); // SHA-256 hex
    });

    it('captures user tokenVersion at creation', async () => {
      const token = await sessionService.createSession({
        userId: testUserId,
        type: 'user',
        scopes: ['*'],
        expiresInMs: 3600000,
      });

      const [session] = await db.query.sessions.findMany({
        where: eq(sessions.userId, testUserId),
      });

      expect(session.tokenVersion).toBe(1);
    });
  });

  describe('validateSession', () => {
    it('returns claims for valid session', async () => {
      const token = await sessionService.createSession({
        userId: testUserId,
        type: 'user',
        scopes: ['files:read'],
        expiresInMs: 3600000,
      });

      const claims = await sessionService.validateSession(token);

      expect(claims).toBeTruthy();
      expect(claims?.userId).toBe(testUserId);
      expect(claims?.scopes).toEqual(['files:read']);
      expect(claims?.type).toBe('user');
    });

    it('returns null for expired session', async () => {
      const token = await sessionService.createSession({
        userId: testUserId,
        type: 'user',
        scopes: ['*'],
        expiresInMs: 1, // 1ms
      });

      await new Promise(resolve => setTimeout(resolve, 10));

      const claims = await sessionService.validateSession(token);
      expect(claims).toBeNull();
    });

    it('returns null for revoked session', async () => {
      const token = await sessionService.createSession({
        userId: testUserId,
        type: 'user',
        scopes: ['*'],
        expiresInMs: 3600000,
      });

      await sessionService.revokeSession(token, 'test');

      const claims = await sessionService.validateSession(token);
      expect(claims).toBeNull();
    });

    it('returns null for tokenVersion mismatch', async () => {
      const token = await sessionService.createSession({
        userId: testUserId,
        type: 'user',
        scopes: ['*'],
        expiresInMs: 3600000,
      });

      await db.update(users)
        .set({ tokenVersion: 2 })
        .where(eq(users.id, testUserId));

      const claims = await sessionService.validateSession(token);
      expect(claims).toBeNull();
    });

    it('returns null for invalid token format', async () => {
      const claims = await sessionService.validateSession('invalid-token');
      expect(claims).toBeNull();
    });

    it('updates lastUsedAt on validation', async () => {
      const token = await sessionService.createSession({
        userId: testUserId,
        type: 'user',
        scopes: ['*'],
        expiresInMs: 3600000,
      });

      await new Promise(resolve => setTimeout(resolve, 100));

      await sessionService.validateSession(token);

      await new Promise(resolve => setTimeout(resolve, 200)); // Wait for non-blocking update

      const [session] = await db.query.sessions.findMany({
        where: eq(sessions.userId, testUserId),
      });

      expect(session.lastUsedAt).toBeTruthy();
    });
  });

  describe('revokeSession', () => {
    it('marks session as revoked', async () => {
      const token = await sessionService.createSession({
        userId: testUserId,
        type: 'user',
        scopes: ['*'],
        expiresInMs: 3600000,
      });

      await sessionService.revokeSession(token, 'logout');

      const [session] = await db.query.sessions.findMany({
        where: eq(sessions.userId, testUserId),
      });

      expect(session.revokedAt).toBeTruthy();
      expect(session.revokedReason).toBe('logout');
    });

    it('revoked session cannot be validated', async () => {
      const token = await sessionService.createSession({
        userId: testUserId,
        type: 'user',
        scopes: ['*'],
        expiresInMs: 3600000,
      });

      await sessionService.revokeSession(token, 'logout');

      const claims = await sessionService.validateSession(token);
      expect(claims).toBeNull();
    });
  });

  describe('revokeAllUserSessions', () => {
    it('revokes all active sessions for user', async () => {
      await sessionService.createSession({
        userId: testUserId,
        type: 'user',
        scopes: ['*'],
        expiresInMs: 3600000,
      });

      await sessionService.createSession({
        userId: testUserId,
        type: 'device',
        scopes: ['files:read'],
        expiresInMs: 3600000,
      });

      const count = await sessionService.revokeAllUserSessions(testUserId, 'logout_all');

      expect(count).toBe(2);

      const activeSessions = await db.query.sessions.findMany({
        where: and(
          eq(sessions.userId, testUserId),
          isNull(sessions.revokedAt)
        ),
      });

      expect(activeSessions).toHaveLength(0);
    });

    it('returns count of revoked sessions', async () => {
      await sessionService.createSession({
        userId: testUserId,
        type: 'user',
        scopes: ['*'],
        expiresInMs: 3600000,
      });

      const count = await sessionService.revokeAllUserSessions(testUserId, 'test');
      expect(count).toBe(1);
    });
  });
});
