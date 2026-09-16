/**
 * ADR 0005 §2.2 `rebind`, §2.5 (G1c E2) — owner consents are single-use
 * through the SHARED replay store: two ledgers over one database stand in for
 * two plane replicas, and a consent id never collides with a grant nonce.
 * Written RED before `consent-ledger-repository.ts` exists.
 *
 * FAILS LOUDLY when no DB is reachable (`requireDb`); local runs without a
 * database opt out explicitly with ALLOW_SKIP_DB_TESTS=1.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db } from '@pagespace/db/db';
import { sql } from '@pagespace/db/operators';
import { agentAccountGrantNonces } from '@pagespace/db/schema/agent-account-grant-nonces';
import { requireDb } from '@pagespace/db/test/require-db';
import { createReplayStoreRepository } from '../replay-store-repository';
import { createConsentLedgerRepository } from '../store/consent-ledger-repository';
import type { ConsentId, GrantId, Nonce } from '../grant';

const RUN = `itest-consent-${Date.now()}`;
let dbAvailable = false;

async function clearRows() {
  await db.delete(agentAccountGrantNonces).where(sql`${agentAccountGrantNonces.nonce} LIKE ${`consent:${RUN}%`} OR ${agentAccountGrantNonces.nonce} LIKE ${`${RUN}%`}`);
}

beforeAll(async () => {
  try {
    await db.execute(sql`SELECT 1`);
    dbAvailable = true;
  } catch (error) {
    requireDb('consent-ledger-repository.integration.test.ts', error);
  }
  if (dbAvailable) await clearRows();
});

afterAll(async () => {
  if (dbAvailable) await clearRows();
});

describe('consent ledger over the replay store (G1c E2)', () => {
  it('given one consent presented to two replicas, should be consumed by exactly one and replayed for the other', async () => {
    const replicaA = createConsentLedgerRepository({ replayStore: createReplayStoreRepository({ db }) });
    const replicaB = createConsentLedgerRepository({ replayStore: createReplayStoreRepository({ db }) });
    const consentId = `${RUN}-once` as ConsentId;
    const now = Date.now();

    const outcomes = await Promise.all([replicaA.consume({ consentId, expiresAt: now + 300_000, now }), replicaB.consume({ consentId, expiresAt: now + 300_000, now })]);
    const actual = [...outcomes].sort();
    expect(actual).toEqual(['consumed', 'replayed']);
  });

  it('given a grant nonce spelled like a consent id, should not collide — consents live in their own namespace', async () => {
    const replayStore = createReplayStoreRepository({ db });
    const ledger = createConsentLedgerRepository({ replayStore });
    const shared = `${RUN}-shared`;
    const now = Date.now();

    const grantNonce = await replayStore.consume({ nonce: shared as Nonce, grantId: 'grant_itest' as GrantId, expiresAt: now + 60_000, now });
    const consent = await ledger.consume({ consentId: shared as ConsentId, expiresAt: now + 300_000, now });
    expect({ grantNonce, consent }).toEqual({ grantNonce: 'consumed', consent: 'consumed' });
  });
});
