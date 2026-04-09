import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { db, users, verificationTokens, eq } from '@pagespace/db';
import { createId } from '@paralleldrive/cuid2';
import {
  createMagicLinkToken,
  verifyMagicLinkToken,
  MAGIC_LINK_EXPIRY_MINUTES,
} from './magic-link-service';
import { hashToken } from './token-utils';

// Riteway-style assert helper
interface AssertParams {
  given: string;
  should: string;
  actual: unknown;
  expected: unknown;
}

const assert = ({ given, should, actual, expected }: AssertParams): void => {
  const message = `Given ${given}, should ${should}`;
  expect(actual, message).toEqual(expected);
};

describe('Magic Link Service', () => {
  let testUserId: string;
  let testUserEmail: string;
  let dynamicallyCreatedUserIds: string[] = [];

  beforeEach(async () => {
    dynamicallyCreatedUserIds = [];
    testUserEmail = `magic-link-test-${Date.now()}@example.com`;
    const [user] = await db.insert(users).values({
      id: createId(),
      name: 'Magic Link Test User',
      email: testUserEmail,
      provider: 'email',
      role: 'user',
      tokenVersion: 1,
      emailVerified: new Date(),
    }).returning();
    testUserId = user.id;
  });

  afterEach(async () => {
    // Clean up tokens for all users (test user and dynamically created ones)
    const allUserIds = [testUserId, ...dynamicallyCreatedUserIds];
    for (const userId of allUserIds) {
      await db.delete(verificationTokens).where(eq(verificationTokens.userId, userId));
    }
    // Clean up users
    await db.delete(users).where(eq(users.id, testUserId));
    for (const userId of dynamicallyCreatedUserIds) {
      await db.delete(users).where(eq(users.id, userId));
    }
  });

  describe('createMagicLinkToken', () => {
    it('returns success with token for existing user', async () => {
      const result = await createMagicLinkToken({ email: testUserEmail });

      assert({
        given: 'an email for existing user',
        should: 'return ok: true',
        actual: result.ok,
        expected: true,
      });

      if (result.ok) {
        assert({
          given: 'an email for existing user',
          should: 'return ps_magic_ prefixed token',
          actual: result.data.token.startsWith('ps_magic_'),
          expected: true,
        });

        assert({
          given: 'an email for existing user',
          should: 'return isNewUser: false',
          actual: result.data.isNewUser,
          expected: false,
        });
      }
    });

    it('stores hash, not plaintext token', async () => {
      const result = await createMagicLinkToken({ email: testUserEmail });

      if (!result.ok) {
        throw new Error('Expected success');
      }

      const storedToken = await db.query.verificationTokens.findFirst({
        where: eq(verificationTokens.userId, testUserId),
      });

      assert({
        given: 'a created magic link token',
        should: 'store hash in database',
        actual: storedToken?.tokenHash,
        expected: hashToken(result.data.token),
      });

      assert({
        given: 'a created magic link token',
        should: 'not store plaintext',
        actual: storedToken?.tokenHash === result.data.token,
        expected: false,
      });
    });

    it('sets 5-minute expiry', async () => {
      const before = Date.now();
      const result = await createMagicLinkToken({ email: testUserEmail });

      if (!result.ok) {
        throw new Error('Expected success');
      }

      const storedToken = await db.query.verificationTokens.findFirst({
        where: eq(verificationTokens.userId, testUserId),
      });

      const expectedExpiryMs = MAGIC_LINK_EXPIRY_MINUTES * 60 * 1000;
      const expiresAtMs = storedToken?.expiresAt?.getTime() ?? 0;

      assert({
        given: 'a created magic link token',
        should: 'expire in approximately 5 minutes',
        actual: expiresAtMs >= before + expectedExpiryMs - 1000 && expiresAtMs <= before + expectedExpiryMs + 1000,
        expected: true,
      });
    });

    it('creates pending signup token for non-existent user', async () => {
      const newEmail = `new-user-${Date.now()}@example.com`;
      const result = await createMagicLinkToken({ email: newEmail });

      assert({
        given: 'an email for non-existent user',
        should: 'return ok: true',
        actual: result.ok,
        expected: true,
      });

      if (result.ok) {
        // Track dynamically created user for cleanup
        dynamicallyCreatedUserIds.push(result.data.userId);

        assert({
          given: 'an email for non-existent user',
          should: 'return isNewUser: true',
          actual: result.data.isNewUser,
          expected: true,
        });
      }
    });

    it('returns validation error for invalid email', async () => {
      const result = await createMagicLinkToken({ email: 'invalid-email' });

      assert({
        given: 'an invalid email',
        should: 'return ok: false',
        actual: result.ok,
        expected: false,
      });

      if (!result.ok) {
        assert({
          given: 'an invalid email',
          should: 'return VALIDATION_FAILED error code',
          actual: result.error.code,
          expected: 'VALIDATION_FAILED',
        });
      }
    });

    it('returns error for suspended user', async () => {
      await db.update(users)
        .set({ suspendedAt: new Date(), suspendedReason: 'test suspension' })
        .where(eq(users.id, testUserId));

      const result = await createMagicLinkToken({ email: testUserEmail });

      assert({
        given: 'a suspended user',
        should: 'return ok: false',
        actual: result.ok,
        expected: false,
      });

      if (!result.ok) {
        assert({
          given: 'a suspended user',
          should: 'return USER_SUSPENDED error code',
          actual: result.error.code,
          expected: 'USER_SUSPENDED',
        });
      }
    });

    it('cleans up old unused tokens for same user', async () => {
      // Create first token
      await createMagicLinkToken({ email: testUserEmail });

      const firstCount = await db.query.verificationTokens.findMany({
        where: eq(verificationTokens.userId, testUserId),
      });
      expect(firstCount).toHaveLength(1);

      // Create second token - should clean up first
      await createMagicLinkToken({ email: testUserEmail });

      const secondCount = await db.query.verificationTokens.findMany({
        where: eq(verificationTokens.userId, testUserId),
      });

      assert({
        given: 'multiple magic link requests',
        should: 'only keep latest token',
        actual: secondCount.length,
        expected: 1,
      });
    });
  });

  describe('verifyMagicLinkToken', () => {
    it('returns success with userId for valid token', async () => {
      const createResult = await createMagicLinkToken({ email: testUserEmail });
      if (!createResult.ok) throw new Error('Setup failed');

      const verifyResult = await verifyMagicLinkToken({ token: createResult.data.token });

      assert({
        given: 'a valid magic link token',
        should: 'return ok: true',
        actual: verifyResult.ok,
        expected: true,
      });

      if (verifyResult.ok) {
        assert({
          given: 'a valid magic link token',
          should: 'return correct userId',
          actual: verifyResult.data.userId,
          expected: testUserId,
        });

        assert({
          given: 'a valid magic link token for existing user',
          should: 'return isNewUser: false',
          actual: verifyResult.data.isNewUser,
          expected: false,
        });
      }
    });

    it('marks token as used after verification', async () => {
      const createResult = await createMagicLinkToken({ email: testUserEmail });
      if (!createResult.ok) throw new Error('Setup failed');

      await verifyMagicLinkToken({ token: createResult.data.token });

      const storedToken = await db.query.verificationTokens.findFirst({
        where: eq(verificationTokens.userId, testUserId),
      });

      assert({
        given: 'a verified magic link token',
        should: 'have usedAt timestamp set',
        actual: storedToken?.usedAt !== null,
        expected: true,
      });
    });

    it('returns TOKEN_ALREADY_USED for reused token', async () => {
      const createResult = await createMagicLinkToken({ email: testUserEmail });
      if (!createResult.ok) throw new Error('Setup failed');

      // First verification
      await verifyMagicLinkToken({ token: createResult.data.token });

      // Second verification attempt
      const secondVerify = await verifyMagicLinkToken({ token: createResult.data.token });

      assert({
        given: 'a previously used magic link token',
        should: 'return ok: false',
        actual: secondVerify.ok,
        expected: false,
      });

      if (!secondVerify.ok) {
        assert({
          given: 'a previously used magic link token',
          should: 'return TOKEN_ALREADY_USED error code',
          actual: secondVerify.error.code,
          expected: 'TOKEN_ALREADY_USED',
        });
      }
    });

    it('returns TOKEN_EXPIRED for expired token', async () => {
      const createResult = await createMagicLinkToken({ email: testUserEmail });
      if (!createResult.ok) throw new Error('Setup failed');

      // Manually expire the token
      await db.update(verificationTokens)
        .set({ expiresAt: new Date(Date.now() - 1000) })
        .where(eq(verificationTokens.userId, testUserId));

      const verifyResult = await verifyMagicLinkToken({ token: createResult.data.token });

      assert({
        given: 'an expired magic link token',
        should: 'return ok: false',
        actual: verifyResult.ok,
        expected: false,
      });

      if (!verifyResult.ok) {
        assert({
          given: 'an expired magic link token',
          should: 'return TOKEN_EXPIRED error code',
          actual: verifyResult.error.code,
          expected: 'TOKEN_EXPIRED',
        });
      }
    });

    it('returns TOKEN_NOT_FOUND for non-existent token', async () => {
      const verifyResult = await verifyMagicLinkToken({ token: 'ps_magic_nonexistent123' });

      assert({
        given: 'a non-existent magic link token',
        should: 'return ok: false',
        actual: verifyResult.ok,
        expected: false,
      });

      if (!verifyResult.ok) {
        assert({
          given: 'a non-existent magic link token',
          should: 'return TOKEN_NOT_FOUND error code',
          actual: verifyResult.error.code,
          expected: 'TOKEN_NOT_FOUND',
        });
      }
    });

    it('returns VALIDATION_FAILED for invalid token format', async () => {
      const verifyResult = await verifyMagicLinkToken({ token: 'invalid-format' });

      assert({
        given: 'an invalid token format',
        should: 'return ok: false',
        actual: verifyResult.ok,
        expected: false,
      });

      if (!verifyResult.ok) {
        assert({
          given: 'an invalid token format',
          should: 'return VALIDATION_FAILED error code',
          actual: verifyResult.error.code,
          expected: 'VALIDATION_FAILED',
        });
      }
    });

    it('returns USER_SUSPENDED for suspended user', async () => {
      const createResult = await createMagicLinkToken({ email: testUserEmail });
      if (!createResult.ok) throw new Error('Setup failed');

      // Suspend user after token creation
      await db.update(users)
        .set({ suspendedAt: new Date(), suspendedReason: 'test suspension' })
        .where(eq(users.id, testUserId));

      const verifyResult = await verifyMagicLinkToken({ token: createResult.data.token });

      assert({
        given: 'a magic link token for suspended user',
        should: 'return ok: false',
        actual: verifyResult.ok,
        expected: false,
      });

      if (!verifyResult.ok) {
        assert({
          given: 'a magic link token for suspended user',
          should: 'return USER_SUSPENDED error code',
          actual: verifyResult.error.code,
          expected: 'USER_SUSPENDED',
        });
      }
    });
  });
});
