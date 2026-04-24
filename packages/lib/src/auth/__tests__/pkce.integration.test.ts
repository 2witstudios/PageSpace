/**
 * PKCE (Postgres) integration tests.
 *
 * Exercises generatePKCE / consumePKCEVerifier against a real database
 * (see scripts/test-with-db.sh). Requires DATABASE_URL to point at a
 * running Postgres with migrations applied.
 *
 * Test style mirrors security/__tests__/jti-revocation.integration.test.ts:
 * describe/it names encode given/should; isolation is via per-test cleanup;
 * no shared mutable fixtures.
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import { createHash } from 'crypto';
import { db } from '@pagespace/db/db';
import { eq } from '@pagespace/db/operators';
import { authHandoffTokens } from '@pagespace/db/schema/auth-handoff-tokens';
import { generatePKCE, consumePKCEVerifier } from '../pkce';

const originalNodeEnv = process.env.NODE_ENV;
let dbAvailable = false;

async function clearTable() {
  await db.delete(authHandoffTokens).where(eq(authHandoffTokens.kind, 'pkce'));
}

function stateHashFor(state: string): string {
  return createHash('sha256').update(state).digest('hex');
}

describe('PKCE (Postgres-backed auth_handoff_tokens, kind=pkce)', () => {
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

  describe('given a fresh OAuth state', () => {
    it('generatePKCE should return the S256 challenge and persist the verifier row', async () => {
      if (!dbAvailable) return;
      const state = 'state-fresh-pkce';

      const result = await generatePKCE(state);

      expect(result).not.toBeNull();
      expect(result?.codeChallengeMethod).toBe('S256');
      expect(result?.codeChallenge).toMatch(/^[A-Za-z0-9_-]+$/);

      const rows = await db
        .select()
        .from(authHandoffTokens)
        .where(eq(authHandoffTokens.tokenHash, stateHashFor(state)));
      expect(rows).toHaveLength(1);
      expect(rows[0].kind).toBe('pkce');
      expect(rows[0].expiresAt.getTime()).toBeGreaterThan(Date.now());
    });

    it('consumePKCEVerifier should return the stored verifier and remove the row (one-time use)', async () => {
      if (!dbAvailable) return;
      const state = 'state-consume-pkce';
      await generatePKCE(state);

      const verifier = await consumePKCEVerifier(state);

      expect(typeof verifier).toBe('string');
      expect((verifier ?? '').length).toBeGreaterThan(0);

      const rows = await db
        .select()
        .from(authHandoffTokens)
        .where(eq(authHandoffTokens.tokenHash, stateHashFor(state)));
      expect(rows).toHaveLength(0);
    });
  });

  describe('given a state that was never minted', () => {
    it('consumePKCEVerifier should return null', async () => {
      if (!dbAvailable) return;
      const result = await consumePKCEVerifier('state-never-issued');
      expect(result).toBeNull();
    });
  });

  describe('given a PKCE row that was already consumed', () => {
    it('consumePKCEVerifier should return null on the second call', async () => {
      if (!dbAvailable) return;
      const state = 'state-double-consume';
      await generatePKCE(state);

      const first = await consumePKCEVerifier(state);
      const second = await consumePKCEVerifier(state);

      expect(first).not.toBeNull();
      expect(second).toBeNull();
    });
  });

  describe('given a PKCE row past its expires_at', () => {
    it('consumePKCEVerifier should return null', async () => {
      if (!dbAvailable) return;
      const state = 'state-expired-pkce';
      await db.insert(authHandoffTokens).values({
        tokenHash: stateHashFor(state),
        kind: 'pkce',
        payload: { verifier: 'stale-verifier' },
        expiresAt: new Date(Date.now() - 60_000),
      });

      const result = await consumePKCEVerifier(state);
      expect(result).toBeNull();
    });
  });

  describe('given two generatePKCE calls for the same state', () => {
    it('should collapse onto a single row (upsert) so a re-mint replaces the prior verifier', async () => {
      if (!dbAvailable) return;
      const state = 'state-single-row';
      const first = await generatePKCE(state);
      const second = await generatePKCE(state);

      expect(first).not.toBeNull();
      expect(second).not.toBeNull();

      const rows = await db
        .select()
        .from(authHandoffTokens)
        .where(eq(authHandoffTokens.tokenHash, stateHashFor(state)));
      expect(rows).toHaveLength(1);
    });
  });

  describe('given a DB failure (PKCE never fail-closes — it degrades gracefully)', () => {
    it('generatePKCE should return null rather than throw when the insert fails', async () => {
      if (!dbAvailable) return;
      const spy = vi.spyOn(db, 'insert').mockImplementation(() => {
        throw new Error('simulated DB failure');
      });

      try {
        const result = await generatePKCE('state-db-down');
        expect(result).toBeNull();
      } finally {
        spy.mockRestore();
      }
    });

    it('consumePKCEVerifier should return null rather than throw when the delete fails', async () => {
      if (!dbAvailable) return;
      const spy = vi.spyOn(db, 'execute').mockImplementation(() => {
        throw new Error('simulated DB failure');
      });

      try {
        const result = await consumePKCEVerifier('state-any');
        expect(result).toBeNull();
      } finally {
        spy.mockRestore();
      }
    });

    it('generatePKCE should still return null in production (mirrors the pre-migration graceful-degradation semantic)', async () => {
      if (!dbAvailable) return;
      process.env.NODE_ENV = 'production';
      const spy = vi.spyOn(db, 'insert').mockImplementation(() => {
        throw new Error('simulated DB failure');
      });

      try {
        const result = await generatePKCE('state-prod');
        expect(result).toBeNull();
      } finally {
        spy.mockRestore();
      }
    });
  });
});
