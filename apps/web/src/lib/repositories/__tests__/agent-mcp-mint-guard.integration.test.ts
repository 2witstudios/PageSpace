/**
 * `createAgentMcpTokenGuarded` against a REAL Postgres — the two races only a
 * database can show (Agent Signup Phase 2 follow-up; ADR 0007 Decisions 6, 14):
 *
 *  - a key mint whose caller was authenticated BEFORE a concurrent revoke or
 *    rotation-with-revoke must not commit a live key AFTER it; and
 *  - concurrent mints must not push an agent past its live-key cap.
 *
 * Both are closed by serialising on the agent's `users` row (the row revocation
 * updates) and re-checking tokenVersion and the live-key count under that lock.
 *
 * Requires DATABASE_URL → a migrated Postgres. FAILS LOUDLY when none is
 * reachable (requireDb); local runs without one opt out with ALLOW_SKIP_DB_TESTS=1.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createId } from '@paralleldrive/cuid2';
import { db } from '@pagespace/db/db';
import { and, eq, inArray, isNull, sql } from '@pagespace/db/operators';
import { users, mcpTokens } from '@pagespace/db/schema/auth';
import { factories } from '@pagespace/db/test/factories';
import { requireDb } from '@pagespace/db/test/require-db';
import { sessionRepository } from '../session-repository';

let dbAvailable = false;
const createdUserIds: string[] = [];

beforeAll(async () => {
  try {
    await db.select({ id: users.id }).from(users).limit(1);
    dbAvailable = true;
  } catch (error) {
    requireDb('agent-mcp-mint-guard.integration.test.ts', error);
    dbAvailable = false;
  }
});

afterAll(async () => {
  if (!dbAvailable || createdUserIds.length === 0) return;
  await db.delete(users).where(inArray(users.id, createdUserIds));
});

async function newUser(): Promise<{ id: string; tokenVersion: number }> {
  const user = await factories.createUser({ accountType: 'agent' });
  createdUserIds.push(user.id);
  return { id: user.id, tokenVersion: user.tokenVersion };
}

const keyData = (userId: string) => ({
  userId,
  tokenHash: `hash_${createId()}`,
  tokenPrefix: 'mcp_test',
  name: 'agent key',
  isScoped: false,
  drives: [],
});

async function liveKeyCount(userId: string): Promise<number> {
  const rows = await db.select({ id: mcpTokens.id }).from(mcpTokens)
    .where(and(eq(mcpTokens.userId, userId), isNull(mcpTokens.revokedAt)));
  return rows.length;
}

describe('sessionRepository.createAgentMcpTokenGuarded — real Postgres', () => {
  it('given the caller authenticated under the current tokenVersion, should mint', async () => {
    if (!dbAvailable) return;
    const user = await newUser();
    const result = await sessionRepository.createAgentMcpTokenGuarded(keyData(user.id), { expectedTokenVersion: user.tokenVersion, maxLiveKeys: 20 });
    expect(result.ok).toBe(true);
    expect(await liveKeyCount(user.id)).toBe(1);
  });

  it('given tokenVersion moved on since the caller authenticated (revoked/rotated), should refuse and mint nothing', async () => {
    if (!dbAvailable) return;
    const user = await newUser();
    await db.update(users).set({ tokenVersion: sql`${users.tokenVersion} + 1` }).where(eq(users.id, user.id));
    const result = await sessionRepository.createAgentMcpTokenGuarded(keyData(user.id), { expectedTokenVersion: user.tokenVersion, maxLiveKeys: 20 });
    expect(result).toEqual({ ok: false, reason: 'credentials_revoked' });
    expect(await liveKeyCount(user.id)).toBe(0);
  });

  it('given a revocation IN FLIGHT when the mint arrives, should wait for it and then refuse — no key survives the revoke', async () => {
    if (!dbAvailable) return;
    const user = await newUser();
    let mint: Promise<unknown> | undefined;
    await db.transaction(async (tx) => {
      // What killAgentCredentials does: bump tokenVersion, revoke live keys.
      await tx.update(users).set({ tokenVersion: sql`${users.tokenVersion} + 1` }).where(eq(users.id, user.id));
      await tx.update(mcpTokens).set({ revokedAt: new Date() }).where(and(eq(mcpTokens.userId, user.id), isNull(mcpTokens.revokedAt)));
      // A mint authenticated under the OLD version starts now, before the revoke commits.
      mint = sessionRepository.createAgentMcpTokenGuarded(keyData(user.id), { expectedTokenVersion: user.tokenVersion, maxLiveKeys: 20 });
      await new Promise((resolve) => setTimeout(resolve, 300));
    });
    expect(await mint).toEqual({ ok: false, reason: 'credentials_revoked' });
    expect(await liveKeyCount(user.id)).toBe(0);
  });

  it('given many concurrent mints at 19 live keys, should admit exactly one (the cap is enforced atomically)', async () => {
    if (!dbAvailable) return;
    const user = await newUser();
    for (let i = 0; i < 19; i += 1) await sessionRepository.createMcpTokenWithDriveScopes(keyData(user.id));
    const results = await Promise.all(Array.from({ length: 6 }, () =>
      sessionRepository.createAgentMcpTokenGuarded(keyData(user.id), { expectedTokenVersion: user.tokenVersion, maxLiveKeys: 20 })));
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.filter((r) => !r.ok).every((r) => !r.ok && r.reason === 'key_limit_reached')).toBe(true);
    expect(await liveKeyCount(user.id)).toBe(20);
  });
});
