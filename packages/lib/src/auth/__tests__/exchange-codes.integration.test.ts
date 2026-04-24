/**
 * Exchange Codes (Postgres) integration tests.
 *
 * Exercises createExchangeCode / consumeExchangeCode against a real database
 * (see scripts/test-with-db.sh). Requires DATABASE_URL to point at a running
 * Postgres with migrations applied.
 *
 * Test style mirrors security/__tests__/jti-revocation.integration.test.ts.
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import { db } from '@pagespace/db/db';
import { eq } from '@pagespace/db/operators';
import { authHandoffTokens } from '@pagespace/db/schema/auth-handoff-tokens';
import {
  createExchangeCode,
  consumeExchangeCode,
  type ExchangeCodeData,
} from '../exchange-codes';
import { hashToken } from '../token-utils';

const originalNodeEnv = process.env.NODE_ENV;
let dbAvailable = false;

async function clearTable() {
  await db
    .delete(authHandoffTokens)
    .where(eq(authHandoffTokens.kind, 'exchange-code'));
}

function sampleData(overrides: Partial<ExchangeCodeData> = {}): ExchangeCodeData {
  return {
    sessionToken: 'sess-token',
    csrfToken: 'csrf-token',
    deviceToken: 'dev-token',
    provider: 'google',
    userId: 'user-1',
    createdAt: Date.now(),
    ...overrides,
  };
}

describe('exchange-codes (Postgres-backed auth_handoff_tokens, kind=exchange-code)', () => {
  beforeAll(async () => {
    try {
      await db.select().from(authHandoffTokens).limit(1);
      dbAvailable = true;
    } catch {
      dbAvailable = false;
    }
  });

  beforeEach(async () => {
    process.env.NODE_ENV = originalNodeEnv;
    if (dbAvailable) await clearTable();
  });

  afterAll(async () => {
    process.env.NODE_ENV = originalNodeEnv;
    if (dbAvailable) await clearTable();
  });

  describe('given a well-formed exchange payload', () => {
    it('createExchangeCode should return a base64url code and persist a row keyed by the hashed code', async () => {
      if (!dbAvailable) return;
      const data = sampleData({ userId: 'user-create' });

      const code = await createExchangeCode(data);

      expect(typeof code).toBe('string');
      expect(code).toMatch(/^[A-Za-z0-9_-]+$/);
      expect(code.length).toBeGreaterThanOrEqual(42);

      const rows = await db
        .select()
        .from(authHandoffTokens)
        .where(eq(authHandoffTokens.tokenHash, hashToken(code)));
      expect(rows).toHaveLength(1);
      expect(rows[0].kind).toBe('exchange-code');
      expect(rows[0].expiresAt.getTime()).toBeGreaterThan(Date.now());
      expect(rows[0].payload).toMatchObject({
        userId: 'user-create',
        provider: 'google',
      });
    });

    it('consumeExchangeCode should return the stored payload and delete the row (one-time use)', async () => {
      if (!dbAvailable) return;
      const data = sampleData({ userId: 'user-consume' });
      const code = await createExchangeCode(data);

      const consumed = await consumeExchangeCode(code);
      expect(consumed).toEqual(expect.objectContaining({
        userId: 'user-consume',
        provider: 'google',
        sessionToken: 'sess-token',
        csrfToken: 'csrf-token',
        deviceToken: 'dev-token',
      }));

      const rows = await db
        .select()
        .from(authHandoffTokens)
        .where(eq(authHandoffTokens.tokenHash, hashToken(code)));
      expect(rows).toHaveLength(0);
    });
  });

  describe('given a code that was already consumed', () => {
    it('consumeExchangeCode should return null on the second call', async () => {
      if (!dbAvailable) return;
      const code = await createExchangeCode(sampleData());

      const first = await consumeExchangeCode(code);
      const second = await consumeExchangeCode(code);

      expect(first).not.toBeNull();
      expect(second).toBeNull();
    });
  });

  describe('given an exchange-code row past its expires_at', () => {
    it('consumeExchangeCode should return null', async () => {
      if (!dbAvailable) return;
      const code = 'fake-expired-code';
      await db.insert(authHandoffTokens).values({
        tokenHash: hashToken(code),
        kind: 'exchange-code',
        payload: sampleData({ userId: 'user-expired' }),
        expiresAt: new Date(Date.now() - 60_000),
      });

      const result = await consumeExchangeCode(code);
      expect(result).toBeNull();
    });
  });

  describe('given invalid input', () => {
    it('consumeExchangeCode should return null for the empty string', async () => {
      if (!dbAvailable) return;
      expect(await consumeExchangeCode('')).toBeNull();
    });

    it('consumeExchangeCode should return null for a non-string value', async () => {
      if (!dbAvailable) return;
      expect(
        await consumeExchangeCode(null as unknown as string),
      ).toBeNull();
      expect(
        await consumeExchangeCode(undefined as unknown as string),
      ).toBeNull();
    });
  });

  describe('given a DB failure on createExchangeCode (fail-closed: throws in all envs)', () => {
    it('should throw in production', async () => {
      if (!dbAvailable) return;
      process.env.NODE_ENV = 'production';
      const spy = vi.spyOn(db, 'insert').mockImplementation(() => {
        throw new Error('simulated DB failure');
      });

      try {
        await expect(createExchangeCode(sampleData())).rejects.toThrow();
      } finally {
        spy.mockRestore();
      }
    });

    it('should throw in development', async () => {
      if (!dbAvailable) return;
      process.env.NODE_ENV = 'development';
      const spy = vi.spyOn(db, 'insert').mockImplementation(() => {
        throw new Error('simulated DB failure');
      });

      try {
        await expect(createExchangeCode(sampleData())).rejects.toThrow();
      } finally {
        spy.mockRestore();
      }
    });
  });

  describe('given a DB failure on consumeExchangeCode (silent miss — never throws)', () => {
    it('should return null in production', async () => {
      if (!dbAvailable) return;
      process.env.NODE_ENV = 'production';
      const spy = vi.spyOn(db, 'execute').mockImplementation(() => {
        throw new Error('simulated DB failure');
      });

      try {
        const result = await consumeExchangeCode('any-code');
        expect(result).toBeNull();
      } finally {
        spy.mockRestore();
      }
    });

    it('should return null in development', async () => {
      if (!dbAvailable) return;
      process.env.NODE_ENV = 'development';
      const spy = vi.spyOn(db, 'execute').mockImplementation(() => {
        throw new Error('simulated DB failure');
      });

      try {
        const result = await consumeExchangeCode('any-code');
        expect(result).toBeNull();
      } finally {
        spy.mockRestore();
      }
    });
  });
});
