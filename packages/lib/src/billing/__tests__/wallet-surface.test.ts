import { describe, it, expect } from 'vitest';
import {
  driveWalletPanels,
  walletStatusCopy,
  parseCreditInput,
  walletPeriodCopy,
  fundedByCopy,
  spendMeterPercent,
  spendRowLabel,
  spendFromRowCopy,
  orgDriveSummaryCopy,
} from '../wallet-surface';
import { projectDriveWallet, type DriveWalletFacts } from '../wallet-views';
import { walletActionsFor } from '../../permissions/wallet-access';

const facts: DriveWalletFacts = {
  wallet: {
    id: 'w-product',
    driveId: 'd-product',
    status: 'active',
    monthlyAllowanceCents: 1200,
    spentCents: 1008,
    topupRemainingCents: 0,
    debtCents: 0,
    monthlyPeriodStart: new Date('2026-09-01T00:00:00Z'),
    monthlyPeriodEnd: new Date('2026-10-01T00:00:00Z'),
    fallbackRule: 'seat_allowance',
    donationsEnabled: true,
    defaultSpendSource: 'drive_wallet',
    overshootChoice: null,
  },
  myCap: { dailyCapCents: 2000, monthlyCapCents: null, spentTodayCents: 2000, spentThisMonthCents: 2000 },
  spendByConsumer: [{ consumerKey: 'user:u-priya', userId: 'u-priya', displayName: 'Priya Nair', spentCents: 645 }],
  pool: { walletId: 'w-pool', availableCents: 9000, outstandingChildAllocationsCents: 1200 },
};

const read = (viewer: 'org_admin' | 'lead' | 'member' | 'guest', orgDrive = true) => ({
  viewer,
  actions: walletActionsFor(viewer, { orgDrive }),
  wallet: projectDriveWallet(viewer, facts),
});

describe('driveWalletPanels: which parts of Drive Settings › Wallet a viewer gets', () => {
  it('UI-9 (partial) a member or guest sees only the remaining amount, their own cap and donate: never the pool or others\' spend (SPEND-9 (partial))', () => {
    for (const viewer of ['member', 'guest'] as const) {
      const panels = driveWalletPanels(read(viewer));
      expect(panels).toMatchObject({ balance: true, myCap: true, donate: true, allocation: false, topUp: false, pause: false, rules: false, caps: false, spendByMember: false, pool: false, create: false });
    }
  });

  it('SPEND-9 (partial) even an action list that wrongly allowed more cannot open what the projection does not carry', () => {
    const forged = { ...read('member'), actions: walletActionsFor('org_admin', { orgDrive: true }) };
    const panels = driveWalletPanels(forged);
    expect(panels.spendByMember).toBe(false);
    expect(panels.pool).toBe(false);
    expect(panels.allocation).toBe(false);
  });

  it('SPEND-10 (partial) an org drive\'s lead runs it (pause, rules) and sees spend by member, but moves no org money and sets no caps (WAL-7 (partial))', () => {
    expect(driveWalletPanels(read('lead'))).toMatchObject({ allocation: true, editAllocation: false, topUp: false, pause: true, rules: true, editRules: true, caps: true, editCaps: false, spendByMember: true, pool: false });
  });

  it('SPEND-10 (partial) an org Owner or Admin gets everything, including the pool', () => {
    expect(driveWalletPanels(read('org_admin'))).toMatchObject({ allocation: true, editAllocation: true, topUp: true, pause: true, rules: true, editRules: true, caps: true, editCaps: true, spendByMember: true, pool: true });
  });

  it('WAL-7 (partial) on a personal drive the lead (the wallet\'s owner) sets caps and funds it', () => {
    expect(driveWalletPanels(read('lead', false))).toMatchObject({ editAllocation: true, topUp: true, editCaps: true });
  });

  it('UI-9 (partial) a drive with no wallet offers create to whoever may create one, and nothing else', () => {
    expect(driveWalletPanels({ viewer: 'org_admin', actions: walletActionsFor('org_admin', { orgDrive: true }), wallet: null }))
      .toMatchObject({ create: true, balance: false, donate: false });
    expect(driveWalletPanels({ viewer: 'member', actions: walletActionsFor('member', { orgDrive: true }), wallet: null }))
      .toMatchObject({ create: false, balance: false });
  });

  it('WAL-4 (partial) donate shows only while the drive accepts donations', () => {
    const closed = projectDriveWallet('member', { ...facts, wallet: { ...facts.wallet, donationsEnabled: false } });
    expect(driveWalletPanels({ viewer: 'member', actions: walletActionsFor('member', { orgDrive: true }), wallet: closed }).donate).toBe(false);
  });
});

describe('walletStatusCopy', () => {
  it('WAL-7 (partial) active, over and paused each say what they mean (canvas WalletStates)', () => {
    expect(walletStatusCopy('active')).toEqual({ label: 'Active', hint: 'Has credits left this month. Calls spend from it.' });
    expect(walletStatusCopy('over')).toEqual({ label: 'Over', hint: "This month's allocation is spent. Calls follow the fallback rule." });
    expect(walletStatusCopy('paused')).toEqual({ label: 'Paused', hint: 'Stopped by whoever funds it. Nothing spends from it until it is resumed, even with credits left.' });
  });
});

describe('parseCreditInput', () => {
  it('UI-12 (partial) a typed credit count becomes cents through the money model; separators are allowed, a "$" is not', () => {
    expect(parseCreditInput('1,200')).toEqual({ ok: true, cents: 1200 });
    expect(parseCreditInput(' 50 ')).toEqual({ ok: true, cents: 50 });
    expect(parseCreditInput('0')).toEqual({ ok: true, cents: 0 });
    expect(parseCreditInput('0', { min: 1 })).toEqual({ ok: false });
    expect(parseCreditInput('$10')).toEqual({ ok: false });
    expect(parseCreditInput('1.5')).toEqual({ ok: false });
    expect(parseCreditInput('-3')).toEqual({ ok: false });
    expect(parseCreditInput('')).toEqual({ ok: false });
  });
});

describe('walletPeriodCopy, fundedByCopy, spendMeterPercent, spendRowLabel', () => {
  it('UI-9 (partial) the period reads in UTC as the wallet resets it', () => {
    expect(walletPeriodCopy('2026-09-01T00:00:00Z', '2026-10-01T00:00:00Z')).toEqual({ range: 'Sep 1 – Sep 30', resets: 'resets Oct 1' });
    expect(walletPeriodCopy(null, null)).toEqual({ range: null, resets: null });
  });

  it('UI-9 (partial) who funds the wallet, by name', () => {
    expect(fundedByCopy({ orgName: 'Northwind Labs', viewerIsFunder: false })).toBe('Funded by Northwind Labs');
    expect(fundedByCopy({ orgName: null, viewerIsFunder: true })).toBe('Funded from your credits');
    expect(fundedByCopy({ orgName: null, viewerIsFunder: false })).toBe("Funded by the drive's owner");
  });

  it('UI-9 (partial) the meter is the share of the allocation spent, bounded', () => {
    expect(spendMeterPercent(1008, 1200)).toBe(84);
    expect(spendMeterPercent(1500, 1200)).toBe(100);
    expect(spendMeterPercent(10, 0)).toBe(0);
  });

  it('SPEND-10 (partial) a spend row is the person by name; the drive\'s own automations (before D-OW-34) read as automations', () => {
    expect(spendRowLabel({ consumerKey: 'user:u1', displayName: 'Priya Nair' })).toBe('Priya Nair');
    expect(spendRowLabel({ consumerKey: 'user:u1', displayName: null })).toBe('Former member');
    expect(spendRowLabel({ consumerKey: 'drive:d1', displayName: null })).toBe('Automations');
  });
});

describe('spendFromRowCopy: a drive wallet in Settings › Usage › Wallets', () => {
  it('UI-10 (partial) an over or paused wallet you spend from says what happens to your calls', () => {
    expect(spendFromRowCopy({ status: 'active', orgName: 'Northwind Labs' })).toBe('Northwind Labs');
    expect(spendFromRowCopy({ status: 'over', orgName: 'Northwind Labs' })).toBe("Northwind Labs · over budget, your calls follow the drive's fallback rule");
    expect(spendFromRowCopy({ status: 'paused', orgName: 'Northwind Labs' })).toBe('Northwind Labs · paused by whoever funds it, your calls move to the next source');
    expect(spendFromRowCopy({ status: 'active', orgName: null })).toBe('Shared drive');
    expect(spendFromRowCopy({ status: 'active', orgName: null, fundedByMe: true })).toBe('From your credits');
    expect(spendFromRowCopy({ status: 'paused', orgName: null, fundedByMe: true })).toBe('From your credits · paused by whoever funds it, your calls move to the next source');
  });
});

describe('orgDriveSummaryCopy: the Organization card on Drive Settings › General', () => {
  it('UI-4 (partial) says who pays for storage and sandbox, and what AI spends, with the allocation when the viewer may see it', () => {
    expect(orgDriveSummaryCopy({ orgName: 'Northwind Labs', wallet: { allocationCredits: '1,200', spentCredits: '1,008', fallbackRule: 'seat_allowance' } })).toBe(
      "Storage and sandbox time are billed to Northwind Labs. AI runs on this drive's wallet (1,200 credits a month from the org pool, 1,008 credits spent), then on each member's seat allowance. Org policies apply, and org admins can manage this drive.",
    );
  });

  it('UI-4 (partial) without a wallet AI runs on seat allowances; a consumer is not shown the allocation (SPEND-9 (partial))', () => {
    expect(orgDriveSummaryCopy({ orgName: 'Northwind Labs', wallet: null })).toBe(
      "Storage and sandbox time are billed to Northwind Labs. AI runs on each member's seat allowance or their own credits. Org policies apply, and org admins can manage this drive.",
    );
    expect(orgDriveSummaryCopy({ orgName: 'Northwind Labs', wallet: { allocationCredits: null, spentCredits: null, fallbackRule: null } })).toBe(
      "Storage and sandbox time are billed to Northwind Labs. AI runs on this drive's wallet. Org policies apply, and org admins can manage this drive.",
    );
  });

  it('UI-4 (partial) a refuse rule says calls stop when the wallet is spent; own credits says so', () => {
    expect(orgDriveSummaryCopy({ orgName: 'N', wallet: { allocationCredits: '10', spentCredits: '0', fallbackRule: 'refuse' } })).toContain("(10 credits a month from the org pool, 0 credits spent); calls stop when it is spent.");
    expect(orgDriveSummaryCopy({ orgName: 'N', wallet: { allocationCredits: '10', spentCredits: '0', fallbackRule: 'own_credits' } })).toContain(", then on each member's own credits.");
  });
});
