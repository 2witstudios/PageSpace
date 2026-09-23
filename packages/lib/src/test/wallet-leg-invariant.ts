/**
 * The funding-legs invariant (D-OW-13), asserted in tests two ways:
 *
 *   wallets.topupRemainingCents == SUM(wallet_funding_legs.remainingCents)
 *   for every NON-ROOT wallet — one with a parent or a subject (drive / agent page). Only
 *   those carry funding legs; a root's top-up is a plain bucket. A subject wallet with no
 *   parent is included on purpose: donations give it legs, so any path that moves its
 *   top-up without them must fail here.
 *
 * 1. `expectWalletLegInvariant(ids)` — an explicit check a wallet suite runs on the
 *    wallets its test touched, BEFORE its teardown deletes them (in a finally, so it runs
 *    when the test fails mid-way). It refuses to pass vacuously: it throws unless it found
 *    at least one of the named wallets, and at least one of those is a non-root wallet.
 *
 * 2. `installWalletLegInvariantTrigger(pool)` — the catch-all for paths no test names yet.
 *    A DEFERRED constraint trigger on wallets and wallet_funding_legs re-checks the
 *    invariant for the touched non-root wallet at COMMIT and raises (23514) when it breaks,
 *    so the writer's own transaction fails. It enforces only for sessions where the GUC
 *    `pagespace.assert_wallet_legs` is 'on', which the lib integration setup sets on every
 *    connection of its own pool: other suites and other worktrees sharing the database
 *    are unaffected, and a fixture is free to seed rows through a session without it.
 *    Test-harness only — nothing in the product installs it.
 */
import { db, type pool as appPool } from '@pagespace/db/db';
import { inArray } from '@pagespace/db/operators';
import { wallets, walletFundingLegs } from '@pagespace/db/schema/wallets';

export const WALLET_LEG_INVARIANT_GUC = 'pagespace.assert_wallet_legs';

export async function expectWalletLegInvariant(walletIds: readonly string[]): Promise<void> {
  if (walletIds.length === 0) throw new Error('expectWalletLegInvariant: no wallet ids given — the check would pass vacuously');
  const rows = await db
    .select({ id: wallets.id, parentWalletId: wallets.parentWalletId, subjectType: wallets.subjectType, topupRemainingCents: wallets.topupRemainingCents })
    .from(wallets)
    .where(inArray(wallets.id, [...walletIds]));
  const children = rows.filter((w) => w.parentWalletId !== null || w.subjectType !== null);
  if (children.length === 0) {
    throw new Error(`expectWalletLegInvariant: none of ${walletIds.join(', ')} is an existing non-root wallet — nothing was checked`);
  }
  const legs = await db
    .select({ walletId: walletFundingLegs.walletId, remainingCents: walletFundingLegs.remainingCents })
    .from(walletFundingLegs)
    .where(inArray(walletFundingLegs.walletId, children.map((w) => w.id)));
  const broken = children
    .map((w) => ({
      walletId: w.id,
      topupRemainingCents: w.topupRemainingCents,
      legsTotal: legs.filter((l) => l.walletId === w.id).reduce((sum, l) => sum + l.remainingCents, 0),
    }))
    .filter((w) => w.topupRemainingCents !== w.legsTotal);
  if (broken.length > 0) {
    throw new Error(`topupRemainingCents != SUM(legs.remainingCents): ${JSON.stringify(broken)}`);
  }
}

const TRIGGER_SQL = `
CREATE OR REPLACE FUNCTION pagespace_test_assert_wallet_legs() RETURNS trigger LANGUAGE plpgsql AS $fn$
DECLARE
  wid text;
  w record;
  legs_total bigint;
BEGIN
  IF coalesce(current_setting('${WALLET_LEG_INVARIANT_GUC}', true), '') <> 'on' THEN RETURN NULL; END IF;
  IF TG_TABLE_NAME = 'wallets' THEN
    wid := NEW.id;
  ELSIF TG_OP = 'DELETE' THEN
    wid := OLD."walletId";
  ELSE
    wid := NEW."walletId";
  END IF;
  SELECT id, "parentWalletId", "subjectType", "topupRemainingCents" INTO w FROM wallets WHERE id = wid;
  IF NOT FOUND OR (w."parentWalletId" IS NULL AND w."subjectType" IS NULL) THEN RETURN NULL; END IF;
  SELECT coalesce(sum("remainingCents"), 0) INTO legs_total FROM wallet_funding_legs WHERE "walletId" = wid;
  IF w."topupRemainingCents" <> legs_total THEN
    RAISE EXCEPTION 'wallet % breaks topupRemainingCents == SUM(legs.remainingCents): % <> %', wid, w."topupRemainingCents", legs_total
      USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END
$fn$;
`;

const TRIGGERS: [string, string][] = [
  ['pagespace_test_wallet_legs_on_wallets', 'AFTER INSERT OR UPDATE ON wallets'],
  ['pagespace_test_wallet_legs_on_legs', 'AFTER INSERT OR UPDATE OR DELETE ON wallet_funding_legs'],
];

/** Install the commit-time trigger once per database (idempotent, serialised by an advisory lock). */
export async function installWalletLegInvariantTrigger(pool: typeof appPool): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query("SELECT pg_advisory_xact_lock(hashtext('pagespace_test_assert_wallet_legs'))");
    await client.query(TRIGGER_SQL);
    for (const [name, event] of TRIGGERS) {
      const { rows } = await client.query('SELECT 1 FROM pg_trigger WHERE tgname = $1', [name]);
      if (rows.length === 0) {
        await client.query(
          `CREATE CONSTRAINT TRIGGER ${name} ${event} DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION pagespace_test_assert_wallet_legs()`,
        );
      }
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}
