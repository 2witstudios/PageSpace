import { describe, it, expect } from 'vitest';
import {
  REFUSAL_REASONS,
  SKIP_REASONS,
  spendRefusalCopy,
  automationSkipCopy,
  refusedCapWindow,
  type RefusedSource,
} from '../spend-refusal-copy';

const product: RefusedSource = { source: 'drive_wallet', label: 'Product wallet', orgName: 'Northwind Labs' };
const seat: RefusedSource = { source: 'seat_allowance', label: 'Northwind Labs seat', orgName: 'Northwind Labs' };
const SEPT = new Date('2026-09-14T10:00:00Z');

describe('spendRefusalCopy: the refusal card', () => {
  it('SPEND-4 (partial) an empty wallet is named, nothing was charged, and the org Owner and Admins control it (D-OW-39: no ask for budget)', () => {
    const copy = spendRefusalCopy({ reason: 'source_empty', source: product, hasOptions: true, now: SEPT });
    expect(copy.title).toBe('Product wallet is empty for September');
    expect(copy.body).toBe("This month's credits on Product wallet have been spent. Nothing was charged. The Northwind Labs Owner and Admins control this budget. You can send this message from another source.");
    expect(`${copy.title} ${copy.body}`).not.toMatch(/ask for|been told/i);
  });

  it("SPEND-4 (partial) a personal drive's wallet is controlled by the drive's owner", () => {
    const copy = spendRefusalCopy({ reason: 'source_empty', source: { ...product, orgName: null }, hasOptions: false, now: SEPT });
    expect(copy.body).toBe("This month's credits on Product wallet have been spent. Nothing was charged. The drive's owner controls this budget.");
  });

  it('WAL-7 (partial) a reached cap names its window, its amount when known, and when it resets (source_cap_reached)', () => {
    expect(spendRefusalCopy({ reason: 'source_cap_reached', source: product, cap: { window: 'daily', capCents: 2000 }, hasOptions: true, now: SEPT }))
      .toEqual({
        title: "You've reached your daily cap on Product wallet",
        body: 'Your cap here is 2,000 credits a day and resets tomorrow. Nothing was charged. The Northwind Labs Owner and Admins set caps on this wallet. You can send this message from another source.',
      });
    const monthly = spendRefusalCopy({ reason: 'source_cap_reached', source: product, cap: { window: 'monthly', capCents: null }, hasOptions: false, now: SEPT });
    expect(monthly.title).toBe("You've reached your monthly cap on Product wallet");
    expect(monthly.body).toBe('Your cap here resets on October 1. Nothing was charged. The Northwind Labs Owner and Admins set caps on this wallet.');
    expect(spendRefusalCopy({ reason: 'source_cap_reached', source: { ...product, orgName: null }, hasOptions: false, now: SEPT }).body)
      .toBe("Your cap here resets soon. Nothing was charged. The drive's owner sets caps on this wallet.");
  });

  it('WAL-7 (partial) a seat refused by its allowance says the allowance, not the pool, ran out', () => {
    const copy = spendRefusalCopy({ reason: 'source_cap_reached', source: seat, hasOptions: true, now: SEPT });
    expect(copy.title).toBe("You've used your Northwind Labs seat allowance for September");
    expect(copy.body).toContain('The Northwind Labs Owner and Admins set seat allowances.');
  });

  it('SPEND-4 (partial) every refusal reason has copy that says nothing was charged; an unknown wire reason still reads safely', () => {
    for (const reason of [...REFUSAL_REASONS, 'something_new']) {
      const copy = spendRefusalCopy({ reason, source: product, hasOptions: false, now: SEPT });
      expect(copy.title.length).toBeGreaterThan(0);
      expect(copy.body).toContain('Nothing was charged.');
    }
  });

  it('SPEND-4 (partial) a paused wallet, a guest refusal and a stale choice read as what happened', () => {
    expect(spendRefusalCopy({ reason: 'source_paused', source: product, hasOptions: false, now: SEPT }).title).toBe('Product wallet is paused');
    expect(spendRefusalCopy({ reason: 'guest_drive_wallet_off', source: product, hasOptions: false, now: SEPT }).title).toBe("Guests can't spend from Product wallet");
    expect(spendRefusalCopy({ reason: 'chosen_wallet_unavailable', source: null, hasOptions: true, now: SEPT }).title).toBe('The source chosen for this conversation is no longer available');
    expect(spendRefusalCopy({ reason: 'no_source_chosen', source: null, hasOptions: true, now: SEPT }).title).toBe('Choose what to spend from');
  });

  it('UI-12 (partial) refusal copy never carries a currency symbol', () => {
    for (const reason of REFUSAL_REASONS) {
      const copy = spendRefusalCopy({ reason, source: product, cap: { window: 'daily', capCents: 5000 }, hasOptions: true, now: SEPT });
      expect(`${copy.title} ${copy.body}`).not.toContain('$');
    }
  });
});

describe('automationSkipCopy: why a run was skipped', () => {
  it('SPEND-6 (partial) every skip reason has copy naming what stopped the run', () => {
    expect(automationSkipCopy({ reason: 'drive_wallet_empty', walletLabel: 'Product wallet', creatorName: 'Priya Nair', orgName: 'Northwind Labs' }))
      .toBe('Skipped: Product wallet was empty.');
    expect(automationSkipCopy({ reason: 'drive_wallet_paused', walletLabel: 'Product wallet', creatorName: null, orgName: null }))
      .toBe('Skipped: Product wallet is paused.');
    expect(automationSkipCopy({ reason: 'no_drive_wallet', walletLabel: null, creatorName: null, orgName: null }))
      .toBe('Skipped: this drive has no wallet to run automations from.');
    expect(automationSkipCopy({ reason: 'creator_departed', walletLabel: null, creatorName: 'Priya Nair', orgName: 'Northwind Labs' }))
      .toBe('Skipped: Priya Nair is no longer in Northwind Labs, so nothing runs as them.');
    for (const reason of SKIP_REASONS) {
      expect(automationSkipCopy({ reason, walletLabel: null, creatorName: null, orgName: null })).toMatch(/^Skipped: /);
    }
  });

  it("SPEND-6 (partial) a run refused at its creator's cap counts against the creator (D-OW-34)", () => {
    expect(automationSkipCopy({ reason: 'source_cap_reached', walletLabel: 'Product wallet', creatorName: 'Priya Nair', orgName: 'Northwind Labs' }))
      .toBe("Skipped: Priya Nair reached their cap on Product wallet.");
    expect(automationSkipCopy({ reason: 'unknown_reason', walletLabel: null, creatorName: null, orgName: null }))
      .toBe('Skipped: no source could pay for this run.');
  });
});

describe('refusedCapWindow', () => {
  it('WAL-7 (partial) the window that ran out is the one with nothing left, daily first', () => {
    expect(refusedCapWindow({ dailyRemainingCents: 0, monthlyRemainingCents: 0 })).toBe('daily');
    expect(refusedCapWindow({ dailyRemainingCents: 5, monthlyRemainingCents: 0 })).toBe('monthly');
    expect(refusedCapWindow({ dailyRemainingCents: null, monthlyRemainingCents: 0 })).toBe('monthly');
    expect(refusedCapWindow({ dailyRemainingCents: null, monthlyRemainingCents: null })).toBeNull();
    expect(refusedCapWindow(null)).toBeNull();
  });
});
