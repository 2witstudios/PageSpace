import 'dotenv/config';
import { getMigrationPool } from '@pagespace/db/db';
import { runWalletBackfill, type WalletBackfillReport } from '@pagespace/db/wallet-backfill';

/**
 * The X-5 wallets backfill, outside the migrator (Spec X-5, WAL-5).
 *
 * Migration 0301 already runs this backfill on every deploy, in the same migrate
 * invocation as the walletId NOT NULL (0302) that depends on it — so there is never a
 * window where a ledger or hold row lacks a wallet. This script runs the SAME statements
 * (read from the 0301 file) in one transaction, for two jobs:
 *
 *   --dry-run   rehearse: report what the backfill would do, then ROLL BACK. Writes
 *               nothing. Against a database migrated through 0300 it names the wallets
 *               it would create and the rows it would assign; against a fully migrated
 *               database every count is unchanged.
 *   (default)   repair: apply it and COMMIT. Idempotent — a second run changes nothing.
 *
 * Either way it refuses (rolls back) if any balance column's total would move: the
 * backfill assigns wallets, it never moves money.
 *
 * Usage:
 *   bun scripts/backfill-wallets.ts --dry-run
 *   bun scripts/backfill-wallets.ts
 */

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
    const report = await runWalletBackfill(client, { dryRun });
    console.log(describe(report));
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
