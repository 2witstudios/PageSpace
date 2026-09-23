import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { centsFromCredits } from '../money-model';
import {
  PERSONAL_SPEND,
  driveSpend,
  resolvesDriveWallets,
  resolvedSpend,
  conversationSpend,
  personalRootDecision,
  personActor,
  rootAvailableCents,
  walletSpendableCents,
  walletLeg,
  availableSources,
  preselectSoleSource,
  decideCallSpend,
  chooseSource,
  sourceOfWallet,
  NO_STORED_CHOICE,
  PERSONAL_ROOT_NOT_YET_CREATED,
  ORG_ENTITLEMENT_TIER,
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
      .toEqual({ kind: 'drive', driveId: 'd-product', chosen: 'seat_allowance', conversationId: 'c-1' });
  });
});

describe('spend-target: follow-on calls in a turn', () => {
  it('SPEND-4 (partial) a tool call in a turn names exactly the source the turn resolved, never re-choosing', () => {
    expect(resolvedSpend(driveSpend('d-product'), 'drive_wallet')).toEqual({ kind: 'drive', driveId: 'd-product', chosen: 'drive_wallet' });
    expect(resolvedSpend(driveSpend('d-product', 'drive_wallet'), 'seat_allowance')).toEqual({ kind: 'drive', driveId: 'd-product', chosen: 'seat_allowance' });
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

  it('a fallback the drive rule allows is taken and says so', () => {
    const decision = decideCallSpend(input({
      driveWallet: walletLeg('w-product', 'active', 0),
      driveRule: { fallback: 'seat_allowance', guestsMaySpendDriveWallet: false },
    }));
    expect(decision).toMatchObject({ kind: 'spend', source: 'seat_allowance', fallbackApplied: true, fallbackFrom: 'drive_wallet' });
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

describe('spend-target purity', () => {
  it('imports nothing that does I/O', () => {
    const src = readFileSync(fileURLToPath(new URL('../spend-target.ts', import.meta.url)), 'utf8');
    const imports = [...src.matchAll(/from\s+'([^']+)'/g)].map((m) => m[1]);
    expect(imports.sort()).toEqual(['./subscription-tiers', './wallet-core']);
  });
});
