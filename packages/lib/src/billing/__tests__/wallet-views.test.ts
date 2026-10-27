import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { centsFromCredits } from '../money-model';
import {
  projectDriveWallet,
  walletRemainingCents,
  capRemainingCents,
  poolUnallocatedCents,
  consumerSpendRows,
  workflowIdsToName,
  CONSUMER_WALLET_FIELDS,
  DRIVE_WALLET_LIST_FIELDS,
  driveWalletListEntry,
  type DriveWalletFacts,
} from '../wallet-views';
import { encodeAutomationRef } from '../automation-attribution';

const wf = (workflowId: string) => encodeAutomationRef({ kind: 'workflow', workflowId });

// Northwind Labs fixture: Product's wallet holds a 1,200-credit allocation under the
// 9,000-credit pool; Marcus has spent 50 credits of it, Lena 30, Priya 20 and her weekly digest 15.
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
    guestSpendEnabled: false,
    parentStatus: 'active',
  },
  myCap: { dailyCapCents: c(10), monthlyCapCents: null, spentTodayCents: c(4), spentThisMonthCents: c(50) },
  spendByConsumer: [
    {
      consumerKey: 'user:u-marcus', userId: 'u-marcus', displayName: 'Marcus Oyelaran', spentCents: c(50), spentTodayCents: c(12), viaAutomationsCents: c(20),
      automations: [{ consumerKey: 'automation:workflow:wf-digest', automation: { kind: 'workflow', workflowId: 'wf-digest' }, displayName: 'Weekly digest', creatorUserId: 'u-marcus', creatorName: 'Marcus Oyelaran', spentCents: c(20), spentTodayCents: c(2) }],
    },
    { consumerKey: 'user:u-lena', userId: 'u-lena', displayName: 'Lena Lead', spentCents: c(30), spentTodayCents: 0, viaAutomationsCents: 0, automations: [] },
    { consumerKey: 'former-member', userId: null, displayName: null, spentCents: c(20), spentTodayCents: c(20), viaAutomationsCents: 0, automations: [] },
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

  it('SPEND-9 (partial) the remaining amount is the wallet\'s OWN budget (top-ups + allocation left net of debt, D-OW-60), never capped by — so never revealing — the pool', () => {
    expect(walletRemainingCents(facts().wallet)).toBe(c(1200) - c(100) + c(40));
    expect(walletRemainingCents({ ...facts().wallet, spentCents: c(1300), topupRemainingCents: 0 })).toBe(0);
    // Debt beyond the allocation left never eats the top-up.
    expect(walletRemainingCents({ ...facts().wallet, debtCents: c(2000) })).toBe(c(40));
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

describe('wallet-views: spend by member, today and via automations (D-OW-67)', () => {
  const people = new Map([['u-priya', 'Priya Nair'], ['u-marcus', 'Marcus Oyelaran'], ['u-lena', 'Lena Lead']]);
  const automations = new Map([['wf-digest', { name: 'Weekly digest', createdBy: 'u-priya' }]]);
  const names = { people, automations };
  const digest = { consumerKey: 'automation:workflow:wf-digest', automation: { kind: 'workflow', workflowId: 'wf-digest' }, displayName: 'Weekly digest', creatorUserId: 'u-priya', creatorName: 'Priya Nair' } as const;

  it("UI-9 (partial) SPEND-10 (partial) one row per person from the one ledger read model: a creator's workflow spend is inside their row as via automations and listed under it, never counted twice", () => {
    const rows = consumerSpendRows([
      { userId: 'u-priya', automationRef: null, today: false, spentCents: c(20) },
      { userId: 'u-priya', automationRef: null, today: true, spentCents: c(3) },
      { userId: 'u-priya', automationRef: wf('wf-digest'), today: false, spentCents: c(15) },
      { userId: 'u-priya', automationRef: wf('wf-digest'), today: true, spentCents: c(1) },
      { userId: 'u-marcus', automationRef: null, today: false, spentCents: c(50) },
    ], names);
    expect(rows).toEqual([
      { consumerKey: 'user:u-marcus', userId: 'u-marcus', displayName: 'Marcus Oyelaran', spentCents: c(50), spentTodayCents: 0, viaAutomationsCents: 0, automations: [] },
      {
        consumerKey: 'user:u-priya', userId: 'u-priya', displayName: 'Priya Nair', spentCents: c(39), spentTodayCents: c(4), viaAutomationsCents: c(16),
        automations: [{ ...digest, spentCents: c(16), spentTodayCents: c(1) }],
      },
    ]);
    const total = rows.reduce((n, r) => n + r.spentCents, 0);
    expect(total).toBe(c(89));
  });

  it('SPEND-10 (partial) an automation is listed under whoever its spend is recorded as; a deleted workflow keeps its spend, unnamed', () => {
    const rows = consumerSpendRows([
      { userId: 'u-priya', automationRef: wf('wf-digest'), today: false, spentCents: c(10) },
      { userId: 'u-marcus', automationRef: wf('wf-digest'), today: false, spentCents: c(5) },
      { userId: 'u-marcus', automationRef: wf('wf-gone'), today: false, spentCents: c(3) },
    ], names);
    expect(rows.map((r) => [r.userId, r.spentCents, r.viaAutomationsCents, r.automations.map((a) => [a.displayName, a.spentCents])])).toEqual([
      ['u-priya', c(10), c(10), [['Weekly digest', c(10)]]],
      ['u-marcus', c(8), c(8), [['Weekly digest', c(5)], [null, c(3)]]],
    ]);
  });

  it('SPEND-10 (partial) a Zoom connection\'s transcript enrichment is listed under the connection\'s owner, named', () => {
    const ref = encodeAutomationRef({ kind: 'zoom', connectionId: 'zc-1' });
    const [row] = consumerSpendRows([{ userId: 'u-marcus', automationRef: ref, today: true, spentCents: c(4) }], names);
    expect(row.automations).toEqual([
      { consumerKey: 'automation:zoom:zc-1', automation: { kind: 'zoom', connectionId: 'zc-1' }, displayName: 'Zoom transcripts', creatorUserId: 'u-marcus', creatorName: 'Marcus Oyelaran', spentCents: c(4), spentTodayCents: c(4) },
    ]);
    expect(row).toMatchObject({ spentCents: c(4), spentTodayCents: c(4), viaAutomationsCents: c(4) });
  });

  it('SPEND-10 (partial) only the workflows the groups name are looked up; a reference the codec did not write stays the person\'s own spend', () => {
    const groups = [
      { userId: 'u-marcus', automationRef: wf('wf-digest'), today: false, spentCents: c(2) },
      { userId: 'u-marcus', automationRef: wf('wf-digest'), today: true, spentCents: c(1) },
      { userId: 'u-marcus', automationRef: encodeAutomationRef({ kind: 'zoom', connectionId: 'zc-1' }), today: false, spentCents: c(1) },
      { userId: 'u-priya', automationRef: 'wf-raw-id', today: false, spentCents: c(5) },
    ];
    expect(workflowIdsToName(groups)).toEqual(['wf-digest']);
    expect(consumerSpendRows([groups[3]], names)).toEqual([
      { consumerKey: 'user:u-priya', userId: 'u-priya', displayName: 'Priya Nair', spentCents: c(5), spentTodayCents: 0, viaAutomationsCents: 0, automations: [] },
    ]);
  });

  it('D-OW-58 every deleted account\'s spend is one unnamed former-member row, never folded into anyone else\'s', () => {
    const rows = consumerSpendRows([
      { userId: null, automationRef: null, today: false, spentCents: c(6) },
      { userId: null, automationRef: wf('wf-digest'), today: true, spentCents: c(2) },
      { userId: 'u-lena', automationRef: null, today: false, spentCents: c(1) },
    ], names);
    expect(rows.map((r) => [r.consumerKey, r.userId, r.displayName, r.spentCents, r.spentTodayCents, r.viaAutomationsCents])).toEqual([
      ['former-member', null, null, c(8), c(2), c(2)],
      ['user:u-lena', 'u-lena', 'Lena Lead', c(1), 0, 0],
    ]);
  });

  it('a refund that leaves a group below zero shows nothing spent, an unknown person is unnamed, and ties order by key', () => {
    expect(consumerSpendRows([{ userId: 'u-x', automationRef: null, today: true, spentCents: -5 }], names))
      .toEqual([{ consumerKey: 'user:u-x', userId: 'u-x', displayName: null, spentCents: 0, spentTodayCents: 0, viaAutomationsCents: 0, automations: [] }]);
    const rows = consumerSpendRows([
      { userId: 'u-b', automationRef: null, today: false, spentCents: 10 },
      { userId: 'u-a', automationRef: null, today: false, spentCents: 10 },
      { userId: 'u-c', automationRef: null, today: false, spentCents: 99 },
    ], names);
    expect(rows.map((r) => r.userId)).toEqual(['u-c', 'u-a', 'u-b']);
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

  it('SPEND-10 (partial) the lead sees the wallet and spend by member and by automation, but never the pool', () => {
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
    // UI-9: today and via automations per member, as credit counts too; SPEND-10: the automations listed under them.
    expect(view.spendByConsumer.map((s) => [s.spentTodayCredits, s.viaAutomationsCredits])).toEqual([['12', '20'], ['0', '0'], ['20', '0']]);
    expect(view.spendByConsumer[0].automations.map((a) => [a.displayName, a.spentCredits, a.spentTodayCredits])).toEqual([['Weekly digest', '20', '2']]);
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
    expect(imports.sort()).toEqual(['../permissions/wallet-access', './automation-attribution', './money-model', './wallet-core']);
  });
});

describe('wallet-views: the kill switch and the guest switch', () => {
  it('WAL-7 (partial) a drive wallet under a paused pool shows paused to every viewer, its own status untouched', () => {
    const underPausedPool = facts({ wallet: { ...facts().wallet, parentStatus: 'paused' } });
    expect(projectDriveWallet('member', underPausedPool).status).toBe('paused');
    expect(projectDriveWallet('org_admin', underPausedPool).status).toBe('paused');
    expect(projectDriveWallet('member', facts()).status).toBe('active');
  });

  it('SPEND-9 (partial) the guest switch is shown to the lead and admins who run it, never in the consumer projection', () => {
    const open = facts({ wallet: { ...facts().wallet, guestSpendEnabled: true } });
    expect(projectDriveWallet('lead', open)).toMatchObject({ guestSpendEnabled: true });
    expect(Object.keys(projectDriveWallet('guest', open)).sort()).toEqual([...CONSUMER_WALLET_FIELDS].sort());
  });
});

describe('driveWalletListEntry (a drive wallet I spend from)', () => {
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
