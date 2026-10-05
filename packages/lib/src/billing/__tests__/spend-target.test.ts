import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { centsFromCredits } from '../money-model';
import {
  PERSONAL_SPEND,
  driveSpend,
  automationSpend,
  personTriggeredSpend,
  spendFallbackFromWalletId,
  automationSpendInput,
  automationRunUnreserved,
  resolvesDriveWallets,
  resolvedSpend,
  conversationSpend,
  personalRootDecision,
  personActor,
  rootAvailableCents,
  walletSpendableCents,
  walletLeg,
  seatAllowanceLeg,
  availableSources,
  preselectSoleSource,
  decideCallSpend,
  cappedConsumerLeg,
  spendChoiceLabel,
  chooseSource,
  sourceOfWallet,
  NO_STORED_CHOICE,
  PERSONAL_ROOT_NOT_YET_CREATED,
  ORG_ENTITLEMENT_TIER,
  orgEntitlementTier,
  type CallSpendInput,
  type WalletBalanceFacts,
} from '../spend-target';

// Northwind Labs fixture (Sequence Spec Part 2): Product's wallet holds 1,200 credits under
// the 9,000-credit pool; Marcus is a member on the free tier, Chris Rowe a guest.
const c = (credits: number): number => Math.round(centsFromCredits(credits));

const wallet = (over: Partial<WalletBalanceFacts> = {}): WalletBalanceFacts => ({
  id: 'w',
  status: 'active',
  parentWalletId: null,
  monthlyRemainingCents: 0,
  monthlyAllowanceCents: 0,
  spentCents: 0,
  topupRemainingCents: 0,
  debtCents: 0,
  ...over,
});

const marcus = { kind: 'person', userId: 'u-marcus', isGuest: false } as const;
const chris = { kind: 'person', userId: 'u-chris', isGuest: true } as const;

const input = (over: Partial<CallSpendInput> = {}): CallSpendInput => ({
  actor: marcus,
  driveWallet: walletLeg('w-product', 'active', c(1200)),
  seatAllowance: walletLeg('w-northwind-pool', 'active', c(9000)),
  personal: walletLeg('w-marcus', 'active', c(50)),
  driveRule: { fallback: 'refuse', guestsMaySpendDriveWallet: false },
  chosen: 'drive_wallet',
  userOverride: { alwaysOwnCredits: false, alwaysOwnCreditsInDrive: false },
  reservationCents: c(5),
  walletOwnerTier: ORG_ENTITLEMENT_TIER,
  consumerTier: 'free',
  ...over,
});

describe('orgEntitlementTier — the org tier follows its billing status', () => {
  it('WAL-8 (partial) SEAT-9 (partial) a paid org carries Business; a LAPSED org carries no paid entitlement (free) until it reactivates', () => {
    expect(orgEntitlementTier(false)).toBe(ORG_ENTITLEMENT_TIER);
    expect(ORG_ENTITLEMENT_TIER).toBe('business');
    expect(orgEntitlementTier(true)).toBe('free');
  });
});

describe('spend-target: the target a caller names', () => {
  it('SPEND-8 (partial) a session with no drive is the personal target', () => {
    expect(driveSpend(null)).toEqual(PERSONAL_SPEND);
    expect(driveSpend(undefined, 'drive_wallet')).toEqual(PERSONAL_SPEND);
    expect(driveSpend('')).toEqual(PERSONAL_SPEND);
  });

  it('SPEND-7 (partial) a drive session names its own drive and the chosen source', () => {
    expect(driveSpend('d-product', 'seat_allowance')).toEqual({ kind: 'drive', driveId: 'd-product', chosen: 'seat_allowance' });
    expect(driveSpend('d-product')).toEqual({ kind: 'drive', driveId: 'd-product', chosen: null });
  });

  it('SPEND-8 (partial) the personal target never resolves drive wallets, orgs on or off', () => {
    expect(resolvesDriveWallets({ orgsEnabled: true, target: PERSONAL_SPEND })).toBe(false);
    expect(resolvesDriveWallets({ orgsEnabled: false, target: PERSONAL_SPEND })).toBe(false);
  });

  it('given orgs dark, a drive session spends the personal root exactly as before wallets', () => {
    expect(resolvesDriveWallets({ orgsEnabled: false, target: driveSpend('d-product', 'drive_wallet') })).toBe(false);
    expect(resolvesDriveWallets({ orgsEnabled: true, target: driveSpend('d-product', 'drive_wallet') })).toBe(true);
  });
});

describe('spend-target: a conversation turn names its conversation', () => {
  it('SPEND-3 (partial) a drive conversation carries its id so the gate reads its stored choice; nothing is chosen by the target itself', () => {
    expect(conversationSpend('d-product', 'c-1')).toEqual({ kind: 'drive', driveId: 'd-product', chosen: null, conversationId: 'c-1' });
    expect(conversationSpend('d-product', null)).toEqual({ kind: 'drive', driveId: 'd-product', chosen: null });
  });

  it('SPEND-8 (partial) a conversation with no drive is personal, whatever its id', () => {
    expect(conversationSpend(null, 'c-1')).toEqual(PERSONAL_SPEND);
  });

  it('SPEND-4 (partial) a follow-on call keeps the conversation and names the turn\'s resolved source', () => {
    expect(resolvedSpend(conversationSpend('d-product', 'c-1'), 'seat_allowance'))
      .toEqual({ kind: 'drive', driveId: 'd-product', chosen: 'seat_allowance', conversationId: 'c-1', followOn: true });
  });
});

describe('spend-target: follow-on calls in a turn', () => {
  it('SPEND-4 (partial) a tool call in a turn names exactly the source the turn resolved, never re-choosing', () => {
    expect(resolvedSpend(driveSpend('d-product'), 'drive_wallet')).toEqual({ kind: 'drive', driveId: 'd-product', chosen: 'drive_wallet', followOn: true });
    expect(resolvedSpend(driveSpend('d-product', 'drive_wallet'), 'seat_allowance')).toEqual({ kind: 'drive', driveId: 'd-product', chosen: 'seat_allowance', followOn: true });
  });

  it('a turn the gate did not resolve (skipped for a flat-rate provider) passes its target through', () => {
    expect(resolvedSpend(driveSpend('d-product'), undefined)).toEqual(driveSpend('d-product'));
    expect(resolvedSpend(PERSONAL_SPEND, 'own_credits')).toEqual(PERSONAL_SPEND);
  });

  it('SPEND-8 (partial) the personal decision spends own credits at the caller\'s own tier', () => {
    expect(personalRootDecision('pro')).toMatchObject({ kind: 'spend', source: 'own_credits', entitlementTier: 'pro', fallbackApplied: false });
  });
});

describe('spend-target: who spends', () => {
  it('DRV-8 (partial) a drive member who is not in the org is a guest; an org member is not', () => {
    expect(personActor('u-chris', { orgId: 'o-northwind', isDriveMember: true, isOrgMember: false })).toEqual(chris);
    expect(personActor('u-marcus', { orgId: 'o-northwind', isDriveMember: true, isOrgMember: true })).toEqual(marcus);
  });

  it('on a personal drive a member is not a guest; a non-member is (fail closed)', () => {
    expect(personActor('u-a', { orgId: null, isDriveMember: true, isOrgMember: false })).toEqual({ kind: 'person', userId: 'u-a', isGuest: false });
    const nonMember = personActor('u-b', { orgId: null, isDriveMember: false, isOrgMember: false });
    expect(nonMember.kind === 'person' && nonMember.isGuest).toBe(true);
  });
});

describe('spend-target: wallet rows to legs', () => {
  it('WAL-5 (partial) a root wallet is net of its debt and of the holds reserved on it', () => {
    const pool = wallet({ monthlyRemainingCents: 900, topupRemainingCents: 100, debtCents: 50 });
    expect(rootAvailableCents(pool, 200)).toBe(750);
    expect(walletSpendableCents({ wallet: pool, ownReservedCents: 200, parent: null })).toBe(750);
    expect(walletSpendableCents({ wallet: pool, ownReservedCents: 2000, parent: null })).toBe(0);
  });

  it('WAL-5 (partial) a drive wallet draws its allocation only as far as the parent can cover, net of the parent reservations', () => {
    const pool = wallet({ id: 'w-pool', monthlyRemainingCents: 300 });
    const product = wallet({ id: 'w-product', parentWalletId: 'w-pool', monthlyAllowanceCents: 1200, spentCents: 200, topupRemainingCents: 40 });
    // allocation remaining 1000, parent 300 − 100 reserved elsewhere = 200 → 200 + 40 leg − 30 own holds
    expect(walletSpendableCents({ wallet: product, ownReservedCents: 30, parent: { wallet: pool, reservedCents: 100 } })).toBe(210);
  });

  it('WAL-6 (partial) a drive wallet in debt nets it before spending', () => {
    const pool = wallet({ id: 'w-pool', monthlyRemainingCents: 10_000 });
    const engineering = wallet({ id: 'w-eng', parentWalletId: 'w-pool', monthlyAllowanceCents: 900, spentCents: 900, debtCents: 25 });
    expect(walletSpendableCents({ wallet: engineering, ownReservedCents: 0, parent: { wallet: pool, reservedCents: 0 } })).toBe(0);
  });
});

describe('spend-target: the seat leg is capped per consumer', () => {
  const noSpend = { periodChargedMillicents: 0, periodReservedCents: 0, dayChargedMillicents: 0 };

  it('WAL-2 (partial) a full pool through a seat spends only what is left of that consumer\'s cap, and says the cap binds', () => {
    const leg = seatAllowanceLeg({ poolId: 'w-pool', status: 'active', poolSpendableCents: c(9000), capCents: c(100), dailyCapCents: null, usage: { periodChargedMillicents: 60_000, periodReservedCents: 0, dayChargedMillicents: 0 } });
    expect(leg).toEqual({ walletId: 'w-pool', status: 'active', spendableCents: c(40), capReached: true });
  });

  it('WAL-2 (partial) where the pool, not the cap, is the bound the leg is not cap-limited', () => {
    const leg = seatAllowanceLeg({ poolId: 'w-pool', status: 'active', poolSpendableCents: c(30), capCents: c(100), dailyCapCents: null, usage: noSpend });
    expect(leg).toEqual({ walletId: 'w-pool', status: 'active', spendableCents: c(30), capReached: false });
  });

  it('WAL-2 (partial) a spent cap refuses the seat by the cap, charges nothing, and offers the rest', () => {
    const seat = seatAllowanceLeg({ poolId: 'w-pool', status: 'active', poolSpendableCents: c(9000), capCents: c(100), dailyCapCents: null, usage: { periodChargedMillicents: 100_000, periodReservedCents: 0, dayChargedMillicents: 0 } });
    const decision = decideCallSpend({
      actor: { kind: 'person', userId: 'u-marcus', isGuest: false },
      driveWallet: walletLeg('w-product', 'active', c(1200)),
      seatAllowance: seat,
      personal: walletLeg('w-marcus', 'active', c(500)),
      driveRule: { fallback: 'refuse', guestsMaySpendDriveWallet: false },
      chosen: 'seat_allowance',
      userOverride: { alwaysOwnCredits: false, alwaysOwnCreditsInDrive: false },
      reservationCents: c(25),
      walletOwnerTier: 'business',
      consumerTier: 'free',
    });
    expect(decision).toEqual({
      kind: 'refuse',
      source: 'seat_allowance',
      reason: 'source_cap_reached',
      options: [{ source: 'drive_wallet', walletId: 'w-product' }, { source: 'own_credits', walletId: 'w-marcus' }],
      chargeCents: 0,
    });
  });
});

describe('spend-target: the chosen source', () => {
  it('SPEND-1 (partial) a member in an org drive has three sources; a guest has only their own credits', () => {
    expect(availableSources(input())).toEqual(['drive_wallet', 'seat_allowance', 'own_credits']);
    expect(availableSources(input({ actor: chris }))).toEqual(['own_credits']);
  });

  it('SPEND-1 (partial) with no drive wallet and no seat the only source is own credits, and it is preselected', () => {
    const legs = input({ driveWallet: null, seatAllowance: null });
    expect(preselectSoleSource(null, legs)).toBe('own_credits');
  });

  it('SPEND-4 (partial) with several sources and none chosen nothing is preselected', () => {
    expect(preselectSoleSource(null, input())).toBeNull();
  });

  it('a chosen source is never replaced by preselection', () => {
    expect(preselectSoleSource('seat_allowance', input({ driveWallet: null }))).toBe('seat_allowance');
  });
});

describe('spend-target: decideCallSpend', () => {
  it('SPEND-1 (partial) the chosen drive wallet is the wallet the call names', () => {
    const decision = decideCallSpend(input());
    expect(decision).toMatchObject({ kind: 'spend', source: 'drive_wallet', walletId: 'w-product', fallbackApplied: false });
  });

  it('SPEND-4 (partial) an empty chosen wallet refuses, names it, offers the rest, and charges zero; never falls back to the person', () => {
    const decision = decideCallSpend(input({ driveWallet: walletLeg('w-product', 'active', 0) }));
    expect(decision).toEqual({
      kind: 'refuse',
      source: 'drive_wallet',
      reason: 'source_empty',
      options: [
        { source: 'seat_allowance', walletId: 'w-northwind-pool' },
        { source: 'own_credits', walletId: 'w-marcus' },
      ],
      chargeCents: 0,
    });
  });

  it('SPEND-4 (partial) with several sources and none chosen the call refuses with the options', () => {
    const decision = decideCallSpend(input({ chosen: null }));
    expect(decision.kind).toBe('refuse');
    expect(decision.kind === 'refuse' && decision.reason).toBe('no_source_chosen');
    expect(decision.kind === 'refuse' && decision.chargeCents).toBe(0);
  });

  it('SPEND-4 (partial) a guest with the switch off never spends the drive wallet, even when they chose it', () => {
    const decision = decideCallSpend(input({ actor: chris }));
    expect(decision).toMatchObject({ kind: 'refuse', source: 'drive_wallet', reason: 'guest_drive_wallet_off', chargeCents: 0 });
  });

  it('WAL-8 (partial) a free member spending the org drive wallet or their seat gets the org tier', () => {
    expect(decideCallSpend(input())).toMatchObject({ kind: 'spend', entitlementTier: 'business' });
    expect(decideCallSpend(input({ chosen: 'seat_allowance' }))).toMatchObject({ kind: 'spend', entitlementTier: 'business' });
  });

  it('WAL-8 (partial) the same free member on their own credits keeps their own tier', () => {
    expect(decideCallSpend(input({ chosen: 'own_credits' }))).toMatchObject({
      kind: 'spend',
      source: 'own_credits',
      walletId: 'w-marcus',
      entitlementTier: 'free',
    });
  });

  it('WAL-8 (partial) on a personal drive wallet leg the funder (drive owner) tier governs', () => {
    const decision = decideCallSpend(input({ seatAllowance: null, walletOwnerTier: 'pro' }));
    expect(decision).toMatchObject({ kind: 'spend', source: 'drive_wallet', entitlementTier: 'pro' });
  });

  it('a fallback the drive rule allows is taken and says so, naming the wallet it moved off', () => {
    const decision = decideCallSpend(input({
      driveWallet: walletLeg('w-product', 'active', 0),
      driveRule: { fallback: 'seat_allowance', guestsMaySpendDriveWallet: false },
    }));
    expect(decision).toMatchObject({
      kind: 'spend', source: 'seat_allowance', fallbackApplied: true, fallbackFrom: 'drive_wallet', fallbackFromWalletId: 'w-product',
    });
  });

  it.each([
    ['the drive wallet the turn resolved', 'drive_wallet', { driveWallet: walletLeg('w-product', 'active', 0) }, 'seat_allowance'],
    ['the seat the turn fell back onto', 'seat_allowance', { seatAllowance: walletLeg('w-northwind-pool', 'active', 0) }, 'own_credits'],
  ] as const)(
    'SPEND-4 (partial) a follow-on call in a turn never re-applies a fallback: when %s empties, it refuses by name and charges zero',
    (_label, chosen, legs, fallback) => {
      const decision = decideCallSpend(input({ chosen, followOn: true, ...legs, driveRule: { fallback, guestsMaySpendDriveWallet: false } }));
      expect(decision).toMatchObject({ kind: 'refuse', source: chosen, reason: 'source_empty', chargeCents: 0 });
    },
  );

  it('WAL-6 (partial) a follow-on in a turn that fell back carries the chosen wallet onto its own hold, and reports no fallback of its own', () => {
    const target = resolvedSpend(driveSpend('d-product'), 'own_credits', 'w-product');
    expect(target).toEqual({ kind: 'drive', driveId: 'd-product', chosen: 'own_credits', followOn: true, fallbackFromWalletId: 'w-product' });
    expect(spendFallbackFromWalletId(target)).toBe('w-product');
    const decision = decideCallSpend(input({ chosen: 'own_credits', followOn: true, fallbackFromWalletId: 'w-product' }));
    expect(decision).toMatchObject({ kind: 'spend', source: 'own_credits', fallbackApplied: false, fallbackFrom: null, fallbackFromWalletId: 'w-product' });
    // A first call ignores a carried origin: only a follow-on has a turn to inherit it from.
    expect(decideCallSpend(input({ chosen: null, stored: { ...NO_STORED_CHOICE, chosenWalletId: 'w-marcus' }, fallbackFromWalletId: 'w-product' })))
      .toMatchObject({ kind: 'spend', fallbackFromWalletId: null });
  });

  it('SPEND-4 (partial) a follow-on call whose resolved source still covers it spends that source, unchanged', () => {
    const decision = decideCallSpend(input({ chosen: 'drive_wallet', followOn: true, driveRule: { fallback: 'own_credits', guestsMaySpendDriveWallet: false } }));
    expect(decision).toMatchObject({ kind: 'spend', source: 'drive_wallet', walletId: 'w-product', fallbackApplied: false, fallbackFromWalletId: null });
  });
});

describe('spend-target: the stored choice (conversations.chosenWalletId, wallets.defaultSpendSource)', () => {
  const stored = (over: Partial<typeof NO_STORED_CHOICE> = {}) => ({ ...NO_STORED_CHOICE, ...over });

  it('SPEND-3 (partial) a chosen wallet id maps to the source it is for THIS person in THIS drive, else to nothing', () => {
    const legs = input();
    expect(sourceOfWallet('w-product', legs)).toBe('drive_wallet');
    expect(sourceOfWallet('w-northwind-pool', legs)).toBe('seat_allowance');
    expect(sourceOfWallet('w-marcus', legs)).toBe('own_credits');
    // Someone else's personal wallet, another drive's wallet, a deleted wallet: no leg of this person matches.
    expect(sourceOfWallet('w-lena', legs)).toBeNull();
    expect(sourceOfWallet('w-deleted', legs)).toBeNull();
    // A seat the person does not hold (left the org) is not a leg at all.
    expect(sourceOfWallet('w-northwind-pool', input({ seatAllowance: null }))).toBeNull();
    // The not-yet-created personal placeholder is never a choosable id.
    expect(sourceOfWallet(PERSONAL_ROOT_NOT_YET_CREATED, input({ personal: walletLeg(PERSONAL_ROOT_NOT_YET_CREATED, 'active', 10) }))).toBeNull();
  });

  it('SPEND-3 (partial) the conversation choice wins over both defaults; the drive default over the person\'s', () => {
    const legs = input({ chosen: null });
    expect(chooseSource(null, stored({ chosenWalletId: 'w-marcus', driveDefault: 'drive_wallet', personalDefault: 'seat_allowance' }), legs))
      .toEqual({ kind: 'source', source: 'own_credits', via: 'conversation' });
    expect(chooseSource(null, stored({ driveDefault: 'seat_allowance', personalDefault: 'own_credits' }), legs))
      .toEqual({ kind: 'source', source: 'seat_allowance', via: 'drive_default' });
    expect(chooseSource(null, stored({ personalDefault: 'own_credits' }), legs))
      .toEqual({ kind: 'source', source: 'own_credits', via: 'personal_default' });
  });

  it('SPEND-3 (partial) a default this person may not spend is skipped, never forced (a guest and the drive default)', () => {
    expect(chooseSource(null, stored({ driveDefault: 'drive_wallet', personalDefault: 'own_credits' }), input({ actor: chris, chosen: null })))
      .toEqual({ kind: 'source', source: 'own_credits', via: 'personal_default' });
  });

  it('SPEND-4 (partial) the source a turn already resolved is kept for its follow-on calls, whatever is stored', () => {
    expect(chooseSource('seat_allowance', stored({ chosenWalletId: 'w-marcus' }), input()))
      .toEqual({ kind: 'source', source: 'seat_allowance', via: 'turn' });
  });

  it('SPEND-4 (partial) a chosen wallet that resolves to nothing is INVALID, never "nothing chosen"', () => {
    expect(chooseSource(null, stored({ chosenWalletId: 'w-deleted', driveDefault: 'drive_wallet', personalDefault: 'own_credits' }), input()))
      .toEqual({ kind: 'invalid', chosenWalletId: 'w-deleted' });
  });

  it('SPEND-4 (partial) a conversation whose chosen wallet was DELETED refuses by name and charges zero; no fallback to the personal root', () => {
    const decision = decideCallSpend(input({
      chosen: null,
      stored: stored({ chosenWalletId: 'w-deleted', personalDefault: 'own_credits' }),
      // Even a drive rule that allows a fallback does not move an invalid choice.
      driveRule: { fallback: 'own_credits', guestsMaySpendDriveWallet: false },
    }));
    expect(decision).toEqual({
      kind: 'refuse',
      source: null,
      reason: 'chosen_wallet_unavailable',
      options: [
        { source: 'drive_wallet', walletId: 'w-product' },
        { source: 'seat_allowance', walletId: 'w-northwind-pool' },
        { source: 'own_credits', walletId: 'w-marcus' },
      ],
      chargeCents: 0,
    });
  });

  it('SPEND-4 (partial) a chosen wallet the person may not spend (someone else\'s; a seat after leaving the org) refuses the same way', () => {
    for (const legs of [
      input({ chosen: null, stored: stored({ chosenWalletId: 'w-lena' }) }),
      input({ chosen: null, seatAllowance: null, stored: stored({ chosenWalletId: 'w-northwind-pool' }) }),
    ]) {
      expect(decideCallSpend(legs)).toMatchObject({ kind: 'refuse', source: null, reason: 'chosen_wallet_unavailable', chargeCents: 0 });
    }
  });

  it('SPEND-4 (partial) an invalid choice refuses even where the person has only one source (no sole-source preselection)', () => {
    const decision = decideCallSpend(input({ chosen: null, driveWallet: null, seatAllowance: null, stored: stored({ chosenWalletId: 'w-deleted' }) }));
    expect(decision).toMatchObject({ kind: 'refuse', reason: 'chosen_wallet_unavailable', chargeCents: 0 });
  });

  it('SPEND-4 (partial) nothing chosen and no default refuses with the options; it never defaults to a wallet', () => {
    const decision = decideCallSpend(input({ chosen: null, stored: NO_STORED_CHOICE }));
    expect(decision).toMatchObject({ kind: 'refuse', source: null, reason: 'no_source_chosen', chargeCents: 0 });
  });

  it('SPEND-3 (partial) a valid conversation choice spends exactly that wallet', () => {
    expect(decideCallSpend(input({ chosen: null, stored: stored({ chosenWalletId: 'w-northwind-pool' }) })))
      .toMatchObject({ kind: 'spend', source: 'seat_allowance', walletId: 'w-northwind-pool', fallbackApplied: false });
  });

  it('SPEND-5 (partial) the always-own-credits override still wins over a stale choice (it is itself explicit)', () => {
    const decision = decideCallSpend(input({
      chosen: null,
      stored: stored({ chosenWalletId: 'w-deleted' }),
      userOverride: { alwaysOwnCredits: true, alwaysOwnCreditsInDrive: false },
    }));
    expect(decision).toMatchObject({ kind: 'spend', source: 'own_credits', walletId: 'w-marcus' });
  });
});

describe('spend-target: automations', () => {
  // Northwind's weekly digest workflow runs in Product; Marcus created it and holds his own credits.
  const automation = (over: Partial<Parameters<typeof automationSpendInput>[0]> = {}): CallSpendInput =>
    automationSpendInput({
      driveId: 'd-product',
      driveWallet: walletLeg('w-product', 'active', c(1200)),
      walletOwnerTier: ORG_ENTITLEMENT_TIER,
      reservationCents: c(5),
      ...over,
    });

  it('SPEND-6 (partial) SPEND-3 (partial) a stored choice never moves an automation: not a person\'s own wallet, not the pool, not a stale id', () => {
    for (const chosenWalletId of ['w-marcus', 'w-northwind-pool', 'w-deleted']) {
      const stored = { chosenWalletId, driveDefault: 'own_credits' as const, personalDefault: 'seat_allowance' as const };
      expect(decideCallSpend({ ...automation(), stored }), chosenWalletId).toMatchObject({ kind: 'spend', source: 'drive_wallet', walletId: 'w-product' });
      // An empty drive wallet still SKIPS rather than falling to the stored wallet.
      expect(decideCallSpend({ ...automation({ driveWallet: walletLeg('w-product', 'active', 0) }), stored }), chosenWalletId)
        .toEqual({ kind: 'skip', reason: 'drive_wallet_empty', walletId: 'w-product', chargeCents: 0 });
    }
  });

  it('SPEND-6 (partial) an automation names its drive as the consumer, never a person', () => {
    expect(automationSpend('d-product')).toEqual({ kind: 'automation', driveId: 'd-product' });
    expect(automation().actor).toEqual({ kind: 'automation', driveId: 'd-product' });
  });

  it('SPEND-6 (partial) an automation offers the gate no personal leg and no seat to reach', () => {
    const legs = automation();
    expect(legs.personal).toBeNull();
    expect(legs.seatAllowance).toBeNull();
    expect(availableSources(legs)).toEqual(['drive_wallet']);
  });

  it('SPEND-6 (partial) with orgs on an automation resolves drive wallets; while orgs are dark it bills as before wallets', () => {
    expect(resolvesDriveWallets({ orgsEnabled: true, target: automationSpend('d-product') })).toBe(true);
    expect(resolvesDriveWallets({ orgsEnabled: false, target: automationSpend('d-product') })).toBe(false);
  });

  it('SPEND-6 (partial) a tool call inside an automation run stays an automation, whatever source the turn resolved', () => {
    expect(resolvedSpend(automationSpend('d-product'), 'drive_wallet')).toEqual(automationSpend('d-product'));
    expect(resolvedSpend(automationSpend('d-product'), 'own_credits')).toEqual(automationSpend('d-product'));
  });

  it('SPEND-6 (partial) a funded drive wallet is the wallet an automation spends, at the wallet owner tier', () => {
    expect(decideCallSpend(automation())).toEqual({
      kind: 'spend',
      source: 'drive_wallet',
      walletId: 'w-product',
      fallbackApplied: false,
      fallbackFrom: null,
      fallbackFromWalletId: null,
      entitlementTier: 'business',
    });
  });

  it('SPEND-6 (partial) an automation that would run a model with no reserved wallet is refused, so it cannot settle on a person', () => {
    const on = { orgsEnabled: true, billingEnabled: true, target: automationSpend('d-product') };
    expect(automationRunUnreserved({ ...on, walletId: undefined })).toBe(true);
    expect(automationRunUnreserved({ ...on, walletId: 'w-product' })).toBe(false);
  });

  it('while orgs are dark, billing is off, or the target is a person, an unreserved run is not an automation settle to refuse', () => {
    const base = { orgsEnabled: true, billingEnabled: true, target: automationSpend('d-product'), walletId: undefined };
    expect(automationRunUnreserved({ ...base, orgsEnabled: false })).toBe(false);
    expect(automationRunUnreserved({ ...base, billingEnabled: false })).toBe(false);
    expect(automationRunUnreserved({ ...base, target: PERSONAL_SPEND })).toBe(false);
    expect(automationRunUnreserved({ ...base, target: driveSpend('d-product', 'own_credits') })).toBe(false);
  });

  it.each([
    ['empty', walletLeg('w-product', 'active', 0), { kind: 'skip', reason: 'drive_wallet_empty', walletId: 'w-product', chargeCents: 0 }],
    ['short of the reservation', walletLeg('w-product', 'active', c(1)), { kind: 'skip', reason: 'drive_wallet_empty', walletId: 'w-product', chargeCents: 0 }],
    ['paused', walletLeg('w-product', 'paused', c(1200)), { kind: 'skip', reason: 'drive_wallet_paused', walletId: 'w-product', chargeCents: 0 }],
    ['missing', null, { kind: 'skip', reason: 'no_drive_wallet', walletId: null, chargeCents: 0 }],
  ] as const)('SPEND-6 (partial) an automation whose drive wallet is %s skips and charges zero', (_label, driveWallet, expected) => {
    expect(decideCallSpend(automation({ driveWallet }))).toEqual(expected);
  });
});

describe('spend-target purity', () => {
  it('imports nothing that does I/O', () => {
    const src = readFileSync(fileURLToPath(new URL('../spend-target.ts', import.meta.url)), 'utf8');
    const imports = [...src.matchAll(/from\s+'([^']+)'/g)].map((m) => m[1]);
    expect(imports.sort()).toEqual(['./subscription-tiers', './wallet-core']);
  });
});

describe('spend-target: a drive-wallet leg capped per consumer', () => {
  const leg = walletLeg('w-product', 'active', c(1200));
  it('WAL-7 (partial) with no cap row the leg is the wallet, unchanged', () => {
    expect(cappedConsumerLeg(leg, null)).toEqual(leg);
  });

  it('WAL-7 (partial) a cap bounds what the consumer may spend of the wallet, and says the cap, not the wallet, ran out', () => {
    expect(cappedConsumerLeg(leg, { dailyRemainingCents: c(3), monthlyRemainingCents: c(40) }))
      .toEqual({ ...leg, spendableCents: c(3), capReached: true });
    expect(cappedConsumerLeg(leg, { dailyRemainingCents: null, monthlyRemainingCents: c(2000) })).toEqual(leg);
  });

  it('WAL-7 (partial) a spent cap refuses the drive wallet by name (source_cap_reached), and the fallback rule may then move the call', () => {
    const capped = cappedConsumerLeg(leg, { dailyRemainingCents: 0, monthlyRemainingCents: c(40) });
    expect(decideCallSpend(input({ driveWallet: capped }))).toMatchObject({ kind: 'refuse', source: 'drive_wallet', reason: 'source_cap_reached', chargeCents: 0 });
  });
});

describe('spend-target: what a source is called', () => {
  it('SPEND-2 (partial) each source is named for the chip: the drive\'s wallet, the org seat, your own credits — never a raw id', () => {
    expect(spendChoiceLabel({ source: 'drive_wallet', driveName: 'Product', orgName: 'Northwind Labs' })).toBe('Product wallet');
    expect(spendChoiceLabel({ source: 'seat_allowance', driveName: 'Product', orgName: 'Northwind Labs' })).toBe('Northwind Labs seat');
    expect(spendChoiceLabel({ source: 'own_credits', driveName: 'Product', orgName: null })).toBe('Your credits');
    expect(spendChoiceLabel({ source: 'drive_wallet', driveName: null, orgName: null })).toBe('Drive wallet');
  });
});

describe('spend-target: a run a person triggers', () => {
  it('WAL-7 (partial) a channel @mention is an automation target that names a person present, so their caps bind; a plain automation names none', () => {
    expect(personTriggeredSpend('d-product')).toEqual({ kind: 'automation', driveId: 'd-product', personPresent: true });
    expect(automationSpend('d-product')).toEqual({ kind: 'automation', driveId: 'd-product' });
    expect(resolvedSpend(personTriggeredSpend('d-product'), 'drive_wallet')).toEqual(personTriggeredSpend('d-product'));
  });
});

