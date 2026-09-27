import { describe, it, expect } from 'vitest';
import { liabilityWalletKind, foldCreditLiability, type LiabilityGroup } from '../credit-liability';

const group = (over: Partial<LiabilityGroup>): LiabilityGroup => ({
  ownerType: 'user',
  hasSubject: false,
  hasParent: false,
  freeTier: false,
  monthlyRemainingCents: 0,
  topupRemainingCents: 0,
  walletCount: 1,
  ...over,
});

describe('liabilityWalletKind names the three wallet shapes (WAL-2)', () => {
  it('MON-7 (partial) a user wallet with no subject and no parent is a personal root', () => {
    expect(liabilityWalletKind({ ownerType: 'user', hasSubject: false, hasParent: false })).toBe('personal_root');
  });

  it('MON-7 (partial) an org wallet with no subject and no parent is the org pool', () => {
    expect(liabilityWalletKind({ ownerType: 'org', hasSubject: false, hasParent: false })).toBe('org_pool');
  });

  it('MON-7 (partial) anything with a subject or a parent is a child (drive or agent) wallet', () => {
    expect(liabilityWalletKind({ ownerType: 'org', hasSubject: true, hasParent: true })).toBe('child');
    expect(liabilityWalletKind({ ownerType: 'user', hasSubject: true, hasParent: true })).toBe('child');
    expect(liabilityWalletKind({ ownerType: 'user', hasSubject: true, hasParent: false })).toBe('child');
    expect(liabilityWalletKind({ ownerType: 'user', hasSubject: false, hasParent: true })).toBe('child');
  });
});

describe('foldCreditLiability: grants outstanding are the root wallets\' grant buckets', () => {
  it('MON-7 (partial) an org pool\'s unspent grant is included credit liability, beside personal roots', () => {
    const personalOnly = foldCreditLiability([group({ monthlyRemainingCents: 900 })]);
    const withPool = foldCreditLiability([
      group({ monthlyRemainingCents: 900 }),
      group({ ownerType: 'org', monthlyRemainingCents: 4800 }),
    ]);
    expect(personalOnly.includedCreditLiabilityCents).toBe(900);
    expect(withPool.includedCreditLiabilityCents).toBe(5700);
    expect(withPool.orgPoolIncludedCents).toBe(4800);
    expect(withPool.personalIncludedCents).toBe(900);
    expect(withPool.orgPoolCount).toBe(1);
  });

  it('MON-7 (partial) a child wallet\'s allocation is never counted: it is a budget drawn on the pool, not money', () => {
    // A pool of 4800 that has allocated 3000 to a drive wallet still holds all 4800 until
    // spend happens; the child row carries only monthlyAllowanceCents (not read here) and
    // no grant bucket. Even a stray monthlyRemainingCents on a child is not a grant.
    const r = foldCreditLiability([
      group({ ownerType: 'org', monthlyRemainingCents: 4800 }),
      group({ ownerType: 'org', hasSubject: true, hasParent: true, monthlyRemainingCents: 3000 }),
    ]);
    expect(r.includedCreditLiabilityCents).toBe(4800);
  });

  it('MON-7 (partial) funds moved into a child wallet leg count once, in the total: the root that paid was debited', () => {
    // Before: pool 4800 monthly. The pool tops a drive wallet up by 1000 (monthly first),
    // so after: pool 3800 monthly, drive leg 1000. The total is unchanged; nothing doubles.
    const before = foldCreditLiability([group({ ownerType: 'org', monthlyRemainingCents: 4800 })]);
    const after = foldCreditLiability([
      group({ ownerType: 'org', monthlyRemainingCents: 3800 }),
      group({ ownerType: 'org', hasSubject: true, hasParent: true, topupRemainingCents: 1000 }),
    ]);
    expect(after.totalLiabilityCents).toBe(before.totalLiabilityCents);
    expect(after.totalLiabilityCents).toBe(4800);
    expect(after.topupRemainingCents).toBe(1000);
  });

  it('MON-7 (partial) the free starter grant is shown separately inside the personal figure, never hidden in it', () => {
    const r = foldCreditLiability([
      group({ monthlyRemainingCents: 900 }),
      group({ freeTier: true, monthlyRemainingCents: 500, walletCount: 2 }),
    ]);
    expect(r.personalIncludedCents).toBe(1400);
    expect(r.starterGrantIncludedCents).toBe(500);
    expect(r.includedCreditLiabilityCents).toBe(1400);
    expect(r.userCount).toBe(3);
  });

  it('MON-7 (partial) top-up balances are liability but never included credit; total = included + every top-up', () => {
    const r = foldCreditLiability([
      group({ monthlyRemainingCents: 900, topupRemainingCents: 250 }),
      group({ ownerType: 'org', monthlyRemainingCents: 4800, topupRemainingCents: 100 }),
      group({ hasSubject: true, hasParent: true, topupRemainingCents: 40 }),
    ]);
    expect(r.includedCreditLiabilityCents).toBe(5700);
    expect(r.topupRemainingCents).toBe(390);
    expect(r.totalLiabilityCents).toBe(6090);
  });

  it('MON-7 (partial) no wallets means zero everywhere', () => {
    expect(foldCreditLiability([])).toEqual({
      includedCreditLiabilityCents: 0,
      personalIncludedCents: 0,
      starterGrantIncludedCents: 0,
      orgPoolIncludedCents: 0,
      topupRemainingCents: 0,
      totalLiabilityCents: 0,
      userCount: 0,
      orgPoolCount: 0,
    });
  });
});
