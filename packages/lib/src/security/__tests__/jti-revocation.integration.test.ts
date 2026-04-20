/**
 * JTI Revocation Integration Tests
 *
 * Exercises the Postgres-backed recordJTI / isJTIRevoked / revokeJTI
 * against a real database (see scripts/test-with-db.sh).
 *
 * Requires DATABASE_URL to point at a running Postgres with migrations applied.
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import { db, revokedServiceTokens, eq } from '@pagespace/db';
import {
  recordJTI,
  isJTIRevoked,
  revokeJTI,
  sweepExpiredRevokedJTIs,
} from '../security-redis';

const originalNodeEnv = process.env.NODE_ENV;
let dbAvailable = false;

async function clearTable() {
  await db.delete(revokedServiceTokens);
}

describe('JTI revocation (Postgres)', () => {
  beforeAll(async () => {
    try {
      await db.select().from(revokedServiceTokens).limit(1);
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

  it('recordJTI followed by isJTIRevoked returns false', async () => {
    if (!dbAvailable) return;
    const jti = 'test-jti-fresh';
    await recordJTI(jti, 'user-1', 300);
    const revoked = await isJTIRevoked(jti);
    expect(revoked).toBe(false);
  });

  it('isJTIRevoked returns true (fail-closed) for unknown JTI', async () => {
    if (!dbAvailable) return;
    const revoked = await isJTIRevoked('never-recorded-jti');
    expect(revoked).toBe(true);
  });

  it('revokeJTI marks a recorded JTI as revoked', async () => {
    if (!dbAvailable) return;
    const jti = 'test-jti-revoke';
    await recordJTI(jti, 'user-2', 300);

    const result = await revokeJTI(jti, 'suspicious activity');
    expect(result).toBe(true);

    const revoked = await isJTIRevoked(jti);
    expect(revoked).toBe(true);

    const [row] = await db
      .select()
      .from(revokedServiceTokens)
      .where(eq(revokedServiceTokens.jti, jti));
    expect(row.revokedAt).not.toBeNull();
  });

  it('double-revoke is idempotent', async () => {
    if (!dbAvailable) return;
    const jti = 'test-jti-double';
    await recordJTI(jti, 'user-3', 300);

    const first = await revokeJTI(jti, 'first');
    const second = await revokeJTI(jti, 'second');

    expect(first).toBe(true);
    expect(second).toBe(true);
    expect(await isJTIRevoked(jti)).toBe(true);
  });

  it('revokeJTI returns false for expired JTI', async () => {
    if (!dbAvailable) return;
    const jti = 'test-jti-expired';
    await db.insert(revokedServiceTokens).values({
      jti,
      expiresAt: new Date(Date.now() - 60_000),
    });

    const result = await revokeJTI(jti, 'too-late');
    expect(result).toBe(false);
  });

  it('isJTIRevoked returns true for JTI past its expires_at (fail-closed)', async () => {
    if (!dbAvailable) return;
    const jti = 'test-jti-past-exp';
    await db.insert(revokedServiceTokens).values({
      jti,
      expiresAt: new Date(Date.now() - 60_000),
    });
    expect(await isJTIRevoked(jti)).toBe(true);
  });

  it('sweepExpiredRevokedJTIs removes rows past their expires_at', async () => {
    if (!dbAvailable) return;
    await db.insert(revokedServiceTokens).values([
      { jti: 'expired-1', expiresAt: new Date(Date.now() - 1_000) },
      { jti: 'expired-2', expiresAt: new Date(Date.now() - 60_000) },
      { jti: 'live-1', expiresAt: new Date(Date.now() + 300_000) },
    ]);

    const swept = await sweepExpiredRevokedJTIs();
    expect(swept).toBeGreaterThanOrEqual(2);

    const remaining = await db.select().from(revokedServiceTokens);
    const jtiSet = new Set(remaining.map((r) => r.jti));
    expect(jtiSet.has('live-1')).toBe(true);
    expect(jtiSet.has('expired-1')).toBe(false);
    expect(jtiSet.has('expired-2')).toBe(false);
  });

  describe('fail-closed in production', () => {
    beforeEach(() => {
      process.env.NODE_ENV = 'production';
    });

    it('recordJTI throws when DB query fails in production', async () => {
      if (!dbAvailable) return;
      const spy = vi.spyOn(db, 'insert').mockImplementation(() => {
        throw new Error('simulated DB failure');
      });

      await expect(recordJTI('prod-jti', 'user', 60)).rejects.toThrow();
      spy.mockRestore();
    });

    it('isJTIRevoked throws when DB query fails in production', async () => {
      if (!dbAvailable) return;
      const spy = vi.spyOn(db, 'select').mockImplementation(() => {
        throw new Error('simulated DB failure');
      });

      await expect(isJTIRevoked('prod-jti')).rejects.toThrow();
      spy.mockRestore();
    });

    it('revokeJTI throws when DB query fails in production', async () => {
      if (!dbAvailable) return;
      const spy = vi.spyOn(db, 'select').mockImplementation(() => {
        throw new Error('simulated DB failure');
      });

      await expect(revokeJTI('prod-jti', 'reason')).rejects.toThrow();
      spy.mockRestore();
    });
  });
});
