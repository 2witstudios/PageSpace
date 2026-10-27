/**
 * Threat model A5, B-13 (ASI07) — the DB-backed rows of the
 * replay-across-replicas adversarial case, against a REAL Postgres.
 *
 * Same harness as `replay-across-replicas.test.ts`; split by file only
 * because DB-backed suites are `*.integration.test.ts` and excluded from the
 * unit run (packages/lib/vitest.config.ts). Two repository instances over
 * one database are two broker replicas; a fresh instance is a restart.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { db } from '@pagespace/db/db';
import { sql } from '@pagespace/db/operators';
import { agentAccountGrantNonces } from '@pagespace/db/schema/agent-account-grant-nonces';
import { requireDb } from '@pagespace/db/test/require-db';
import { createReplayStoreRepository } from '../../replay-store-repository';
import { decideReplay } from '../../decide-replay';
import type { GrantId, Nonce } from '../../grant';

const PREFIX = 'itest-adv-replay-';
let dbAvailable = false;
let seq = 0;
const nonce = (): Nonce => {
  seq += 1;
  return `${PREFIX}${Date.now()}-${seq}` as Nonce;
};
const GRANT = 'grant_adv_1' as GrantId;
const NOW = Date.now();
const EXP = NOW + 60_000;

async function clearRows() {
  await db.delete(agentAccountGrantNonces).where(sql`${agentAccountGrantNonces.nonce} LIKE ${`${PREFIX}%`}`);
}

beforeAll(async () => {
  try {
    await db.execute(sql`SELECT 1`);
    dbAvailable = true;
    await clearRows();
  } catch (error) {
    requireDb('replay-across-replicas.integration.test.ts', error);
    dbAvailable = false;
  }
});

afterAll(async () => {
  if (dbAvailable) await clearRows();
});

describe('adversarial: replay-across-replicas (DB rows)', () => {
  it('given one grant presented to two verifier replicas concurrently, should consume the nonce exactly once (one ok, one replayed)', async () => {
    if (!dbAvailable) return;
    const n = nonce();
    const replicas = [createReplayStoreRepository({ db }), createReplayStoreRepository({ db })];
    const outcomes = await Promise.all(replicas.map((replica) => replica.consume({ nonce: n, grantId: GRANT, expiresAt: EXP, now: NOW })));
    const actual = { consumed: outcomes.filter((o) => o === 'consumed').length, replayed: outcomes.filter((o) => o === 'replayed').length };
    expect(actual).toEqual({ consumed: 1, replayed: 1 });
  });

  it('given eight replicas racing the same nonce, should still consume it exactly once', async () => {
    if (!dbAvailable) return;
    const n = nonce();
    const replicas = Array.from({ length: 8 }, () => createReplayStoreRepository({ db }));
    const outcomes = await Promise.all(replicas.map((replica) => replica.consume({ nonce: n, grantId: GRANT, expiresAt: EXP, now: NOW })));
    const actual = outcomes.filter((o) => o === 'consumed').length;
    expect(actual).toBe(1);
  });

  it('given a grant presented, a process restart, and the same grant presented again, should read consumed and refuse to consume', async () => {
    if (!dbAvailable) return;
    const n = nonce();
    await createReplayStoreRepository({ db }).consume({ nonce: n, grantId: GRANT, expiresAt: EXP, now: NOW });
    const restarted = createReplayStoreRepository({ db });
    const state = decideReplay({ lookup: await restarted.lookup({ nonce: n }), now: NOW + 1_000 });
    const second = await restarted.consume({ nonce: n, grantId: GRANT, expiresAt: EXP, now: NOW + 1_000 });
    expect({ state, second }).toEqual({ state: 'consumed', second: 'replayed' });
  });
});
