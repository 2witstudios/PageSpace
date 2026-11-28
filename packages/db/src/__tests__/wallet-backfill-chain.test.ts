import { describe, expect, it } from 'vitest';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import os from 'os';
import path from 'path';
import { rehearseWalletMigration, walletBackfillStatements, type BackfillClient } from '../wallet-backfill';
const migrationsDir = path.resolve(__dirname, '../../drizzle');
const tags = ['0335_aromatic_smiling_tiger', '0336_quick_falcon', '0337_wallets_drop_user_primary_key', '0338_wallets_owner_subject_parent_and_wallet_ids', '0339_wallets_lock_and_require_wallet_ids', '0340_wallets_backfill_wallet_ids', '0341_wallet_ids_required'];
const statements = (tag: string) => readFileSync(path.join(migrationsDir, `${tag}.sql`), 'utf8').split('--> statement-breakpoint').map((s) => s.trim()).filter(Boolean);
const counts = { balanceRows: '0', ledgerRows: '0', holdRows: '0', wallets: '0', personalRootWallets: '0', ledgerMissingWallet: '0', holdsMissingWallet: '0', monthlyRemainingCents: '0', topupRemainingCents: '0', debtCents: '0', pendingMillicents: '0' };
function client() {
  const queries: string[] = [];
  const connection: BackfillClient = { query: async (sql) => {
    queries.push(sql);
    return { rows: sql.includes('to_regclass') ? [{ hasBalances: true, hasWallets: false, hasOrganizations: false }] : [counts] };
  } };
  return { queries, connection };
}
describe('wallet backfill resolves the current immutable migration chain', () => {
  it('loads the real backfill SQL rather than a stale migration prefix', () => {
    expect(walletBackfillStatements()).toEqual(statements(tags[5]));
  });
  it('rehearses every current chain statement in journal order, then rolls back', async () => {
    const c = client();
    await rehearseWalletMigration(c.connection);
    expect(c.queries.slice(4, -2)).toEqual(tags.flatMap(statements));
    expect(c.queries[c.queries.length - 1]).toBe('ROLLBACK');
  });
  it('refuses an incomplete journal before issuing any database queries', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'wallet-chain-'));
    try {
      mkdirSync(path.join(dir, 'meta'));
      writeFileSync(path.join(dir, 'meta/_journal.json'), JSON.stringify({ entries: tags.slice(1).map((tag) => ({ tag })) }));
      for (const tag of tags) copyFileSync(path.join(migrationsDir, `${tag}.sql`), path.join(dir, `${tag}.sql`));
      const c = client();
      await expect(rehearseWalletMigration(c.connection, dir)).rejects.toThrow(/incomplete wallet migration chain/);
      expect(c.queries).toEqual([]);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
