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
import { agentIdentities } from '@pagespace/db/schema/agent-identities';
import { rotateAgentSecret } from '@pagespace/lib/services/agent-identities';
import { hashToken } from '@pagespace/lib/auth/token-utils';
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

/**
 * Resolve once a backend in this database is blocked on a lock while running a
 * statement against "users" — proof the two sides really overlap (rather than
 * one simply finishing before the other starts). Scoped to "users" so another
 * suite's lock wait on a shared CI database cannot satisfy it.
 */
async function untilABackendWaitsOnALock(): Promise<void> {
  for (let i = 0; i < 100; i += 1) {
    const rows = await db.execute(sql`
      select 1 from pg_stat_activity
      where datname = current_database() and wait_event_type = 'Lock' and query ilike '%"users"%'
      limit 1`);
    if (rows.rows.length > 0) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('no backend ever waited on a lock — the race was not exercised');
}

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
      await untilABackendWaitsOnALock();
    });
    expect(await mint).toEqual({ ok: false, reason: 'credentials_revoked' });
    expect(await liveKeyCount(user.id)).toBe(0);
  });

  it('given a mint HOLDING the lock when a rotate-with-revoke arrives, should make the revoke wait and then revoke the new key', async () => {
    if (!dbAvailable) return;
    const user = await newUser();
    await db.insert(agentIdentities).values({ userId: user.id, secretHash: hashToken(`ps_agent_${createId()}`), secretPrefix: 'ps_agent_tes' });
    let insertedKeyId = '';
    let rotation: Promise<unknown> | undefined;
    await db.transaction(async (tx) => {
      // The guarded mint's own order: lock the users row, then insert.
      await tx.select({ id: users.id }).from(users).where(eq(users.id, user.id)).for('no key update');
      const [key] = await tx.insert(mcpTokens).values(keyData(user.id)).returning({ id: mcpTokens.id });
      insertedKeyId = key.id;
      rotation = rotateAgentSecret({ userId: user.id, revokeTokens: true });
      await untilABackendWaitsOnALock();
    });
    await rotation;
    const [row] = await db.select({ revokedAt: mcpTokens.revokedAt }).from(mcpTokens).where(eq(mcpTokens.id, insertedKeyId));
    expect(row?.revokedAt).toBeInstanceOf(Date);
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
