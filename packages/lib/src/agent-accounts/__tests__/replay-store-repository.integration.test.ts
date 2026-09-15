/**
 * ADR 0004 §2.4 + §8.11 — the replay ledger against a REAL Postgres.
 *
 * Written RED at G1b before `replay-store-repository.ts` and the
 * `agent_account_grant_nonces` table existed. The database is the single-use
 * ledger (as `dev_preview_grants` already is): consumption is one conditional
 * insert that succeeds exactly once across every replica and survives a
 * process restart. Two repository instances over the same database stand in
 * for two broker replicas; a fresh instance stands in for a restarted one.
 *
 * FAILS LOUDLY when no DB is reachable (`requireDb`); local runs without a
 * database opt out explicitly with ALLOW_SKIP_DB_TESTS=1.
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { db } from '@pagespace/db/db';
import { sql } from '@pagespace/db/operators';
import { agentAccountGrantNonces } from '@pagespace/db/schema/agent-account-grant-nonces';
import { requireDb } from '@pagespace/db/test/require-db';
import { createReplayStoreRepository } from '../replay-store-repository';
import type { Nonce, GrantId } from '../grant';

const PREFIX = 'itest-replay-';
let dbAvailable = false;
let seq = 0;

const nonce = (): Nonce => {
  seq += 1;
  return `${PREFIX}${Date.now()}-${seq}` as Nonce;
};
const GRANT = 'grant_itest_1' as GrantId;
const NOW = Date.now();
const EXP = NOW + 60_000;

async function clearRows() {
  await db.delete(agentAccountGrantNonces).where(sql`${agentAccountGrantNonces.nonce} LIKE ${`${PREFIX}%`}`);
}

beforeAll(async () => {
  try {
    await db.execute(sql`SELECT 1`);
    dbAvailable = true;
  } catch (error) {
    requireDb('replay-store-repository.integration.test.ts', error);
    dbAvailable = false;
  }
});

beforeEach(async () => {
  if (dbAvailable) await clearRows();
});

afterAll(async () => {
  if (dbAvailable) await clearRows();
});

describe('replay store — atomic, shared across replicas, survives restart (ADR 0004 §2.4)', () => {
  it('given an unseen nonce, should read fresh; given it consumed once, should read consumed', async () => {
    if (!dbAvailable) return;
    const replica = createReplayStoreRepository({ db });
    const n = nonce();
    const before = await replica.lookup({ nonce: n });
    const consumed = await replica.consume({ nonce: n, grantId: GRANT, expiresAt: EXP, now: NOW });
    const after = await replica.lookup({ nonce: n });
    expect({ before, consumed, after }).toEqual({
      before: { ok: true, recorded: null },
      consumed: 'consumed',
      after: { ok: true, recorded: { grantId: GRANT, expiresAt: EXP, consumedAt: NOW } },
    });
  });

  it('given the same nonce presented to two replicas concurrently, should consume it exactly once (one consumed, one replayed)', async () => {
    if (!dbAvailable) return;
    const replicaA = createReplayStoreRepository({ db });
    const replicaB = createReplayStoreRepository({ db });
    const n = nonce();
    const outcomes = await Promise.all([
      replicaA.consume({ nonce: n, grantId: GRANT, expiresAt: EXP, now: NOW }),
      replicaB.consume({ nonce: n, grantId: GRANT, expiresAt: EXP, now: NOW }),
    ]);
    const actual = [...outcomes].sort();
    expect(actual).toEqual(['consumed', 'replayed']);
  });

  it('given a nonce consumed, a process restart (fresh repository instance), and the same nonce presented again, should return replayed', async () => {
    if (!dbAvailable) return;
    const n = nonce();
    const first = await createReplayStoreRepository({ db }).consume({ nonce: n, grantId: GRANT, expiresAt: EXP, now: NOW });
    const afterRestart = createReplayStoreRepository({ db });
    const second = await afterRestart.consume({ nonce: n, grantId: GRANT, expiresAt: EXP, now: NOW + 5_000 });
    const lookup = await afterRestart.lookup({ nonce: n });
    expect({ first, second, lookup }).toEqual({
      first: 'consumed',
      second: 'replayed',
      lookup: { ok: true, recorded: { grantId: GRANT, expiresAt: EXP, consumedAt: NOW } },
    });
  });

  it('given a replayed presentation, should leave the original consumption row untouched (no overwrite of grantId or consumedAt)', async () => {
    if (!dbAvailable) return;
    const replica = createReplayStoreRepository({ db });
    const n = nonce();
    await replica.consume({ nonce: n, grantId: GRANT, expiresAt: EXP, now: NOW });
    await replica.consume({ nonce: n, grantId: 'grant_itest_attacker' as GrantId, expiresAt: EXP + 999_999, now: NOW + 1 });
    const actual = await replica.lookup({ nonce: n });
    expect(actual).toEqual({ ok: true, recorded: { grantId: GRANT, expiresAt: EXP, consumedAt: NOW } });
  });

  it('given rows past their expiry, should sweep only those and report the count', async () => {
    if (!dbAvailable) return;
    const replica = createReplayStoreRepository({ db });
    const expired = nonce();
    const live = nonce();
    await replica.consume({ nonce: expired, grantId: GRANT, expiresAt: NOW - 1, now: NOW - 60_000 });
    await replica.consume({ nonce: live, grantId: GRANT, expiresAt: EXP, now: NOW });
    const swept = await replica.sweepExpired({ now: NOW });
    const expiredAfter = await replica.lookup({ nonce: expired });
    const liveAfter = await replica.lookup({ nonce: live });
    expect({ swept, expiredGone: expiredAfter, liveKept: liveAfter.ok && liveAfter.recorded !== null }).toEqual({
      swept: 1,
      expiredGone: { ok: true, recorded: null },
      liveKept: true,
    });
  });

  it('given the store unreachable, should report lookup failed and consume unavailable — never fresh, never consumed', async () => {
    if (!dbAvailable) return;
    const deadPool = new Pool({ connectionString: 'postgresql://user:password@127.0.0.1:1/pagespace_dead', connectionTimeoutMillis: 500 });
    const dead = createReplayStoreRepository({ db: drizzle(deadPool) });
    const n = nonce();
    const lookup = await dead.lookup({ nonce: n });
    const consume = await dead.consume({ nonce: n, grantId: GRANT, expiresAt: EXP, now: NOW });
    await deadPool.end();
    expect({ lookup, consume }).toEqual({ lookup: { ok: false }, consume: 'unavailable' });
  });
});
