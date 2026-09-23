/**
 * Integration-only setup file (vitest.integration.config.ts).
 *
 * Every integration file runs in an isolated module registry, so each one
 * builds its own `@pagespace/db` pool — up to DB_POOL_MAX (10) connections with
 * a 10-minute idle timeout — and almost none end it. Across ~40 files the idle
 * connections pile up until Postgres refuses the next file with 53300 "too many
 * clients already". Release the pool when each file finishes.
 *
 * It also arms the funding-legs invariant (D-OW-13, see wallet-leg-invariant): every
 * connection of this pool turns the check on, and the commit-time trigger is installed
 * once, so ANY path that leaves a drive wallet's topupRemainingCents != SUM(legs) fails
 * its own transaction — not only the paths a test names.
 */
import { afterAll, beforeAll } from 'vitest';
import * as appDb from '@pagespace/db/db';
import { releaseAppPool } from './release-app-pool';
import { WALLET_LEG_INVARIANT_GUC, installWalletLegInvariantTrigger } from './wallet-leg-invariant';

// A suite may vi.mock('@pagespace/db/db') with only `db`; reading a missing
// export off a vitest mock throws, so look it up defensively.
function appPool(): typeof appDb.pool | undefined {
  try {
    return appDb.pool;
  } catch {
    return undefined;
  }
}

const armedPool = appPool();
if (armedPool && typeof armedPool.on === 'function') {
  // Registered before the file's first query, so every connection runs this first.
  armedPool.on('connect', (client) => {
    client.query(`SET ${WALLET_LEG_INVARIANT_GUC} = 'on'`).catch(() => undefined);
  });
}

beforeAll(async () => {
  if (armedPool && typeof armedPool.connect === 'function') await installWalletLegInvariantTrigger(armedPool);
});

afterAll(async () => {
  await releaseAppPool(appPool());
});
