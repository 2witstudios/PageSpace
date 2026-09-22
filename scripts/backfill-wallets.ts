import 'dotenv/config';
import { getMigrationPool } from '@pagespace/db/db';
import {
  rehearseWalletMigration,
  runWalletBackfill,
  type WalletBackfillReport,
  type WalletMigrationRehearsal,
} from '@pagespace/db/wallet-backfill';

/**
 * The X-5 wallets backfill, outside the migrator (Spec X-5, WAL-5).
 *
 * Migration 0301 already runs this backfill on every deploy, in the same migrate
 * invocation as the walletId NOT NULL (0302) that depends on it — so there is never a
 * window where a ledger or hold row lacks a wallet. This script runs the SAME statements
 * (read from the 0301 file) in one transaction, for two jobs:
 *
 *   --dry-run   rehearse, then ROLL BACK. Writes nothing.
 *               - Database still at 0297 (production BEFORE the deploy): runs the whole
 *                 0298–0302 chain in one transaction and reports the balance rows, the
 *                 zero wallets 0301 would add, the rows it would assign, and any money
 *                 drift (must be none). It holds the migration's locks (the rename is
 *                 ACCESS EXCLUSIVE on credit_balances) until it rolls back, so run it
 *                 against a restored snapshot of production, not the live primary:
 *                   1. restore the latest production backup into a scratch database;
 *                   2. DATABASE_URL=<scratch> bun scripts/backfill-wallets.ts --dry-run
 *               - Database already through 0300: runs 0301 alone; against a fully
 *                 migrated database every count comes back unchanged.
 *   (default)   repair: apply it and COMMIT. Idempotent — a second run changes nothing.
 *
 * Either way it refuses (rolls back) if any balance column's total would move: the
 * backfill assigns wallets, it never moves money.
 *
 * Usage:
 *   bun scripts/backfill-wallets.ts --dry-run
 *   bun scripts/backfill-wallets.ts
 */

function describeRehearsal(r: WalletMigrationRehearsal): string {
  return [
    'DRY RUN from 0297 — migrations 0298–0302 applied in one transaction, then rolled back. Nothing written.',
    `  credit_balances rows:   ${r.before.balanceRows} -> personal root wallets ${r.after.personalRootWallets} (${r.zeroWalletsCreated} zero-balance added)`,
    `  ledger rows assigned:   ${r.after.ledgerRows - r.after.ledgerMissingWallet} of ${r.before.ledgerRows}`,
    `  hold rows assigned:     ${r.after.holdRows - r.after.holdsMissingWallet} of ${r.before.holdRows}`,
    `  money:                  monthly ${r.after.monthlyRemainingCents}¢, top-up ${r.after.topupRemainingCents}¢, debt ${r.after.debtCents}¢, pending ${r.after.pendingMillicents} m¢`,
    r.drift.length === 0 ? '  drift:                  none' : `  DRIFT (the deploy would move money): ${r.drift.join(', ')}`,
  ].join('\n');
}

function describe(report: WalletBackfillReport): string {
  const { before, after } = report;
  return [
    report.dryRun ? 'DRY RUN — rolled back, nothing written.' : 'Applied and committed.',
    `  wallets:                ${before.wallets} -> ${after.wallets} (${report.walletsCreated} created, zero-balance)`,
    `  personal root wallets:  ${before.personalRootWallets} -> ${after.personalRootWallets}`,
    `  ledger rows assigned:   ${report.ledgerRowsAssigned} of ${before.ledgerRows} (unassigned after: ${after.ledgerMissingWallet})`,
    `  hold rows assigned:     ${report.holdRowsAssigned} of ${before.holdRows} (unassigned after: ${after.holdsMissingWallet})`,
    `  money (unchanged):      monthly ${after.monthlyRemainingCents}¢, top-up ${after.topupRemainingCents}¢, debt ${after.debtCents}¢, pending ${after.pendingMillicents} m¢`,
  ].join('\n');
}

async function main(): Promise<void> {
  const dryRun = process.argv.includes('--dry-run');
  const pool = getMigrationPool();
  const client = await pool.connect();
  try {
    const { rows } = await client.query(`SELECT to_regclass('public.wallets') IS NULL AS "atBase"`);
    const atBase = (rows[0] as { atBase: boolean }).atBase;
    if (atBase && !dryRun) {
      throw new Error('this database is still at 0297: the wallets table does not exist yet. Run the migrations (or --dry-run to rehearse them).');
    }
    if (atBase) {
      const rehearsal = await rehearseWalletMigration(client);
      console.log(describeRehearsal(rehearsal));
      if (rehearsal.drift.length > 0) process.exitCode = 1;
    } else {
      const report = await runWalletBackfill(client, { dryRun });
      console.log(describe(report));
    }
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
