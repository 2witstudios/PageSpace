/**
 * Sessions Schema Tests
 *
 * Tests for the sessions table schema (P2-T1).
 * Verifies table constraints, relations, and indexes.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { db, sessions, users } from '../index';
import { eq, and, isNull } from 'drizzle-orm';
import { createId } from '@paralleldrive/cuid2';

describe('Sessions Schema', () => {
  let testUserId = '';

  beforeEach(async () => {
    // Generate unique test ID first
    const uniqueId = createId();

    // Clean any orphaned test sessions (defensive cleanup)
    await db.delete(sessions).where(eq(sessions.tokenHash, 'abc123hash'));
    await db.delete(sessions).where(eq(sessions.tokenHash, 'unique-hash'));
    await db.delete(sessions).where(eq(sessions.tokenHash, 'cascade-test'));
    await db.delete(sessions).where(eq(sessions.tokenHash, 'hash-1'));
    await db.delete(sessions).where(eq(sessions.tokenHash, 'hash-2'));

    const [user] = await db.insert(users).values({
      id: uniqueId,
      name: 'Test Session User',
      email: `test-session-${uniqueId}@example.com`,
      password: 'hashed_password',
      provider: 'email',
      role: 'user',
      tokenVersion: 1,
    }).returning();

    testUserId = user.id;
  });

  afterEach(async () => {
    if (!testUserId) return;

    try {
      // Delete sessions before user (cascade also handles this, but explicit is safer)
      await db.delete(sessions).where(eq(sessions.userId, testUserId));
      await db.delete(users).where(eq(users.id, testUserId));
    } catch {
      // User may already be deleted by "cascades delete" test
    }

    testUserId = '';
  });

  it('creates session with required fields', async () => {
    const [session] = await db.insert(sessions).values({
      tokenHash: 'abc123hash',
      tokenPrefix: 'ps_sess_abc',
      userId: testUserId,
      type: 'user',
      scopes: ['*'],
      tokenVersion: 1,
      expiresAt: new Date(Date.now() + 3600000),
    }).returning();

    expect(session.id).toBeTruthy();
    expect(session.tokenHash).toBe('abc123hash');
    expect(session.userId).toBe(testUserId);
    expect(session.type).toBe('user');
    expect(session.scopes).toEqual(['*']);
  });

  it('enforces unique tokenHash', async () => {
    await db.insert(sessions).values({
      tokenHash: 'unique-hash',
      tokenPrefix: 'ps_sess_abc',
      userId: testUserId,
      type: 'user',
      scopes: [],
      tokenVersion: 1,
      expiresAt: new Date(Date.now() + 3600000),
    });

    await expect(
      db.insert(sessions).values({
        tokenHash: 'unique-hash', // Duplicate
        tokenPrefix: 'ps_sess_xyz',
        userId: testUserId,
        type: 'user',
        scopes: [],
        tokenVersion: 1,
        expiresAt: new Date(Date.now() + 3600000),
      })
    ).rejects.toThrow();
  });

  it('cascades delete on user deletion', async () => {
    await db.insert(sessions).values({
      tokenHash: 'cascade-test',
      tokenPrefix: 'ps_sess_abc',
      userId: testUserId,
      type: 'user',
      scopes: [],
      tokenVersion: 1,
      expiresAt: new Date(Date.now() + 3600000),
    });

    await db.delete(users).where(eq(users.id, testUserId));

    const remainingSessions = await db.query.sessions.findMany({
      where: eq(sessions.userId, testUserId),
    });

    expect(remainingSessions).toHaveLength(0);
  });

  it('queries by indexed fields return expected results', async () => {
    // Create multiple sessions
    await db.insert(sessions).values([
      {
        tokenHash: 'hash-1',
        tokenPrefix: 'ps_sess_1',
        userId: testUserId,
        type: 'user',
        scopes: [],
        tokenVersion: 1,
        expiresAt: new Date(Date.now() + 3600000),
      },
      {
        tokenHash: 'hash-2',
        tokenPrefix: 'ps_sess_2',
        userId: testUserId,
        type: 'user',
        scopes: [],
        tokenVersion: 1,
        expiresAt: new Date(Date.now() - 1000), // Expired
      },
    ]);

    // Test userId index
    const userSessions = await db.query.sessions.findMany({
      where: eq(sessions.userId, testUserId),
    });
    expect(userSessions).toHaveLength(2);

    // Test tokenHash index
    const sessionByHash = await db.query.sessions.findFirst({
      where: eq(sessions.tokenHash, 'hash-1'),
    });
    expect(sessionByHash?.tokenPrefix).toBe('ps_sess_1');
  });
});
