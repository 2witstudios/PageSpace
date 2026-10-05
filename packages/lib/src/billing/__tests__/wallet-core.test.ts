import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { centsFromCredits } from '../money-model';
import type { Balance } from '../credit-core';
import {
  resolveSpendSource,
  effectiveSpendPolicy,
  childSpendableCents,
  legSpendableCents,
  allocateWalletSpend,
  settleOvershoot,
  walletSourceKind,
  chosenSourceCharge,
  walletStatusFor,
  shouldNotifyFunderOfDebt,
  renewWalletAllocation,
  evaluateCaps,
  capThresholdsReached,
  planConsumerCapWrite,
  DEFAULT_CONSUMER_CAPS,
  utcDayStartMs,
  utcMonthStartMs,
  governingAllocationPeriodStartMs,
  isAllocationResetDue,
  entitlementTierFor,
  DEFAULT_SEAT_ALLOWANCE_CENTS,
  seatAllowanceCents,
  seatSpentCents,
  seatCapCheck,
  seatOvershootDeltaMillicents,
  seatCountedMillicents,
  seatLegSpendableCents,
  seatPeriodStartMs,
  type ResolveSpendSourceInput,
  type SpendLeg,
  type SpendResolution,
  type WalletFunds,
  debtNoticeFunder,
  debtNoticePeriodStartMs,
} from '../wallet-core';

// Northwind Labs fixture (Sequence Spec Part 2): Product's wallet holds 1,200 credits,
// Engineering's 900 is over, the pool holds 9,000. Marcus is a member, Chris Rowe a guest.
// Whole cents, as every wallet-core output is.
const c = (credits: number): number => Math.round(centsFromCredits(credits));
const RESERVE = c(5);

const productWallet = (spendable: number, status: SpendLeg['status'] = 'active'): SpendLeg => ({
  walletId: 'w-product',
  status,
  spendableCents: spendable,
});
const marcusSeat = (spendable: number, status: SpendLeg['status'] = 'active'): SpendLeg => ({
  walletId: 'w-northwind-pool',
  status,
  spendableCents: spendable,
});
const marcusPersonal = (spendable: number, status: SpendLeg['status'] = 'active'): SpendLeg => ({
  walletId: 'w-marcus',
  status,
  spendableCents: spendable,
});

const marcus = { kind: 'person', userId: 'u-marcus', isGuest: false } as const;
const chris = { kind: 'person', userId: 'u-chris', isGuest: true } as const;
const weeklyDigest = { kind: 'automation', driveId: 'd-product' } as const;

const base = (over: Partial<ResolveSpendSourceInput> = {}): ResolveSpendSourceInput => ({
  actor: marcus,
  driveWallet: productWallet(c(1200)),
  seatAllowance: marcusSeat(c(100)),
  personal: marcusPersonal(c(500)),
  chosen: 'drive_wallet',
  driveRule: { fallback: 'refuse', guestsMaySpendDriveWallet: false },
  userOverride: { alwaysOwnCredits: false, alwaysOwnCreditsInDrive: false },
  reservationCents: RESERVE,
  ...over,
});

const spend = (
  source: 'drive_wallet' | 'seat_allowance' | 'own_credits',
  walletId: string,
  fallbackFrom: 'drive_wallet' | 'seat_allowance' | 'own_credits' | null = null,
  fallbackFromWalletId: string | null = null,
): SpendResolution => ({ kind: 'spend', source, walletId, fallbackApplied: fallbackFrom !== null, fallbackFrom, fallbackFromWalletId });

describe('resolveSpendSource — the chosen source', () => {
  it.each([
    ['drive wallet', 'drive_wallet', spend('drive_wallet', 'w-product')],
    ['seat allowance', 'seat_allowance', spend('seat_allowance', 'w-northwind-pool')],
    ['own credits', 'own_credits', spend('own_credits', 'w-marcus')],
  ] as const)('SPEND-1 (partial) a member who chose the %s spends exactly that one source', (_label, chosen, expected) => {
    expect(resolveSpendSource(base({ chosen }))).toEqual(expected);
  });

  it('SPEND-1 (partial) no chosen source refuses and offers the covered options, charging nothing', () => {
    expect(resolveSpendSource(base({ chosen: null }))).toEqual({
      kind: 'refuse',
      source: null,
      reason: 'no_source_chosen',
      options: [
        { source: 'drive_wallet', walletId: 'w-product' },
        { source: 'seat_allowance', walletId: 'w-northwind-pool' },
        { source: 'own_credits', walletId: 'w-marcus' },
      ],
      chargeCents: 0,
    });
  });

  it('SPEND-1 (partial) a personal drive has no seat allowance, so it is never offered', () => {
    const result = resolveSpendSource(base({ chosen: null, seatAllowance: null }));
    expect(result.kind === 'refuse' && result.options.map((o) => o.source)).toEqual(['drive_wallet', 'own_credits']);
  });
});

describe('resolveSpendSource — an empty chosen source', () => {
  it.each([
    [
      'drive wallet is empty',
      base({ driveWallet: productWallet(0) }),
      'drive_wallet',
      'source_empty',
      [
        { source: 'seat_allowance', walletId: 'w-northwind-pool' },
        { source: 'own_credits', walletId: 'w-marcus' },
      ],
    ],
    [
      'drive wallet cannot cover the reservation',
      base({ driveWallet: productWallet(RESERVE - 1) }),
      'drive_wallet',
      'source_empty',
      [
        { source: 'seat_allowance', walletId: 'w-northwind-pool' },
        { source: 'own_credits', walletId: 'w-marcus' },
      ],
    ],
    [
      'drive wallet is paused by its kill switch',
      base({ driveWallet: productWallet(c(1200), 'paused') }),
      'drive_wallet',
      'source_paused',
      [
        { source: 'seat_allowance', walletId: 'w-northwind-pool' },
        { source: 'own_credits', walletId: 'w-marcus' },
      ],
    ],
    [
      'Engineering wallet is over (debt, nothing spendable)',
      base({ driveWallet: { walletId: 'w-engineering', status: 'over', spendableCents: 0 } }),
      'drive_wallet',
      'source_empty',
      [
        { source: 'seat_allowance', walletId: 'w-northwind-pool' },
        { source: 'own_credits', walletId: 'w-marcus' },
      ],
    ],
    [
      'own credits are empty and the drive wallet is also empty',
      base({ chosen: 'own_credits', personal: marcusPersonal(0), driveWallet: productWallet(0) }),
      'own_credits',
      'source_empty',
      [{ source: 'seat_allowance', walletId: 'w-northwind-pool' }],
    ],
    [
      'the chosen source does not exist here',
      base({ chosen: 'seat_allowance', seatAllowance: null }),
      'seat_allowance',
      'source_unavailable',
      [
        { source: 'drive_wallet', walletId: 'w-product' },
        { source: 'own_credits', walletId: 'w-marcus' },
      ],
    ],
  ] as const)(
    'SPEND-4 (partial) with no fallback rule, when the %s, the call refuses, names the source, offers the rest, and charges zero',
    (_label, input, source, reason, options) => {
      expect(resolveSpendSource(input)).toEqual({ kind: 'refuse', source, reason, options, chargeCents: 0 });
    },
  );

  it.each([
    ['seat_allowance', 'w-northwind-pool'],
    ['own_credits', 'w-marcus'],
  ] as const)('SPEND-4 (partial) a drive rule allowing %s falls back to it and says so', (fallback, walletId) => {
    expect(
      resolveSpendSource(
        base({ driveWallet: productWallet(0), driveRule: { fallback, guestsMaySpendDriveWallet: false } }),
      ),
    ).toEqual(spend(fallback, walletId, 'drive_wallet', 'w-product'));
  });

  it('WAL-6 (partial) a fallback names the wallet it moved off, so the settle can land overshoot where that choice would have', () => {
    const result = resolveSpendSource(
      base({ chosen: 'seat_allowance', seatAllowance: marcusSeat(0), driveRule: { fallback: 'own_credits', guestsMaySpendDriveWallet: false } }),
    );
    expect(result).toEqual(spend('own_credits', 'w-marcus', 'seat_allowance', 'w-northwind-pool'));
  });

  it.each([
    ['the fallback source is empty too', base({ driveWallet: productWallet(0), seatAllowance: marcusSeat(0) })],
    ['the fallback source is paused', base({ driveWallet: productWallet(0), seatAllowance: marcusSeat(c(100), 'paused') })],
    ['the fallback source does not exist', base({ driveWallet: productWallet(0), seatAllowance: null })],
  ])('SPEND-4 (partial) fallback still refuses with zero charge when %s', (_label, input) => {
    const result = resolveSpendSource({ ...input, driveRule: { fallback: 'seat_allowance', guestsMaySpendDriveWallet: false } });
    expect(result).toMatchObject({ kind: 'refuse', source: 'drive_wallet', chargeCents: 0 });
  });

  it('SPEND-4 (partial) a covered chosen source never falls back, even when the rule allows it', () => {
    expect(
      resolveSpendSource(base({ driveRule: { fallback: 'own_credits', guestsMaySpendDriveWallet: false } })),
    ).toEqual(spend('drive_wallet', 'w-product'));
  });

  it('SPEND-4 (partial) a fallback rule naming the chosen source itself refuses rather than retrying it', () => {
    const result = resolveSpendSource(
      base({ chosen: 'seat_allowance', seatAllowance: marcusSeat(0), driveRule: { fallback: 'seat_allowance', guestsMaySpendDriveWallet: false } }),
    );
    expect(result).toMatchObject({ kind: 'refuse', source: 'seat_allowance', reason: 'source_empty', chargeCents: 0 });
  });
});

describe('resolveSpendSource — "always my own credits"', () => {
  it.each([
    ['the global switch', { alwaysOwnCredits: true, alwaysOwnCreditsInDrive: false }],
    ['the per-drive switch', { alwaysOwnCredits: false, alwaysOwnCreditsInDrive: true }],
  ])('SPEND-5 (partial) %s spends own credits whatever was chosen', (_label, userOverride) => {
    for (const chosen of ['drive_wallet', 'seat_allowance', 'own_credits', null] as const) {
      expect(resolveSpendSource(base({ chosen, userOverride }))).toEqual(spend('own_credits', 'w-marcus'));
    }
  });

  it('SPEND-5 (partial) the override is absolute: empty own credits refuse with zero charge and never fall back to the drive', () => {
    expect(
      resolveSpendSource(
        base({
          personal: marcusPersonal(0),
          userOverride: { alwaysOwnCredits: true, alwaysOwnCreditsInDrive: false },
          driveRule: { fallback: 'seat_allowance', guestsMaySpendDriveWallet: true },
        }),
      ),
    ).toEqual({ kind: 'refuse', source: 'own_credits', reason: 'source_empty', options: [], chargeCents: 0 });
  });
});

describe('resolveSpendSource — guests (D-OW-4)', () => {
  it('D-OW-4 a guest cannot spend the drive wallet by default and is offered own credits only', () => {
    expect(resolveSpendSource(base({ actor: chris, personal: { walletId: 'w-chris', status: 'active', spendableCents: c(50) } }))).toEqual({
      kind: 'refuse',
      source: 'drive_wallet',
      reason: 'guest_drive_wallet_off',
      options: [{ source: 'own_credits', walletId: 'w-chris' }],
      chargeCents: 0,
    });
  });

  it('D-OW-4 the per-drive switch lets a guest spend the drive wallet', () => {
    expect(
      resolveSpendSource(base({ actor: chris, driveRule: { fallback: 'refuse', guestsMaySpendDriveWallet: true } })),
    ).toEqual(spend('drive_wallet', 'w-product'));
  });

  it('D-OW-4 a guest holds no seat: a seat allowance is never spent or offered, even as a fallback', () => {
    const personal = { walletId: 'w-chris', status: 'active', spendableCents: 0 } as const;
    expect(resolveSpendSource(base({ actor: chris, chosen: 'seat_allowance', personal }))).toMatchObject({
      kind: 'refuse',
      reason: 'source_unavailable',
      options: [],
    });
    expect(
      resolveSpendSource(
        base({
          actor: chris,
          chosen: 'own_credits',
          personal,
          driveRule: { fallback: 'seat_allowance', guestsMaySpendDriveWallet: false },
        }),
      ),
    ).toMatchObject({ kind: 'refuse', source: 'own_credits', reason: 'source_empty', chargeCents: 0 });
  });

  it.each(['refuse', 'seat_allowance', 'own_credits'] as const)(
    'D-OW-4 a guest with the switch off and empty own credits is never offered a funded drive wallet (fallback %s)',
    (fallback) => {
      expect(
        resolveSpendSource(
          base({
            actor: chris,
            chosen: 'own_credits',
            driveWallet: productWallet(c(1200)),
            personal: { walletId: 'w-chris', status: 'active', spendableCents: 0 },
            seatAllowance: null,
            driveRule: { fallback, guestsMaySpendDriveWallet: false },
          }),
        ),
      ).toEqual({ kind: 'refuse', source: 'own_credits', reason: 'source_empty', options: [], chargeCents: 0 });
    },
  );
});

describe('resolveSpendSource — automations', () => {
  it('SPEND-6 (partial) an automation spends the drive wallet, ignoring any chosen source or override', () => {
    expect(
      resolveSpendSource(
        base({ actor: weeklyDigest, chosen: 'own_credits', userOverride: { alwaysOwnCredits: true, alwaysOwnCreditsInDrive: true } }),
      ),
    ).toEqual(spend('drive_wallet', 'w-product'));
  });

  it.each([
    ['empty', productWallet(0), 'drive_wallet_empty', 'w-product'],
    ['short of the reservation', productWallet(RESERVE - 1), 'drive_wallet_empty', 'w-product'],
    ['paused', productWallet(c(1200), 'paused'), 'drive_wallet_paused', 'w-product'],
    ['missing', null, 'no_drive_wallet', null],
  ] as const)(
    'SPEND-6 (partial) an automation whose drive wallet is %s skips and never falls back to a person',
    (_label, driveWallet, reason, walletId) => {
      for (const fallback of ['refuse', 'seat_allowance', 'own_credits'] as const) {
        expect(
          resolveSpendSource(
            base({
              actor: weeklyDigest,
              driveWallet,
              chosen: null,
              driveRule: { fallback, guestsMaySpendDriveWallet: true },
            }),
          ),
        ).toEqual({ kind: 'skip', reason, walletId, chargeCents: 0 });
      }
    },
  );
});

describe('effectiveSpendPolicy', () => {
  const org = { seatAllowanceCents: c(100), fallback: 'seat_allowance' } as const;

  it.each([
    ['no drive override inherits the org policy', null, org],
    ['a lower drive seat allowance applies', { seatAllowanceCents: c(40) }, { ...org, seatAllowanceCents: c(40) }],
    ['a higher drive seat allowance is clamped to the org amount', { seatAllowanceCents: c(400) }, org],
  ] as const)('POL-7 (partial) %s', (_label, drive, expected) => {
    expect(effectiveSpendPolicy(org, drive)).toEqual(expected);
  });

  it.each([
    ['seat_allowance', 'seat_allowance'],
    ['own_credits', 'own_credits'],
    ['refuse', 'refuse'],
  ] as const)('POL-7 (partial) a drive rule equal to the org rule applies (%s)', (orgRule, driveRule) => {
    expect(effectiveSpendPolicy({ ...org, fallback: orgRule }, { fallback: driveRule }).fallback).toBe(orgRule);
  });

  it.each(['seat_allowance', 'own_credits'] as const)('POL-7 (partial) a drive rule of refuse applies (org %s)', (orgRule) => {
    expect(effectiveSpendPolicy({ ...org, fallback: orgRule }, { fallback: 'refuse' }).fallback).toBe('refuse');
  });

  it.each([
    ['seat_allowance', 'own_credits'],
    ['own_credits', 'seat_allowance'],
  ] as const)(
    'POL-7 (partial) a drive rule that swaps seat allowance and own credits resolves to refuse (org %s, drive %s)',
    (orgRule, driveRule) => {
      expect(effectiveSpendPolicy({ ...org, fallback: orgRule }, { fallback: driveRule }).fallback).toBe('refuse');
    },
  );

  it('POL-7 (partial) a drive cannot loosen an org that refuses', () => {
    expect(effectiveSpendPolicy({ seatAllowanceCents: null, fallback: 'refuse' }, { fallback: 'own_credits' })).toEqual({
      seatAllowanceCents: null,
      fallback: 'refuse',
    });
  });

  it('POL-7 (partial) an unlimited org seat allowance takes the drive amount', () => {
    expect(effectiveSpendPolicy({ seatAllowanceCents: null, fallback: 'refuse' }, { seatAllowanceCents: c(30) })).toEqual({
      seatAllowanceCents: c(30),
      fallback: 'refuse',
    });
  });
});

const productFunds = (over: Partial<WalletFunds> = {}): WalletFunds => ({
  allocationCents: c(1200),
  allocationSpentCents: 0,
  topupLegs: [],
  debtCents: 0,
  ...over,
});
const pool = (monthlyCents: number, topupCents = 0, debtCents = 0): Balance => ({ monthlyCents, topupCents, debtCents });

describe('allocation math', () => {
  it.each([
    ['full allocation, rich parent', productFunds(), c(9000), c(1200)],
    ['part-spent allocation', productFunds({ allocationSpentCents: c(1008) }), c(9000), c(192)],
    ['parent poorer than the allocation', productFunds(), c(300), c(300)],
    ['parent in debt', productFunds(), -c(50), 0],
    ['over-spent allocation never goes negative', productFunds({ allocationSpentCents: c(1300) }), c(9000), 0],
    [
      'top-up and donation legs add to the allocation',
      productFunds({
        topupLegs: [
          { legId: 'l1', funder: 'owner', donorUserId: null, remainingCents: c(100) },
          { legId: 'l2', funder: 'donation', donorUserId: 'u-lena', remainingCents: c(25) },
        ],
      }),
      c(9000),
      c(1325),
    ],
    ['wallet debt nets from what is spendable', productFunds({ allocationSpentCents: c(1200), debtCents: c(40) }), c(9000), 0],
    ['a non-finite parent balance covers nothing from the allocation', productFunds(), Number.NaN, 0],
  ])('WAL-3 (partial) childSpendableCents: %s', (_label, funds, parentAvailable, expected) => {
    expect(childSpendableCents(funds, parentAvailable)).toBe(expected);
  });

  it('WAL-3 (partial) setting an allocation moves nothing out of the parent: spend draws against it as it happens', () => {
    const parent = pool(c(9000));
    const zero = allocateWalletSpend({ parent, wallet: productFunds(), amountCents: 0 });
    expect(zero.parent.monthlyCents).toBe(c(9000));

    const r = allocateWalletSpend({ parent, wallet: productFunds(), amountCents: c(300) });
    expect(r.parent).toMatchObject({ monthlyCents: c(8700), topupCents: 0 });
    expect(r.wallet.allocationSpentCents).toBe(c(300));
    expect(r.allocationDrawCents).toBe(c(300));
    expect(r.shortfallCents).toBe(0);
    // Input objects are not mutated.
    expect(parent.monthlyCents).toBe(c(9000));
  });

  it('WAL-3 (partial) allocation draws first, then top-up legs in the order given, each leg tracked separately (D-OW-13)', () => {
    const wallet = productFunds({
      allocationSpentCents: c(1150),
      topupLegs: [
        { legId: 'owner-1', funder: 'owner', donorUserId: null, remainingCents: c(30) },
        { legId: 'don-lena', funder: 'donation', donorUserId: 'u-lena', remainingCents: c(40) },
      ],
    });
    const r = allocateWalletSpend({ parent: pool(c(9000)), wallet, amountCents: c(100) });
    expect(r.allocationDrawCents).toBe(c(50));
    expect(r.legDraws).toEqual([
      { legId: 'owner-1', cents: c(30) },
      { legId: 'don-lena', cents: c(20) },
    ]);
    expect(r.wallet.topupLegs).toEqual([
      { legId: 'owner-1', funder: 'owner', donorUserId: null, remainingCents: 0 },
      { legId: 'don-lena', funder: 'donation', donorUserId: 'u-lena', remainingCents: c(20) },
    ]);
    expect(r.parent.monthlyCents).toBe(c(8950));
    expect(r.appliedCents).toBe(c(100));
    expect(r.shortfallCents).toBe(0);
  });

  it('WAL-3 (partial) a top-up lasts until spent: it survives an allocation renewal untouched', () => {
    const legs = [{ legId: 'owner-1', funder: 'owner', donorUserId: null, remainingCents: c(30) }] as const;
    const renewed = renewWalletAllocation(productFunds({ allocationSpentCents: c(1200), topupLegs: legs }), c(1200));
    expect(renewed.topupLegs).toEqual(legs);
    expect(renewed.allocationSpentCents).toBe(0);
  });

  it('WAL-3 (partial) the allocation draw is capped by what the parent can cover; the rest is shortfall', () => {
    const r = allocateWalletSpend({ parent: pool(c(20), c(10)), wallet: productFunds(), amountCents: c(50) });
    expect(r.allocationDrawCents).toBe(c(30));
    expect(r.parent).toMatchObject({ monthlyCents: 0, topupCents: 0 });
    expect(r.shortfallCents).toBe(c(20));
    expect(r.appliedCents).toBe(c(30));
  });

  it.each([
    ['wallet funds', c(1200), { dailyRemainingCents: null, monthlyRemainingCents: null }, c(1200)],
    ['a daily cap below funds', c(1200), { dailyRemainingCents: c(10), monthlyRemainingCents: c(100) }, c(10)],
    ['a monthly cap below funds', c(1200), { dailyRemainingCents: null, monthlyRemainingCents: c(7) }, c(7)],
    ['funds below the caps', c(3), { dailyRemainingCents: c(10), monthlyRemainingCents: c(100) }, c(3)],
    ['negative funds', -c(3), { dailyRemainingCents: null, monthlyRemainingCents: null }, 0],
  ])('WAL-7 (partial) legSpendableCents is the least of %s and the consumer caps', (_label, funds, caps, expected) => {
    expect(legSpendableCents(funds, caps)).toBe(expected);
  });
});

describe('settleOvershoot', () => {
  it.each([
    [
      'drive wallet, default funder choice absorbs into the parent',
      { source: 'drive_wallet', chargedWalletId: 'w-product', parentWalletId: 'w-northwind-pool', funderChoice: 'absorb_to_parent' },
      { kind: 'parent_debt', walletId: 'w-northwind-pool', cents: c(3) },
    ],
    [
      'drive wallet, funder chose wallet debt',
      { source: 'drive_wallet', chargedWalletId: 'w-product', parentWalletId: 'w-northwind-pool', funderChoice: 'wallet_debt' },
      { kind: 'wallet_debt', walletId: 'w-product', cents: c(3) },
    ],
    [
      'seat allowance lands on the pool that funds it',
      { source: 'seat_allowance', chargedWalletId: 'w-northwind-pool', parentWalletId: null, funderChoice: 'wallet_debt' },
      { kind: 'root_debt', walletId: 'w-northwind-pool', cents: c(3) },
    ],
    [
      'own credits land on the consumer who chose them',
      { source: 'own_credits', chargedWalletId: 'w-marcus', parentWalletId: null, funderChoice: 'absorb_to_parent' },
      { kind: 'root_debt', walletId: 'w-marcus', cents: c(3) },
    ],
  ] as const)('WAL-6 (partial) overshoot lands per funder choice: %s', (_label, input, expected) => {
    expect(settleOvershoot({ ...input, overshootCents: c(3), fallbackFrom: null })).toEqual(expected);
  });

  const ownCreditsFallback = {
    source: 'own_credits',
    chargedWalletId: 'w-marcus',
    parentWalletId: null,
    funderChoice: 'absorb_to_parent',
    overshootCents: c(3),
  } as const;

  it.each([
    [
      'from the drive wallet, funder absorbs into the parent',
      { source: 'drive_wallet', walletId: 'w-product', parentWalletId: 'w-northwind-pool', funderChoice: 'absorb_to_parent' },
      { kind: 'parent_debt', walletId: 'w-northwind-pool', cents: c(3) },
    ],
    [
      'from the drive wallet, funder chose wallet debt',
      { source: 'drive_wallet', walletId: 'w-product', parentWalletId: 'w-northwind-pool', funderChoice: 'wallet_debt' },
      { kind: 'wallet_debt', walletId: 'w-product', cents: c(3) },
    ],
    [
      'from the seat allowance',
      { source: 'seat_allowance', walletId: 'w-northwind-pool', parentWalletId: null, funderChoice: 'wallet_debt' },
      { kind: 'root_debt', walletId: 'w-northwind-pool', cents: c(3) },
    ],
  ] as const)(
    'WAL-6 (partial) after a drive-rule fallback onto own credits, overshoot lands where the chosen source would put it, never on the consumer: %s',
    (_label, fallbackFrom, expected) => {
      const landing = settleOvershoot({ ...ownCreditsFallback, fallbackFrom });
      expect(landing).toEqual(expected);
      expect(landing.kind === 'none' ? null : landing.walletId).not.toBe('w-marcus');
    },
  );

  it('WAL-6 (partial) a drive-wallet overshoot never lands on the consumer, whatever the funder chose', () => {
    for (const funderChoice of ['absorb_to_parent', 'wallet_debt'] as const) {
      const landing = settleOvershoot({
        source: 'drive_wallet',
        chargedWalletId: 'w-product',
        parentWalletId: 'w-northwind-pool',
        funderChoice,
        overshootCents: c(9),
        fallbackFrom: null,
      });
      expect(landing.kind === 'none' ? null : landing.walletId).not.toBe('w-marcus');
      expect(landing.kind).not.toBe('root_debt');
    }
  });

  it.each([0, -5, Number.NaN])('WAL-6 (partial) no overshoot (%s) lands nothing', (overshootCents) => {
    expect(
      settleOvershoot({ source: 'drive_wallet', chargedWalletId: 'w-product', parentWalletId: 'p', funderChoice: 'wallet_debt', overshootCents, fallbackFrom: null }),
    ).toEqual({ kind: 'none', cents: 0 });
  });

  it.each([
    [{ paused: false, debtCents: 0 }, 'active'],
    [{ paused: false, debtCents: c(40) }, 'over'],
    [{ paused: true, debtCents: c(40) }, 'paused'],
    [{ paused: true, debtCents: 0 }, 'paused'],
  ] as const)('WAL-6 (partial) walletStatusFor(%o) is %s', (input, expected) => {
    expect(walletStatusFor(input)).toBe(expected);
  });

  const periodStart = Date.UTC(2026, 8, 1);
  it.each([
    ['debt, never notified', c(40), null, true],
    ['debt, notified last period', c(40), Date.UTC(2026, 7, 20), true],
    ['debt, already notified this period', c(40), Date.UTC(2026, 8, 3), false],
    ['no debt', 0, null, false],
  ])('WAL-6 (partial) the funder is notified once per period: %s', (_label, debtCents, lastNotifiedAtMs, expected) => {
    expect(shouldNotifyFunderOfDebt({ debtCents, periodStartMs: periodStart, lastNotifiedAtMs })).toBe(expected);
  });

  it.each([
    ['debt smaller than the allocation is netted from it', c(40), c(1200), { allocationSpentCents: c(40), debtCents: 0 }],
    ['debt larger than the allocation clears when it lands', c(1500), c(1200), { allocationSpentCents: c(1200), debtCents: 0 }],
    ['no debt starts the period fresh', 0, c(1200), { allocationSpentCents: 0, debtCents: 0 }],
  ])('WAL-6 (partial) renewWalletAllocation: %s', (_label, debtCents, allocation, expected) => {
    const renewed = renewWalletAllocation(productFunds({ allocationSpentCents: c(1100), debtCents }), allocation);
    expect(renewed).toMatchObject({ allocationCents: allocation, ...expected });
  });
});

describe('evaluateCaps', () => {
  const TEN_A_DAY_HUNDRED_A_MONTH = { dailyCents: c(10), monthlyCents: c(100) };
  it('WAL-7 (partial) [D-OW-31] defaults on enable are 50 credits a day and 1,000 a month, from the one credit definition', () => {
    expect(DEFAULT_CONSUMER_CAPS).toEqual({ dailyCents: Math.round(centsFromCredits(50)), monthlyCents: Math.round(centsFromCredits(1_000)) });
  });

  it.each([
    ['unset caps are unlimited within the wallet', { dailyCents: null, monthlyCents: null }, { dailySpentCents: c(9999), monthlySpentCents: c(99999), dailyReservedCents: 0, monthlyReservedCents: 0 }, c(5),
      { allowed: true, reason: 'ok', dailyRemainingCents: null, monthlyRemainingCents: null }],
    ['within both caps', TEN_A_DAY_HUNDRED_A_MONTH, { dailySpentCents: c(4), monthlySpentCents: c(50), dailyReservedCents: 0, monthlyReservedCents: 0 }, c(5),
      { allowed: true, reason: 'ok', dailyRemainingCents: c(6), monthlyRemainingCents: c(50) }],
    ['exactly reaching the daily cap is allowed', TEN_A_DAY_HUNDRED_A_MONTH, { dailySpentCents: c(5), monthlySpentCents: c(5), dailyReservedCents: 0, monthlyReservedCents: 0 }, c(5),
      { allowed: true, reason: 'ok', dailyRemainingCents: c(5), monthlyRemainingCents: c(95) }],
    ['past the daily cap', TEN_A_DAY_HUNDRED_A_MONTH, { dailySpentCents: c(6), monthlySpentCents: c(6), dailyReservedCents: 0, monthlyReservedCents: 0 }, c(5),
      { allowed: false, reason: 'daily_cap_exceeded', dailyRemainingCents: c(4), monthlyRemainingCents: c(94) }],
    ['past the monthly cap with room today', TEN_A_DAY_HUNDRED_A_MONTH, { dailySpentCents: 0, monthlySpentCents: c(98), dailyReservedCents: 0, monthlyReservedCents: 0 }, c(5),
      { allowed: false, reason: 'monthly_cap_exceeded', dailyRemainingCents: c(10), monthlyRemainingCents: c(2) }],
    ['over both reports the daily cap first', TEN_A_DAY_HUNDRED_A_MONTH, { dailySpentCents: c(12), monthlySpentCents: c(120), dailyReservedCents: 0, monthlyReservedCents: 0 }, c(5),
      { allowed: false, reason: 'daily_cap_exceeded', dailyRemainingCents: 0, monthlyRemainingCents: 0 }],
    ['an in-flight reservation counts against the daily cap', TEN_A_DAY_HUNDRED_A_MONTH,
      { dailySpentCents: c(4), monthlySpentCents: c(4), dailyReservedCents: c(5), monthlyReservedCents: c(5) }, c(5),
      { allowed: false, reason: 'daily_cap_exceeded', dailyRemainingCents: c(1), monthlyRemainingCents: c(91) }],
    ['an in-flight reservation counts against the monthly cap', { dailyCents: null, monthlyCents: c(100) },
      { dailySpentCents: 0, monthlySpentCents: c(90), dailyReservedCents: 0, monthlyReservedCents: c(8) }, c(5),
      { allowed: false, reason: 'monthly_cap_exceeded', dailyRemainingCents: null, monthlyRemainingCents: c(2) }],
    ['reservations that still fit are allowed', TEN_A_DAY_HUNDRED_A_MONTH,
      { dailySpentCents: c(2), monthlySpentCents: c(2), dailyReservedCents: c(3), monthlyReservedCents: c(3) }, c(5),
      { allowed: true, reason: 'ok', dailyRemainingCents: c(5), monthlyRemainingCents: c(95) }],
  ] as const)('WAL-7 (partial) %s', (_label, caps, usage, reservationCents, expected) => {
    expect(evaluateCaps({ caps, usage, reservationCents })).toEqual(expected);
  });

  it.each([
    ['a non-finite reservation', TEN_A_DAY_HUNDRED_A_MONTH, Number.NaN, 'daily_cap_exceeded'],
    ['a non-finite reservation under a monthly cap only', { dailyCents: null, monthlyCents: c(100) }, Number.NaN, 'monthly_cap_exceeded'],
    ['a non-finite daily cap', { dailyCents: Number.NaN, monthlyCents: null }, c(5), 'daily_cap_exceeded'],
    ['a non-finite monthly cap', { dailyCents: null, monthlyCents: Number.POSITIVE_INFINITY }, c(5), 'monthly_cap_exceeded'],
  ] as const)('WAL-7 (partial) evaluateCaps fails closed on %s', (_label, caps, reservationCents, reason) => {
    const usage = { dailySpentCents: c(1), monthlySpentCents: c(1), dailyReservedCents: 0, monthlyReservedCents: 0 };
    expect(evaluateCaps({ caps, usage, reservationCents })).toMatchObject({ allowed: false, reason });
  });

  it('WAL-7 (partial) unset caps do not refuse a non-finite reservation (the wallet coverage check does)', () => {
    const usage = { dailySpentCents: 0, monthlySpentCents: 0, dailyReservedCents: 0, monthlyReservedCents: 0 };
    expect(evaluateCaps({ caps: { dailyCents: null, monthlyCents: null }, usage, reservationCents: Number.NaN }).allowed).toBe(true);
    expect(resolveSpendSource(base({ reservationCents: Number.NaN }))).toMatchObject({ kind: 'refuse', chargeCents: 0 });
  });

  it.each([
    ['below 80%', c(100), c(79), []],
    ['exactly 80%', c(100), c(80), [80]],
    ['between', c(100), c(99), [80]],
    ['at the cap', c(100), c(100), [80, 100]],
    ['past the cap', c(100), c(150), [80, 100]],
    ['no cap', null, c(500), []],
    ['a zero cap is reached at once', 0, 0, [80, 100]],
  ] as const)('WAL-7 (partial) funder alert thresholds reached: %s', (_label, capCents, spentCents, expected) => {
    expect(capThresholdsReached({ capCents, spentCents })).toEqual(expected);
  });
});

describe('writing a per-consumer cap', () => {
  it('WAL-7 (partial) [D-OW-31] enabling caps with nothing named takes the defaults, 50 credits a day and 1,000 a month', () => {
    expect(planConsumerCapWrite({}, null)).toEqual({ kind: 'set', caps: DEFAULT_CONSUMER_CAPS });
    expect(DEFAULT_CONSUMER_CAPS).toEqual({ dailyCents: c(50), monthlyCents: c(1_000) });
  });

  it('WAL-7 (partial) a named window replaces only itself; null in a window means unlimited in it', () => {
    expect(planConsumerCapWrite({ dailyCents: c(30) }, null)).toEqual({ kind: 'set', caps: { dailyCents: c(30), monthlyCents: c(1_000) } });
    expect(planConsumerCapWrite({ monthlyCents: null }, { dailyCents: c(5), monthlyCents: c(70) }))
      .toEqual({ kind: 'set', caps: { dailyCents: c(5), monthlyCents: null } });
  });

  it.each([-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 2_147_483_648])('WAL-7 (partial) a cap of %s is refused, never stored', (bad) => {
    expect(planConsumerCapWrite({ dailyCents: bad }, null)).toEqual({ kind: 'refuse', reason: 'invalid_amount' });
    expect(planConsumerCapWrite({ monthlyCents: bad }, null)).toEqual({ kind: 'refuse', reason: 'invalid_amount' });
  });
});

describe('seat allowance — the per-consumer monthly cap on the org pool', () => {
  it('WAL-2 (partial) [D-OW-31] the seat allowance is its own constant: the per-consumer cap defaults never move it', () => {
    expect(DEFAULT_SEAT_ALLOWANCE_CENTS).toBe(Math.round(centsFromCredits(100)));
    expect(DEFAULT_SEAT_ALLOWANCE_CENTS).not.toBe(DEFAULT_CONSUMER_CAPS.monthlyCents);
    const source = readFileSync(fileURLToPath(new URL('../wallet-core.ts', import.meta.url)), 'utf8');
    expect(source).not.toMatch(/DEFAULT_SEAT_ALLOWANCE_CENTS[^=\n]*=[^\n]*DEFAULT_CONSUMER_CAPS/);
  });

  it('WAL-2 (partial) the seat allowance is never unlimited: with nothing set it is the D20.5 monthly default, 100 credits', () => {
    expect(DEFAULT_SEAT_ALLOWANCE_CENTS).toBe(c(100));
    expect(seatAllowanceCents({ consumerMonthlyCapCents: null, policySeatAllowanceCents: null })).toBe(DEFAULT_SEAT_ALLOWANCE_CENTS);
  });

  it.each([
    ['a per-consumer cap on the pool governs that consumer', c(40), c(250), c(40)],
    ['with no per-consumer cap the org seat allowance governs', null, c(250), c(250)],
    ['a zero cap is a cap of zero, not unset', 0, c(250), 0],
    ['a non-finite cap fails closed to zero', Number.NaN, c(250), 0],
    ['a negative cap fails closed to zero', -5, c(250), 0],
  ] as const)('WAL-2 (partial) seatAllowanceCents: %s', (_label, consumerMonthlyCapCents, policySeatAllowanceCents, expected) => {
    expect(seatAllowanceCents({ consumerMonthlyCapCents, policySeatAllowanceCents })).toBe(expected);
  });

  it.each([
    ['whole cents', 15_000, 15],
    ['a sub-cent remainder rounds UP (the cap never under-counts)', 15_001, 16],
    ['a net refund below zero counts as nothing spent', -3_000, 0],
    ['a non-finite sum fails closed as the whole cap spent', Number.NaN, Number.MAX_SAFE_INTEGER],
  ] as const)('WAL-2 (partial) seatSpentCents: %s', (_label, millicents, expected) => {
    expect(seatSpentCents(millicents)).toBe(expected);
  });

  const usage = (periodChargedMillicents: number, periodReservedCents = 0, dayChargedMillicents = 0) => ({ periodChargedMillicents, periodReservedCents, dayChargedMillicents });

  it.each([
    ['within the cap', c(100), usage(40_000), c(25), { allowed: true, monthlyRemainingCents: c(60) }],
    ['exactly reaching the cap is allowed', c(100), usage(75_000), c(25), { allowed: true, monthlyRemainingCents: c(25) }],
    ['one cent past the cap refuses', c(100), usage(76_000), c(25), { allowed: false, reason: 'monthly_cap_exceeded', monthlyRemainingCents: c(24) }],
    ['this consumer\'s calls in flight count like spend', c(100), usage(40_000, c(50)), c(25), { allowed: false, reason: 'monthly_cap_exceeded', monthlyRemainingCents: c(10) }],
    ['a cap of zero refuses any call', 0, usage(0), c(25), { allowed: false, reason: 'monthly_cap_exceeded', monthlyRemainingCents: 0 }],
  ] as const)('WAL-2 (partial) seatCapCheck: %s', (_label, capCents, seatUsage, reservationCents, expected) => {
    expect(seatCapCheck({ capCents, dailyCapCents: null, usage: seatUsage, reservationCents })).toMatchObject(expected);
  });

  it.each([
    ['a full pool is bounded by what is left of the cap', c(9000), c(100), usage(30_000), c(70)],
    ['a nearly empty pool is bounded by the pool', c(20), c(100), usage(0), c(20)],
    ['a spent cap leaves nothing, whatever the pool holds', c(9000), c(100), usage(100_000), 0],
    ['a zero cap leaves nothing', c(9000), 0, usage(0), 0],
  ] as const)('WAL-2 (partial) seatLegSpendableCents: %s', (_label, poolSpendableCents, capCents, seatUsage, expected) => {
    expect(seatLegSpendableCents({ poolSpendableCents, capCents, dailyCapCents: null, usage: seatUsage })).toBe(expected);
  });

  it.each([
    ['a set daily cap binds within the monthly allowance', c(100), c(50), usage(30_000, 0, 30_000), c(25), { allowed: false, reason: 'daily_cap_exceeded', dailyRemainingCents: c(20), monthlyRemainingCents: c(70) }],
    ['earlier days do not count against today', c(100), c(50), usage(60_000, 0, 10_000), c(25), { allowed: true, dailyRemainingCents: c(40), monthlyRemainingCents: c(40) }],
    ['calls in flight count against today too', c(100), c(50), usage(0, c(40), 0), c(25), { allowed: false, reason: 'daily_cap_exceeded' }],
    ['no daily cap set is no daily limit (unset is unlimited within the leg)', c(100), null, usage(70_000, 0, 70_000), c(25), { allowed: true, dailyRemainingCents: null }],
  ] as const)('WAL-2 (partial) WAL-7 (partial) seatCapCheck with a per-consumer DAILY cap: %s', (_label, capCents, dailyCapCents, seatUsage, reservationCents, expected) => {
    expect(seatCapCheck({ capCents, dailyCapCents, usage: seatUsage, reservationCents })).toMatchObject(expected);
  });

  it('WAL-2 (partial) WAL-7 (partial) the seat leg is bounded by the smaller of what is left today and this period', () => {
    expect(seatLegSpendableCents({ poolSpendableCents: c(9000), capCents: c(100), dailyCapCents: c(50), usage: usage(40_000, 0, 30_000) })).toBe(c(20));
    expect(seatLegSpendableCents({ poolSpendableCents: c(9000), capCents: c(100), dailyCapCents: c(50), usage: usage(90_000, 0, 0) })).toBe(c(10));
  });

  it.each([
    ['below the cap it is the gross', c(100), 75_000, 75_000],
    ['past the cap it reads the cap', c(100), 125_000, 100_000],
    ['a cap raised past the gross reads the gross — nothing stored from the old cap', c(150), 125_000, 125_000],
    ['a cap lowered below the gross reads the cap: no room, never negative', c(50), 75_000, 50_000],
    ['never below zero', c(100), -35_000, 0],
    ['no cap is the gross', null, 70_000, 70_000],
  ] as const)('WAL-2 (partial) WAL-7 (partial) seatCountedMillicents judges gross against the cap in force now: %s', (_label, capCents, grossMillicents, expected) => {
    expect(seatCountedMillicents({ capCents, grossMillicents })).toBe(expected);
  });

  const win = (grossMillicents: number, absorbedMillicents: number) => ({ grossMillicents, absorbedMillicents });
  it.each([
    ['spend inside the cap absorbs nothing', c(100), win(90_000, 0), 0],
    ['a charge that crosses the cap absorbs only the part past it: 125¢ against 100¢ is 25¢', c(100), win(125_000, 0), 25_000],
    ['past the cap, only the NEW excess: 25¢ already absorbed, 155¢ gross absorbs 30¢ more', c(100), win(155_000, 25_000), 30_000],
    ['a refund gives back forgiveness that no longer applies: 86¢ gross, 25¢ absorbed → −25¢', c(100), win(86_000, 25_000), -25_000],
    ['a refund that stays past the cap keeps only the new excess: 111¢ gross, 25¢ absorbed → −14¢', c(100), win(111_000, 25_000), -14_000],
    ['no cap on the window (an unset daily cap) keeps nothing absorbed', null, win(70_000, 0), 0],
    ['a non-finite sum changes nothing here (the gate read fails closed on it)', c(100), win(Number.NaN, 0), 0],
  ] as const)('WAL-2 (partial) WAL-7 (partial) seatOvershootDeltaMillicents keeps one window\'s absorbed at max(0, gross − cap): %s', (_label, capCents, window, expected) => {
    expect(seatOvershootDeltaMillicents({ capCents, window })).toBe(expected);
  });

  it('WAL-2 (partial) D-OW-12 the seat period is the pool\'s refill date, never the person\'s renewal; no refill yet is the UTC month', () => {
    const now = Date.UTC(2026, 8, 17);
    const poolRefill = Date.UTC(2026, 8, 9);
    expect(seatPeriodStartMs({ poolPeriodStartMs: poolRefill, nowMs: now })).toBe(poolRefill);
    expect(seatPeriodStartMs({ poolPeriodStartMs: null, nowMs: now })).toBe(Date.UTC(2026, 8, 1));
  });
});

describe('UTC windows and the allocation period (D-OW-12)', () => {
  it.each([
    [Date.UTC(2026, 8, 17, 23, 59, 59, 999), Date.UTC(2026, 8, 17), Date.UTC(2026, 8, 1)],
    [Date.UTC(2026, 0, 1, 0, 0, 0, 0), Date.UTC(2026, 0, 1), Date.UTC(2026, 0, 1)],
    [Date.UTC(2024, 1, 29, 12), Date.UTC(2024, 1, 29), Date.UTC(2024, 1, 1)],
  ])('WAL-7 (partial) cap windows are UTC: %d starts its day at %d and its month at %d', (now, day, month) => {
    expect(utcDayStartMs(now)).toBe(day);
    expect(utcMonthStartMs(now)).toBe(month);
  });

  const now = Date.UTC(2026, 8, 17);
  const poolRefill = Date.UTC(2026, 8, 9); // Northwind's Stripe renewal day
  const jonoRenewal = Date.UTC(2026, 8, 14);

  it.each([
    ['an org allocation follows the pool refill date', 'org', poolRefill, jonoRenewal, poolRefill],
    ['a personal wallet follows the personal renewal', 'user', poolRefill, jonoRenewal, jonoRenewal],
    ['a personal wallet with no renewal falls back to the UTC month', 'user', poolRefill, null, Date.UTC(2026, 8, 1)],
    ['an org pool with no refill yet falls back to the UTC month', 'org', null, jonoRenewal, Date.UTC(2026, 8, 1)],
  ] as const)('D-OW-12 %s', (_label, rootOwner, poolPeriodStartMs, personalPeriodStartMs, expected) => {
    expect(governingAllocationPeriodStartMs({ rootOwner, poolPeriodStartMs, personalPeriodStartMs, nowMs: now })).toBe(expected);
  });

  it.each([
    ['wallet period predates the governing start', Date.UTC(2026, 7, 9), poolRefill, true],
    ['wallet already on the governing period', poolRefill, poolRefill, false],
    ['wallet ahead of a stale governing start', Date.UTC(2026, 9, 9), poolRefill, false],
  ])('D-OW-12 isAllocationResetDue: %s', (_label, walletPeriodStartMs, governingPeriodStartMs, expected) => {
    expect(isAllocationResetDue({ walletPeriodStartMs, governingPeriodStartMs })).toBe(expected);
  });
});

describe('entitlement with several funders (D-OW-14)', () => {
  it.each([
    ['drive wallet uses the wallet owner tier, never a donor tier', 'drive_wallet', 'business'],
    ['seat allowance uses the org (owner) tier', 'seat_allowance', 'business'],
    ['own credits use the consumer tier', 'own_credits', 'free'],
  ] as const)('D-OW-14 %s', (_label, source, expected) => {
    expect(entitlementTierFor({ source, walletOwnerTier: 'business', consumerTier: 'free' })).toBe(expected);
  });
});

describe('the funder\'s debt notice', () => {
  const wallet = (over: Partial<{ ownerType: 'user' | 'org'; parentWalletId: string | null; subjectType: string | null; debtCents: number }>) =>
    ({ ownerType: 'org' as const, parentWalletId: null, subjectType: null, debtCents: 90, ...over });

  it('WAL-6 (partial) a child wallet carrying its own debt tells its PARENT\'s owner, an org pool tells the org', () => {
    expect(debtNoticeFunder({ debtWallet: wallet({ parentWalletId: 'pool', subjectType: 'drive' }), chargedWalletIsChild: true })).toBe('parent');
    expect(debtNoticeFunder({ debtWallet: wallet({}), chargedWalletIsChild: true })).toBe('self');
    expect(debtNoticeFunder({ debtWallet: wallet({}), chargedWalletIsChild: false })).toBe('self');
  });

  it('WAL-6 (partial) a personal root tells its owner only when it absorbed a drive wallet\'s overshoot, never for their own credits', () => {
    expect(debtNoticeFunder({ debtWallet: wallet({ ownerType: 'user' }), chargedWalletIsChild: true })).toBe('self');
    expect(debtNoticeFunder({ debtWallet: wallet({ ownerType: 'user' }), chargedWalletIsChild: false })).toBeNull();
  });

  it('a wallet with no debt raises no notice', () => {
    expect(debtNoticeFunder({ debtWallet: wallet({ debtCents: 0 }), chargedWalletIsChild: true })).toBeNull();
  });

  it('the notice period is the wallet\'s own once begun, else the UTC calendar month', () => {
    const now = Date.UTC(2026, 9, 20, 12);
    expect(debtNoticePeriodStartMs({ walletPeriodStartMs: Date.UTC(2026, 9, 3), nowMs: now })).toBe(Date.UTC(2026, 9, 3));
    expect(debtNoticePeriodStartMs({ walletPeriodStartMs: null, nowMs: now })).toBe(Date.UTC(2026, 9, 1));
    expect(debtNoticePeriodStartMs({ walletPeriodStartMs: Date.UTC(2026, 10, 3), nowMs: now })).toBe(Date.UTC(2026, 9, 1));
  });
});

describe('wallet-core purity', () => {
  it('imports no db, stripe, env, or clock and nothing but the money model and credit core', () => {
    const src = readFileSync(fileURLToPath(new URL('../wallet-core.ts', import.meta.url)), 'utf8');
    const imports = [...src.matchAll(/from ['"]([^'"]+)['"]/g)].map((m) => m[1]);
    expect(imports.every((p) => p === './money-model' || p === './credit-core')).toBe(true);
    expect(src).not.toMatch(/process\.env/);
    expect(src).not.toMatch(/Date\.now/);
    expect(src).not.toMatch(/new Date\(\s*\)/);
  });
});

describe('the chosen source a fallback moved off, from its wallet row', () => {
  it.each([
    ['a child wallet is a drive wallet', { ownerType: 'org', parentWalletId: 'w-pool' }, 'drive_wallet'],
    ['a personal drive\'s wallet is a drive wallet too', { ownerType: 'user', parentWalletId: 'w-jono' }, 'drive_wallet'],
    ['an org root is the pool a seat spends', { ownerType: 'org', parentWalletId: null }, 'seat_allowance'],
    ['a person\'s root is their own credits', { ownerType: 'user', parentWalletId: null }, 'own_credits'],
  ] as const)('walletSourceKind: %s', (_label, wallet, expected) => {
    expect(walletSourceKind(wallet)).toBe(expected);
  });

  it('WAL-6 (partial) a fallback off a drive wallet with no funder choice set absorbs into its parent, the default (D20.2)', () => {
    const chosen = chosenSourceCharge({ id: 'w-side', ownerType: 'user', parentWalletId: 'w-jono', overshootChoice: null });
    expect(chosen).toEqual({ source: 'drive_wallet', walletId: 'w-side', parentWalletId: 'w-jono', funderChoice: 'absorb_to_parent' });
    expect(settleOvershoot({
      source: 'own_credits', overshootCents: 50, chargedWalletId: 'w-marcus', parentWalletId: null, funderChoice: 'absorb_to_parent', fallbackFrom: chosen,
    })).toEqual({ kind: 'parent_debt', walletId: 'w-jono', cents: 50 });
  });
});

