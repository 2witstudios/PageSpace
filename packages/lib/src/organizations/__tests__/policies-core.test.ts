import { describe, it, expect } from 'vitest';
import { DEFAULT_SEAT_ALLOWANCE_CENTS } from '../../billing/wallet-core';
import {
  DEFAULT_ORG_POLICIES,
  ORG_POLICY_KEYS,
  SUSPENSION_KINDS,
  driveSpendPolicy,
  mergeOrgPolicies,
  orgPolicySpendPolicy,
  parseOrgPolicies,
  suspensionKindsChanged,
  suspensionTargets,
  validateOrgPoliciesPatch,
} from '../policies-core';

describe('parseOrgPolicies', () => {
  it('POL-1 (partial) an empty stored object reads as the default for every policy', () => {
    expect(parseOrgPolicies({})).toEqual(DEFAULT_ORG_POLICIES);
    expect(Object.keys(parseOrgPolicies({})).sort()).toEqual([...ORG_POLICY_KEYS].sort());
  });

  it.each([null, undefined, 'x', 7, [], true])('POL-1 (partial) a non-object row (%j) reads as the defaults', (raw) => {
    expect(parseOrgPolicies(raw)).toEqual(DEFAULT_ORG_POLICIES);
  });

  it('POL-1 (partial) stored values override defaults and untouched keys keep theirs', () => {
    const read = parseOrgPolicies({ guests: 'off', publicShareLinks: false, integrationsAllowlist: ['github'] });
    expect(read.guests).toBe('off');
    expect(read.publicShareLinks).toBe(false);
    expect(read.integrationsAllowlist).toEqual(['github']);
    expect(read.publishWeb).toBe(DEFAULT_ORG_POLICIES.publishWeb);
  });

  it('POL-1 (partial) a present-but-invalid value fails closed to the strictest value, not the default', () => {
    const read = parseOrgPolicies({
      guests: 'maybe',
      publicShareLinks: 'yes',
      publishWeb: 1,
      whoCanInvite: 'everyone',
      walletFallback: 'free-money',
      integrationsAllowlist: 'github',
      modelAllowlist: [1, 2],
    });
    expect(read.guests).toBe('off');
    expect(read.publicShareLinks).toBe(false);
    expect(read.publishWeb).toBe(false);
    expect(read.whoCanInvite).toBe('admins');
    expect(read.walletFallback).toBe('refuse');
    expect(read.integrationsAllowlist).toEqual([]);
    expect(read.modelAllowlist).toEqual([]);
  });

  it('POL-1 (partial) unknown stored keys are ignored', () => {
    expect(parseOrgPolicies({ somethingNew: true })).toEqual(DEFAULT_ORG_POLICIES);
  });

  it('POL-1 (partial) the default seat allowance is the wallet default, so no org changes behaviour until it sets one', () => {
    expect(DEFAULT_ORG_POLICIES.seatAllowanceCents).toBe(DEFAULT_SEAT_ALLOWANCE_CENTS);
    expect(DEFAULT_ORG_POLICIES.walletFallback).toBe('refuse');
  });

  it('POL-7 (partial) there is no unlimited seat allowance: null, negative and fractional values are never stored or read as one', () => {
    expect(parseOrgPolicies({}).seatAllowanceCents).toBeGreaterThan(0);
    expect(parseOrgPolicies({ seatAllowanceCents: null }).seatAllowanceCents).toBe(0);
    expect(validateOrgPoliciesPatch({ seatAllowanceCents: null }).ok).toBe(false);
    expect(parseOrgPolicies({ seatAllowanceCents: 250 }).seatAllowanceCents).toBe(250);
    expect(parseOrgPolicies({ seatAllowanceCents: -5 }).seatAllowanceCents).toBe(0);
    expect(parseOrgPolicies({ seatAllowanceCents: 1.5 }).seatAllowanceCents).toBe(0);
  });
});

describe('validateOrgPoliciesPatch', () => {
  it('POL-1 (partial) accepts a partial patch of known keys', () => {
    const r = validateOrgPoliciesPatch({ guests: 'approve', agentsAutonomous: false });
    expect(r).toEqual({ ok: true, patch: { guests: 'approve', agentsAutonomous: false } });
  });

  it('POL-1 (partial) refuses an unknown key, a bad value, and a non-object', () => {
    expect(validateOrgPoliciesPatch({ nope: true }).ok).toBe(false);
    expect(validateOrgPoliciesPatch({ guests: 'maybe' }).ok).toBe(false);
    expect(validateOrgPoliciesPatch({ seatAllowanceCents: -1 }).ok).toBe(false);
    expect(validateOrgPoliciesPatch({ integrationsAllowlist: 'github' }).ok).toBe(false);
    expect(validateOrgPoliciesPatch(null).ok).toBe(false);
    expect(validateOrgPoliciesPatch([]).ok).toBe(false);
  });

  it('POL-1 (partial) an empty patch is refused: a change that changes nothing is a client bug', () => {
    expect(validateOrgPoliciesPatch({}).ok).toBe(false);
  });

  it('POL-1 (partial) allowlists are de-duplicated and trimmed; null means allow all', () => {
    const r = validateOrgPoliciesPatch({ integrationsAllowlist: [' github ', 'github', 'slack'], modelAllowlist: null });
    expect(r).toEqual({ ok: true, patch: { integrationsAllowlist: ['github', 'slack'], modelAllowlist: null } });
  });
});

describe('mergeOrgPolicies', () => {
  it('POL-1 (partial) writes only the patched keys over what was stored, keeping unset keys unset', () => {
    expect(mergeOrgPolicies({ guests: 'on' }, { publicShareLinks: false })).toEqual({ guests: 'on', publicShareLinks: false });
  });

  it('POL-1 (partial) a garbage stored row is replaced by an object, never spread as an array or string', () => {
    expect(mergeOrgPolicies('junk', { guests: 'off' })).toEqual({ guests: 'off' });
    expect(mergeOrgPolicies(null, { guests: 'off' })).toEqual({ guests: 'off' });
  });
});

describe('suspensionTargets', () => {
  it('POL-1 (partial) the defaults forbid nothing', () => {
    expect(suspensionTargets(DEFAULT_ORG_POLICIES)).toEqual({
      publicShareLinks: false,
      publishedPages: false,
      customDomains: false,
      guests: false,
      integrations: { restrictTo: null },
    });
  });

  it('POL-1 (partial) each policy set to off forbids exactly its own kind', () => {
    expect(suspensionTargets({ ...DEFAULT_ORG_POLICIES, publicShareLinks: false }).publicShareLinks).toBe(true);
    expect(suspensionTargets({ ...DEFAULT_ORG_POLICIES, publishWeb: false }).publishedPages).toBe(true);
    expect(suspensionTargets({ ...DEFAULT_ORG_POLICIES, customDomains: false }).customDomains).toBe(true);
    expect(suspensionTargets({ ...DEFAULT_ORG_POLICIES, guests: 'off' }).guests).toBe(true);
    expect(suspensionTargets({ ...DEFAULT_ORG_POLICIES, integrationsAllowlist: ['github'] }).integrations).toEqual({ restrictTo: ['github'] });
  });

  it('POL-1 (partial) guests on and admins-approve do not suspend existing guests (approve gates only NEW invites)', () => {
    expect(suspensionTargets({ ...DEFAULT_ORG_POLICIES, guests: 'approve' }).guests).toBe(false);
    expect(suspensionTargets({ ...DEFAULT_ORG_POLICIES, guests: 'on' }).guests).toBe(false);
  });

  it('POL-1 (partial) an empty integrations allowlist forbids every connection', () => {
    expect(suspensionTargets({ ...DEFAULT_ORG_POLICIES, integrationsAllowlist: [] }).integrations).toEqual({ restrictTo: [] });
  });
});

describe('suspensionKindsChanged', () => {
  it('POL-1 (partial) names only the kinds whose governing policy changed', () => {
    const after = { ...DEFAULT_ORG_POLICIES, publicShareLinks: false, seatAllowanceCents: 5 };
    expect(suspensionKindsChanged(DEFAULT_ORG_POLICIES, after)).toEqual(['publicShareLinks']);
  });

  it('POL-1 (partial) turning a policy back on is a change too, so the restore runs', () => {
    const off = { ...DEFAULT_ORG_POLICIES, guests: 'off' as const };
    expect(suspensionKindsChanged(off, DEFAULT_ORG_POLICIES)).toEqual(['guests']);
  });

  it('POL-1 (partial) an allowlist edit that keeps the same set in another order is not a change', () => {
    const a = { ...DEFAULT_ORG_POLICIES, integrationsAllowlist: ['a', 'b'] };
    const b = { ...DEFAULT_ORG_POLICIES, integrationsAllowlist: ['b', 'a'] };
    expect(suspensionKindsChanged(a, b)).toEqual([]);
  });

  it('POL-1 (partial) every suspension kind is reachable', () => {
    expect([...SUSPENSION_KINDS].sort()).toEqual(['customDomains', 'guests', 'integrations', 'publicShareLinks', 'publishedPages']);
  });
});

describe('spend policy', () => {
  it('POL-7 (partial) the org policy row supplies the org spend policy the credit gate resolves against', () => {
    expect(orgPolicySpendPolicy({ ...DEFAULT_ORG_POLICIES, seatAllowanceCents: 500, walletFallback: 'own_credits' })).toEqual({
      seatAllowanceCents: 500,
      fallback: 'own_credits',
    });
  });

  it('POL-7 (partial) a drive rule equal to the org rule applies', () => {
    const org = { ...DEFAULT_ORG_POLICIES, walletFallback: 'seat_allowance' as const };
    expect(driveSpendPolicy(org, { fallback: 'seat_allowance' }).fallback).toBe('seat_allowance');
  });

  it('POL-7 (partial) a drive rule of refuse applies', () => {
    const org = { ...DEFAULT_ORG_POLICIES, walletFallback: 'own_credits' as const };
    expect(driveSpendPolicy(org, { fallback: 'refuse' }).fallback).toBe('refuse');
  });

  it('POL-7 (partial) a drive rule that swaps seat allowance and own credits resolves to refuse', () => {
    const seat = { ...DEFAULT_ORG_POLICIES, walletFallback: 'seat_allowance' as const };
    const own = { ...DEFAULT_ORG_POLICIES, walletFallback: 'own_credits' as const };
    expect(driveSpendPolicy(seat, { fallback: 'own_credits' }).fallback).toBe('refuse');
    expect(driveSpendPolicy(own, { fallback: 'seat_allowance' }).fallback).toBe('refuse');
  });

  it('POL-7 (partial) a drive that states no rule inherits the org rule', () => {
    const org = { ...DEFAULT_ORG_POLICIES, walletFallback: 'own_credits' as const };
    expect(driveSpendPolicy(org, null).fallback).toBe('own_credits');
  });
});
