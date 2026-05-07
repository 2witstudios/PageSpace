import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { db } from '@pagespace/db/db';
import { eq } from '@pagespace/db/operators';
import { users, verificationTokens } from '@pagespace/db/schema/auth';
import { createId } from '@paralleldrive/cuid2';
import { verifyMagicLinkToken, MAGIC_LINK_EXPIRY_MINUTES } from './magic-link-service';
import { generateToken } from './token-utils';

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

/**
 * Mint a magic_link verificationTokens row directly so verify-side tests can
 * exercise the lookup without depending on the issuance path. Mirrors what
 * the magic-link adapter does in production.
 */
const mintMagicLinkToken = async (userId: string): Promise<string> => {
  const { token, hash, tokenPrefix } = generateToken('ps_magic');
  const expiresAt = new Date(Date.now() + MAGIC_LINK_EXPIRY_MINUTES * 60 * 1000);
  await db.insert(verificationTokens).values({
    id: createId(),
    userId,
    tokenHash: hash,
    tokenPrefix,
    type: 'magic_link',
    expiresAt,
  });
  return token;
};

describe('Magic Link Service', () => {
  let testUserId: string;
  let testUserEmail: string;

  beforeEach(async () => {
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
    await db.delete(verificationTokens).where(eq(verificationTokens.userId, testUserId));
    await db.delete(users).where(eq(users.id, testUserId));
  });

  describe('verifyMagicLinkToken', () => {
    it('returns success with userId for valid token', async () => {
      const token = await mintMagicLinkToken(testUserId);

      const verifyResult = await verifyMagicLinkToken({ token });

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
      const token = await mintMagicLinkToken(testUserId);

      await verifyMagicLinkToken({ token });

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
      const token = await mintMagicLinkToken(testUserId);

      await verifyMagicLinkToken({ token });
      const secondVerify = await verifyMagicLinkToken({ token });

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
      const token = await mintMagicLinkToken(testUserId);

      await db
        .update(verificationTokens)
        .set({ expiresAt: new Date(Date.now() - 1000) })
        .where(eq(verificationTokens.userId, testUserId));

      const verifyResult = await verifyMagicLinkToken({ token });

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
      const token = await mintMagicLinkToken(testUserId);

      await db
        .update(users)
        .set({ suspendedAt: new Date(), suspendedReason: 'test suspension' })
        .where(eq(users.id, testUserId));

      const verifyResult = await verifyMagicLinkToken({ token });

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
