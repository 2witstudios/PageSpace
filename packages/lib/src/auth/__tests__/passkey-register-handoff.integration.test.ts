/**
 * Passkey Register Handoff (Postgres) integration tests.
 *
 * Exercises createPasskeyRegisterHandoff / peekPasskeyRegisterHandoff /
 * consumePasskeyRegisterHandoff / markPasskeyRegisterOptionsIssued
 * against a real database (see scripts/test-with-db.sh). Requires
 * DATABASE_URL to point at a running Postgres with migrations applied.
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import { db, authHandoffTokens, inArray, eq } from '@pagespace/db';
import {
  createPasskeyRegisterHandoff,
  peekPasskeyRegisterHandoff,
  consumePasskeyRegisterHandoff,
  markPasskeyRegisterOptionsIssued,
} from '../passkey-register-handoff';
import { hashToken } from '../token-utils';

const originalNodeEnv = process.env.NODE_ENV;
let dbAvailable = false;

async function clearTable() {
  await db
    .delete(authHandoffTokens)
    .where(
      inArray(authHandoffTokens.kind, [
        'passkey-register-handoff',
        'passkey-options-marker',
      ]),
    );
}

describe('passkey-register-handoff (Postgres-backed auth_handoff_tokens)', () => {
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

  describe('given a new handoff mint', () => {
    it('createPasskeyRegisterHandoff should return a base64url token and store a row with kind=passkey-register-handoff', async () => {
      if (!dbAvailable) return;

      const token = await createPasskeyRegisterHandoff({ userId: 'user-1' });

      expect(typeof token).toBe('string');
      expect(token).toMatch(/^[A-Za-z0-9_-]+$/);
      expect(token.length).toBeGreaterThanOrEqual(42);

      const rows = await db
        .select()
        .from(authHandoffTokens)
        .where(eq(authHandoffTokens.tokenHash, hashToken(token)));
      expect(rows).toHaveLength(1);
      expect(rows[0].kind).toBe('passkey-register-handoff');
      expect(rows[0].payload).toMatchObject({ userId: 'user-1' });
      expect(rows[0].expiresAt.getTime()).toBeGreaterThan(Date.now());
    });

    it('should generate unique tokens across calls with the same userId', async () => {
      if (!dbAvailable) return;
      const a = await createPasskeyRegisterHandoff({ userId: 'user-1' });
      const b = await createPasskeyRegisterHandoff({ userId: 'user-1' });
      expect(a).not.toBe(b);
    });
  });

  describe('given a minted handoff token', () => {
    it('peekPasskeyRegisterHandoff should return the stored payload WITHOUT deleting the row', async () => {
      if (!dbAvailable) return;
      const token = await createPasskeyRegisterHandoff({ userId: 'user-42' });

      const peeked = await peekPasskeyRegisterHandoff(token);
      expect(peeked).toMatchObject({ userId: 'user-42' });

      const rows = await db
        .select()
        .from(authHandoffTokens)
        .where(eq(authHandoffTokens.tokenHash, hashToken(token)));
      expect(rows).toHaveLength(1);
    });

    it('consumePasskeyRegisterHandoff should return the payload and delete the row (atomic DELETE … RETURNING)', async () => {
      if (!dbAvailable) return;
      const token = await createPasskeyRegisterHandoff({ userId: 'user-7' });

      const consumed = await consumePasskeyRegisterHandoff(token);
      expect(consumed).toMatchObject({ userId: 'user-7' });

      const rows = await db
        .select()
        .from(authHandoffTokens)
        .where(eq(authHandoffTokens.tokenHash, hashToken(token)));
      expect(rows).toHaveLength(0);
    });

    it('should be one-time use: a second consume returns null', async () => {
      if (!dbAvailable) return;
      const token = await createPasskeyRegisterHandoff({ userId: 'user-9' });

      const first = await consumePasskeyRegisterHandoff(token);
      const second = await consumePasskeyRegisterHandoff(token);
      expect(first).toMatchObject({ userId: 'user-9' });
      expect(second).toBeNull();
    });
  });

  describe('given a handoff-token row past its expires_at', () => {
    it('peekPasskeyRegisterHandoff should return null', async () => {
      if (!dbAvailable) return;
      const token = 'expired-token-peek';
      await db.insert(authHandoffTokens).values({
        tokenHash: hashToken(token),
        kind: 'passkey-register-handoff',
        payload: { userId: 'user-expired', createdAt: Date.now() },
        expiresAt: new Date(Date.now() - 60_000),
      });

      const result = await peekPasskeyRegisterHandoff(token);
      expect(result).toBeNull();
    });

    it('consumePasskeyRegisterHandoff should return null', async () => {
      if (!dbAvailable) return;
      const token = 'expired-token-consume';
      await db.insert(authHandoffTokens).values({
        tokenHash: hashToken(token),
        kind: 'passkey-register-handoff',
        payload: { userId: 'user-expired', createdAt: Date.now() },
        expiresAt: new Date(Date.now() - 60_000),
      });

      const result = await consumePasskeyRegisterHandoff(token);
      expect(result).toBeNull();
    });
  });

  describe('given invalid input', () => {
    it('peekPasskeyRegisterHandoff should return null for empty/non-string', async () => {
      if (!dbAvailable) return;
      expect(await peekPasskeyRegisterHandoff('')).toBeNull();
      expect(
        await peekPasskeyRegisterHandoff(null as unknown as string),
      ).toBeNull();
    });

    it('consumePasskeyRegisterHandoff should return null for empty/non-string', async () => {
      if (!dbAvailable) return;
      expect(await consumePasskeyRegisterHandoff('')).toBeNull();
      expect(
        await consumePasskeyRegisterHandoff(null as unknown as string),
      ).toBeNull();
    });

    it('markPasskeyRegisterOptionsIssued should return false for empty/non-string', async () => {
      if (!dbAvailable) return;
      expect(await markPasskeyRegisterOptionsIssued('')).toBe(false);
      expect(
        await markPasskeyRegisterOptionsIssued(null as unknown as string),
      ).toBe(false);
    });
  });

  describe('given the options marker (one-options-per-handoff guard)', () => {
    it('first call should set the marker and return true', async () => {
      if (!dbAvailable) return;
      const token = 'marker-token-1';
      const result = await markPasskeyRegisterOptionsIssued(token);
      expect(result).toBe(true);
    });

    it('second call with the same token should return false (marker already set)', async () => {
      if (!dbAvailable) return;
      const token = 'marker-token-2';
      expect(await markPasskeyRegisterOptionsIssued(token)).toBe(true);
      expect(await markPasskeyRegisterOptionsIssued(token)).toBe(false);
    });

    it('different tokens should both succeed independently', async () => {
      if (!dbAvailable) return;
      expect(await markPasskeyRegisterOptionsIssued('marker-token-a')).toBe(true);
      expect(await markPasskeyRegisterOptionsIssued('marker-token-b')).toBe(true);
    });

    it('markers use kind=passkey-options-marker and hashed token as key', async () => {
      if (!dbAvailable) return;
      const token = 'marker-token-shape';
      await markPasskeyRegisterOptionsIssued(token);

      const rows = await db
        .select()
        .from(authHandoffTokens)
        .where(eq(authHandoffTokens.tokenHash, hashToken(token)));
      expect(rows).toHaveLength(1);
      expect(rows[0].kind).toBe('passkey-options-marker');
    });
  });

  describe('given a token minted via createPasskeyRegisterHandoff (real-flow composition)', () => {
    it('the first markPasskeyRegisterOptionsIssued call must return true even though the handoff row shares the same tokenHash', async () => {
      if (!dbAvailable) return;
      const token = await createPasskeyRegisterHandoff({
        userId: 'user-mark-after-mint',
      });

      const result = await markPasskeyRegisterOptionsIssued(token);

      expect(result).toBe(true);
    });

    it('a second mark with the same minted token returns false (replay detected) while the handoff row survives for the verify step', async () => {
      if (!dbAvailable) return;
      const token = await createPasskeyRegisterHandoff({
        userId: 'user-mark-replay',
      });

      expect(await markPasskeyRegisterOptionsIssued(token)).toBe(true);
      expect(await markPasskeyRegisterOptionsIssued(token)).toBe(false);

      const peeked = await peekPasskeyRegisterHandoff(token);
      expect(peeked).toMatchObject({ userId: 'user-mark-replay' });
    });
  });

  describe('given a DB failure', () => {
    it('createPasskeyRegisterHandoff should throw in production', async () => {
      if (!dbAvailable) return;
      process.env.NODE_ENV = 'production';
      const spy = vi.spyOn(db, 'insert').mockImplementation(() => {
        throw new Error('simulated DB failure');
      });

      try {
        await expect(
          createPasskeyRegisterHandoff({ userId: 'user' }),
        ).rejects.toThrow();
      } finally {
        spy.mockRestore();
      }
    });

    it('createPasskeyRegisterHandoff should throw in development (fail-fast)', async () => {
      if (!dbAvailable) return;
      process.env.NODE_ENV = 'development';
      const spy = vi.spyOn(db, 'insert').mockImplementation(() => {
        throw new Error('simulated DB failure');
      });

      try {
        await expect(
          createPasskeyRegisterHandoff({ userId: 'user' }),
        ).rejects.toThrow();
      } finally {
        spy.mockRestore();
      }
    });

    it('peekPasskeyRegisterHandoff should return null in production (no throw)', async () => {
      if (!dbAvailable) return;
      process.env.NODE_ENV = 'production';
      const spy = vi.spyOn(db, 'select').mockImplementation(() => {
        throw new Error('simulated DB failure');
      });

      try {
        const result = await peekPasskeyRegisterHandoff('any');
        expect(result).toBeNull();
      } finally {
        spy.mockRestore();
      }
    });

    it('consumePasskeyRegisterHandoff should return null in production (no throw)', async () => {
      if (!dbAvailable) return;
      process.env.NODE_ENV = 'production';
      const spy = vi.spyOn(db, 'execute').mockImplementation(() => {
        throw new Error('simulated DB failure');
      });

      try {
        const result = await consumePasskeyRegisterHandoff('any');
        expect(result).toBeNull();
      } finally {
        spy.mockRestore();
      }
    });

    it('markPasskeyRegisterOptionsIssued should return false in production (fail-closed)', async () => {
      if (!dbAvailable) return;
      process.env.NODE_ENV = 'production';
      const spy = vi.spyOn(db, 'insert').mockImplementation(() => {
        throw new Error('simulated DB failure');
      });

      try {
        const result = await markPasskeyRegisterOptionsIssued('token');
        expect(result).toBe(false);
      } finally {
        spy.mockRestore();
      }
    });

    it('markPasskeyRegisterOptionsIssued should return false in development (fail-closed)', async () => {
      if (!dbAvailable) return;
      process.env.NODE_ENV = 'development';
      const spy = vi.spyOn(db, 'insert').mockImplementation(() => {
        throw new Error('simulated DB failure');
      });

      try {
        const result = await markPasskeyRegisterOptionsIssued('token');
        expect(result).toBe(false);
      } finally {
        spy.mockRestore();
      }
    });
  });
});
