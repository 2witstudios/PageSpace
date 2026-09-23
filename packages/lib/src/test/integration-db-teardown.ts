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
// A connection whose SET failed is not armed; remembered here and thrown below rather than
// swallowed, so a broken harness fails loudly instead of silently checking nothing.
let armFailure: unknown = null;
if (armedPool && typeof armedPool.on === 'function') {
  // Registered before the file's first query, so every connection runs this first.
  armedPool.on('connect', (client) => {
    client.query(`SET ${WALLET_LEG_INVARIANT_GUC} = 'on'`).catch((error: unknown) => {
      armFailure = error;
    });
  });
}

beforeAll(async () => {
  if (!armedPool || typeof armedPool.connect !== 'function') return;
  await installWalletLegInvariantTrigger(armedPool);
  // Prove the arming on a real checkout rather than trust the hook ran.
  const client = await armedPool.connect();
  try {
    const { rows } = await client.query<{ armed: string | null }>(`SELECT current_setting('${WALLET_LEG_INVARIANT_GUC}', true) AS armed`);
    if (rows[0]?.armed !== 'on') throw new Error(`wallet-leg invariant harness is not armed on this connection (got ${String(rows[0]?.armed)})`);
  } finally {
    client.release();
  }
  if (armFailure) throw armFailure;
});

afterAll(async () => {
  await releaseAppPool(appPool());
});
