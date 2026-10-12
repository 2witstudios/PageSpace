import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { centsFromCredits } from '../money-model';
import {
  projectDriveWallet,
  walletRemainingCents,
  capRemainingCents,
  poolUnallocatedCents,
  CONSUMER_WALLET_FIELDS,
  consumerSpendFromBuckets,
  DRIVE_WALLET_LIST_FIELDS,
  driveWalletListEntry,
  type DriveWalletFacts,
} from '../wallet-views';

// Northwind Labs fixture: Product's wallet holds a 1,200-credit allocation under the
// 9,000-credit pool; Marcus has spent 50 credits of it, Lena 30, the weekly digest 20.
const c = (credits: number): number => Math.round(centsFromCredits(credits));

const facts = (over: Partial<DriveWalletFacts> = {}): DriveWalletFacts => ({
  wallet: {
    id: 'w-product',
    driveId: 'd-product',
    status: 'active',
    monthlyAllowanceCents: c(1200),
    spentCents: c(100),
    topupRemainingCents: c(40),
    debtCents: 0,
    monthlyPeriodStart: new Date('2026-09-01T00:00:00Z'),
    monthlyPeriodEnd: new Date('2026-10-01T00:00:00Z'),
    fallbackRule: null,
    donationsEnabled: true,
    defaultSpendSource: null,
    overshootChoice: null,
  },
  myCap: { dailyCapCents: c(10), monthlyCapCents: null, spentTodayCents: c(4), spentThisMonthCents: c(50) },
  spendByConsumer: [
    { consumerKey: 'user:u-marcus', userId: 'u-marcus', displayName: 'Marcus Oyelaran', spentCents: c(50), spentTodayCents: c(12), viaAutomationsCents: c(20) },
    { consumerKey: 'user:u-lena', userId: 'u-lena', displayName: 'Lena Lead', spentCents: c(30), spentTodayCents: 0, viaAutomationsCents: 0 },
    { consumerKey: 'drive:d-product', userId: null, displayName: null, spentCents: c(20), spentTodayCents: c(20), viaAutomationsCents: c(20) },
  ],
  pool: { walletId: 'w-pool', availableCents: c(9000), outstandingChildAllocationsCents: c(3000) },
  ...over,
});

const SECRET_KEYS = ['pool', 'spendByConsumer', 'allocationCents', 'spentCents', 'debtCents', 'fallbackRule', 'overshootChoice', 'parentWalletId', 'topupRemainingCents'];

describe('wallet-views: the over state', () => {
  const withWallet = (status: 'active' | 'paused' | 'over', debtCents: number) =>
    facts({ wallet: { ...facts().wallet, status, debtCents } });

  it('WAL-6 (partial) a wallet carrying debt SHOWS over to everyone who can see it, whatever status is stored', () => {
    for (const viewer of ['member', 'guest', 'lead', 'org_admin'] as const) {
      expect(projectDriveWallet(viewer, withWallet('active', 90)).status).toBe('over');
    }
  });

  it('the kill switch wins over debt, and a stored over with its debt cleared shows active', () => {
    expect(projectDriveWallet('lead', withWallet('paused', 90)).status).toBe('paused');
    expect(projectDriveWallet('lead', withWallet('over', 0)).status).toBe('active');
  });

  it('WAL-6 (partial) the funder\'s overshoot choice is shown to the lead and the org admins, never to a consumer', () => {
    const chosen = facts({ wallet: { ...facts().wallet, overshootChoice: 'wallet_debt' } });
    expect(projectDriveWallet('lead', chosen)).toMatchObject({ overshootChoice: 'wallet_debt' });
    expect(projectDriveWallet('org_admin', chosen)).toMatchObject({ overshootChoice: 'wallet_debt' });
    expect(projectDriveWallet('member', chosen)).not.toHaveProperty('overshootChoice');
  });
});

describe('wallet-views: the numbers', () => {
  it('UI-12 (partial) every amount a consumer sees also carries its credit count from the money model\'s one formatter, so no client converts', () => {
    const view = projectDriveWallet('member', facts({ wallet: { ...facts().wallet, monthlyAllowanceCents: c(120_000), spentCents: 0, topupRemainingCents: 0 } }));
    expect(view).toMatchObject({ remainingCents: c(120_000), remainingCredits: '120,000' });
    expect(JSON.stringify(view)).not.toContain('$');
  });

  it('SPEND-9 (partial) the remaining amount is the wallet\'s OWN budget (allocation left + top-ups − debt), never capped by — so never revealing — the pool', () => {
    expect(walletRemainingCents(facts().wallet)).toBe(c(1200) - c(100) + c(40));
    expect(walletRemainingCents({ ...facts().wallet, spentCents: c(1300), topupRemainingCents: 0 })).toBe(0);
    expect(walletRemainingCents({ ...facts().wallet, debtCents: c(2000) })).toBe(0);
  });

  it('SPEND-9 (partial) a consumer\'s remaining cap is per window; an unset cap is unlimited (null)', () => {
    expect(capRemainingCents(facts().myCap)).toEqual({ dailyRemainingCents: c(6), monthlyRemainingCents: null, dailyRemainingCredits: '6', monthlyRemainingCredits: null });
    expect(capRemainingCents({ dailyCapCents: c(10), monthlyCapCents: c(100), spentTodayCents: c(15), spentThisMonthCents: c(120) }))
      .toEqual({ dailyRemainingCents: 0, monthlyRemainingCents: 0, dailyRemainingCredits: '0', monthlyRemainingCredits: '0' });
    expect(capRemainingCents(null)).toEqual({ dailyRemainingCents: null, monthlyRemainingCents: null, dailyRemainingCredits: null, monthlyRemainingCredits: null });
  });

  it('SPEND-10 (partial) the unallocated balance is the pool\'s available less what its children may still draw', () => {
    expect(poolUnallocatedCents(facts().pool!)).toBe(c(6000));
  });
});

describe('wallet-views: the projection each viewer gets', () => {
  it('SPEND-9 (partial) a member sees exactly the consumer allowlist: remaining, status, own cap, donations switch — no pool, no funder balance, no other consumer\'s spend', () => {
    const view = projectDriveWallet('member', facts());
    expect(Object.keys(view).sort()).toEqual([...CONSUMER_WALLET_FIELDS].sort());
    expect(view).toEqual({
      viewer: 'member',
      walletId: 'w-product',
      driveId: 'd-product',
      status: 'active',
      remainingCents: c(1140),
      remainingCredits: '1,140',
      myCap: { dailyRemainingCents: c(6), monthlyRemainingCents: null, dailyRemainingCredits: '6', monthlyRemainingCredits: null },
      donationsEnabled: true,
      defaultSpendSource: null,
    });
    const json = JSON.stringify(view);
    for (const key of SECRET_KEYS) expect(json, key).not.toContain(`"${key}"`);
    // No other consumer's id or amount leaks through any field.
    expect(json).not.toContain('u-lena');
    expect(json).not.toContain(String(c(9000)));
  });

  it('SPEND-9 (partial) a guest gets the same consumer projection', () => {
    expect(Object.keys(projectDriveWallet('guest', facts())).sort()).toEqual([...CONSUMER_WALLET_FIELDS].sort());
  });

  it('SPEND-10 (partial) the lead sees the wallet and spend by member and automation, but never the pool', () => {
    const view = projectDriveWallet('lead', facts());
    expect(view).toMatchObject({
      viewer: 'lead',
      allocationCents: c(1200),
      spentCents: c(100),
      topupRemainingCents: c(40),
      debtCents: 0,
      spendByConsumer: facts().spendByConsumer,
    });
    expect('pool' in view).toBe(false);
    expect(JSON.stringify(view)).not.toContain(String(c(9000)));
  });

  it('UI-9 (partial) the lead\'s and admin\'s amounts come with credit counts and spend by member comes with names, so the client never converts or resolves an id', () => {
    const view = projectDriveWallet('org_admin', facts());
    expect(view).toMatchObject({
      allocationCredits: '1,200', spentCredits: '100', topupRemainingCredits: '40', debtCredits: '0',
      pool: { availableCredits: '9,000', unallocatedCredits: '6,000' },
    });
    if (view.viewer !== 'org_admin') throw new Error('expected an org admin view');
    expect(view.spendByConsumer.map((s) => [s.displayName, s.spentCredits])).toEqual([['Marcus Oyelaran', '50'], ['Lena Lead', '30'], [null, '20']]);
    // UI-9: today and via automations per member, as credit counts too.
    expect(view.spendByConsumer.map((s) => [s.spentTodayCredits, s.viaAutomationsCredits])).toEqual([['12', '20'], ['0', '0'], ['20', '20']]);
    expect(JSON.stringify(view)).not.toContain('$');
  });

  it('SPEND-10 (partial) an org admin also sees the pool and the unallocated balance', () => {
    const view = projectDriveWallet('org_admin', facts());
    expect(view).toMatchObject({ viewer: 'org_admin', pool: { walletId: 'w-pool', availableCents: c(9000), unallocatedCents: c(6000) } });
  });

  it('SPEND-10 (partial) on a personal drive there is no pool, even for its lead', () => {
    const view = projectDriveWallet('lead', facts({ pool: null }));
    expect('pool' in view).toBe(false);
  });

  it('a non-member gets no projection at all', () => {
    expect(() => projectDriveWallet('none', facts())).toThrow();
  });
});

describe('wallet-views purity', () => {
  it('imports nothing that does I/O', () => {
    const src = readFileSync(fileURLToPath(new URL('../wallet-views.ts', import.meta.url)), 'utf8');
    const imports = [...src.matchAll(/from\s+'([^']+)'/g)].map((m) => m[1]);
    expect(imports.sort()).toEqual(['../monitoring/usage-source', '../permissions/wallet-access', './money-model', './wallet-core']);
  });
});

describe('consumerSpendFromBuckets (UI-9: who spends, today and via automations)', () => {
  const names = new Map([['u-marcus', 'Marcus Oyelaran'], ['u-lena', 'Lena Lead']]);

  it('UI-9 (partial) folds a wallet\'s usage buckets into one row per person: spent this period, of which today and via automations', () => {
    const rows = consumerSpendFromBuckets([
      { userId: 'u-marcus', cents: 300, today: false, viaAutomation: false },
      { userId: 'u-marcus', cents: 120, today: true, viaAutomation: false },
      { userId: 'u-marcus', cents: 80, today: true, viaAutomation: true },
      { userId: 'u-lena', cents: 50, today: false, viaAutomation: true },
    ], names);
    expect(rows).toEqual([
      { consumerKey: 'user:u-marcus', userId: 'u-marcus', displayName: 'Marcus Oyelaran', spentCents: 500, spentTodayCents: 200, viaAutomationsCents: 80 },
      { consumerKey: 'user:u-lena', userId: 'u-lena', displayName: 'Lena Lead', spentCents: 50, spentTodayCents: 0, viaAutomationsCents: 50 },
    ]);
  });

  it('a refund bucket never shows negative spend, and an unknown name is null, never an id', () => {
    const [row] = consumerSpendFromBuckets([{ userId: 'u-x', cents: -40, today: true, viaAutomation: false }], names);
    expect(row).toMatchObject({ displayName: null, spentCents: 0, spentTodayCents: 0, viaAutomationsCents: 0 });
  });

  it('orders by spend, then by person, so the list is deterministic', () => {
    const rows = consumerSpendFromBuckets([
      { userId: 'u-b', cents: 10, today: false, viaAutomation: false },
      { userId: 'u-a', cents: 10, today: false, viaAutomation: false },
      { userId: 'u-c', cents: 99, today: false, viaAutomation: false },
    ], names);
    expect(rows.map((r) => r.userId)).toEqual(['u-c', 'u-a', 'u-b']);
  });
});

describe('driveWalletListEntry (UI-10: a drive wallet I spend from)', () => {
  const row = { id: 'w-product', subjectId: 'd-product', status: 'active' as const, monthlyAllowanceCents: c(1200), spentCents: c(100), topupRemainingCents: 0, debtCents: 0 };

  it('UI-10 (partial) shows what is left and what I spent from it this period, both as credit counts', () => {
    expect(driveWalletListEntry(row, 'Product', c(42))).toEqual({
      driveId: 'd-product', driveName: 'Product', walletId: 'w-product', status: 'active',
      remainingCents: c(1100), remainingCredits: '1,100', mySpentCents: c(42), mySpentCredits: '42',
    });
  });

  it('SPEND-9 (partial) carries my own spend only: never the allocation, the wallet\'s total spend or anyone else\'s', () => {
    const entry = driveWalletListEntry({ ...row, monthlyAllowanceCents: c(9173), spentCents: c(4567) }, 'Product', 0);
    expect(Object.keys(entry).sort()).toEqual([...DRIVE_WALLET_LIST_FIELDS].sort());
    expect(JSON.stringify(entry)).not.toMatch(/9173|9,173|4567|4,567/);
  });
});
