/**
 * Integration-only setup file (vitest.integration.config.ts) — NOT in the unit config.
 *
 * Arms the funding-legs invariant (D-OW-13, see wallet-leg-invariant): every
 * connection of this pool turns the check on, and the commit-time trigger is installed
 * once, so ANY path that leaves a drive wallet's topupRemainingCents != SUM(legs) fails
 * its own transaction — not only the paths a test names.
 *
 * Pool release lives in integration-db-teardown.ts (shared with the unit run, where the
 * db module must be imported lazily); it is kept apart so the unit run neither
 * statically loads the real db pool nor needs a database to install the trigger.
 */
import { beforeAll } from 'vitest';
import * as appDb from '@pagespace/db/db';
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
