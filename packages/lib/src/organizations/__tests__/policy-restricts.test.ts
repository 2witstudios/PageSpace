import { describe, it, expect } from 'vitest';
import { DEFAULT_ORG_POLICIES, ORG_POLICY_KEYS, loosenedPolicyKeys, policyChangeOnlyRestricts, type OrgPolicies } from '../policies-core';

/** [D-OW-33] a lapsed org may make restricting changes only: the classifier, field by field. */
const base: OrgPolicies = { ...DEFAULT_ORG_POLICIES };
const at = (patch: Partial<OrgPolicies>): OrgPolicies => ({ ...base, ...patch });
const restricts = (before: Partial<OrgPolicies>, after: Partial<OrgPolicies>) => policyChangeOnlyRestricts(at(before), at(after));

describe('policyChangeOnlyRestricts', () => {
  it('SEAT-9 (partial) guests on -> approve -> off restricts; every reverse step loosens', () => {
    expect(restricts({ guests: 'on' }, { guests: 'approve' })).toBe(true);
    expect(restricts({ guests: 'approve' }, { guests: 'off' })).toBe(true);
    expect(restricts({ guests: 'on' }, { guests: 'off' })).toBe(true);
    expect(restricts({ guests: 'off' }, { guests: 'approve' })).toBe(false);
    expect(restricts({ guests: 'approve' }, { guests: 'on' })).toBe(false);
    expect(restricts({ guests: 'off' }, { guests: 'on' })).toBe(false);
  });

  it('SEAT-9 (partial) raising the Open-drive role floor loosens (it grants more); lowering it restricts', () => {
    expect(restricts({ openDriveRoleFloor: 'view' }, { openDriveRoleFloor: 'edit' })).toBe(false);
    expect(restricts({ openDriveRoleFloor: 'edit' }, { openDriveRoleFloor: 'view' })).toBe(true);
  });

  it('SEAT-9 (partial) lowering the seat allowance restricts; raising it loosens', () => {
    expect(restricts({ seatAllowanceCents: 500 }, { seatAllowanceCents: 100 })).toBe(true);
    expect(restricts({ seatAllowanceCents: 500 }, { seatAllowanceCents: 0 })).toBe(true);
    expect(restricts({ seatAllowanceCents: 100 }, { seatAllowanceCents: 500 })).toBe(false);
  });

  it.each([
    'publicShareLinks',
    'publishWeb',
    'customDomains',
    'agentsAutonomous',
    'crossDriveAgents',
    'cloudSandbox',
    'persistentEnvironments',
    'publishedApps',
  ] as const)('SEAT-9 (partial) turning %s off restricts; turning it on loosens', (key) => {
    expect(restricts({ [key]: true }, { [key]: false })).toBe(true);
    expect(restricts({ [key]: false }, { [key]: true })).toBe(false);
  });

  it.each(['whoCanInvite', 'whoCanCreateDrives'] as const)('SEAT-9 (partial) %s members -> admins restricts; admins -> members loosens', (key) => {
    expect(restricts({ [key]: 'members' }, { [key]: 'admins' })).toBe(true);
    expect(restricts({ [key]: 'admins' }, { [key]: 'members' })).toBe(false);
  });

  it('SEAT-9 (partial) the wallet fallback restricts only toward refuse; any move off refuse or between the two fallbacks loosens', () => {
    expect(restricts({ walletFallback: 'own_credits' }, { walletFallback: 'refuse' })).toBe(true);
    expect(restricts({ walletFallback: 'seat_allowance' }, { walletFallback: 'refuse' })).toBe(true);
    expect(restricts({ walletFallback: 'refuse' }, { walletFallback: 'seat_allowance' })).toBe(false);
    expect(restricts({ walletFallback: 'refuse' }, { walletFallback: 'own_credits' })).toBe(false);
    // Between the two fallbacks neither is a subset of the other: org money vs a person's — not a restriction.
    expect(restricts({ walletFallback: 'own_credits' }, { walletFallback: 'seat_allowance' })).toBe(false);
    expect(restricts({ walletFallback: 'seat_allowance' }, { walletFallback: 'own_credits' })).toBe(false);
  });

  it.each(['modelAllowlist', 'providerAllowlist', 'integrationsAllowlist'] as const)(
    'SEAT-9 (partial) %s: a subset (or a first list where everything was allowed) restricts; adding an entry or clearing the list loosens',
    (key) => {
      expect(restricts({ [key]: null }, { [key]: ['a'] })).toBe(true);
      expect(restricts({ [key]: ['a', 'b'] }, { [key]: ['a'] })).toBe(true);
      expect(restricts({ [key]: ['a', 'b'] }, { [key]: [] })).toBe(true);
      expect(restricts({ [key]: ['a'] }, { [key]: ['a', 'b'] })).toBe(false);
      expect(restricts({ [key]: ['a'] }, { [key]: ['b'] })).toBe(false);
      expect(restricts({ [key]: ['a'] }, { [key]: null })).toBe(false);
    },
  );

  it('SEAT-9 (partial) a mixed change counts as loosening, and names the loosened keys', () => {
    const before = at({ guests: 'on', publishWeb: true });
    const after = at({ guests: 'off', publishWeb: true, seatAllowanceCents: base.seatAllowanceCents + 1 });
    expect(policyChangeOnlyRestricts(before, after)).toBe(false);
    expect(loosenedPolicyKeys(before, after)).toEqual(['seatAllowanceCents']);
  });

  it('SEAT-9 (partial) several restricting keys together restrict; a change that changes nothing loosens nothing', () => {
    expect(restricts({}, { guests: 'off', publicShareLinks: false, cloudSandbox: false, seatAllowanceCents: 0 })).toBe(true);
    expect(policyChangeOnlyRestricts(base, base)).toBe(true);
    expect(loosenedPolicyKeys(base, base)).toEqual([]);
  });

  it('SEAT-9 (partial) every policy key is classified: setting each key to its strictest value from the default never reads as loosening', () => {
    const strictest: OrgPolicies = {
      guests: 'off', publicShareLinks: false, publishWeb: false, customDomains: false, whoCanInvite: 'admins', whoCanCreateDrives: 'admins',
      openDriveRoleFloor: 'view', seatAllowanceCents: 0, walletFallback: 'refuse', modelAllowlist: [], providerAllowlist: [],
      agentsAutonomous: false, crossDriveAgents: false, cloudSandbox: false, persistentEnvironments: false, publishedApps: false, integrationsAllowlist: [],
    };
    expect(Object.keys(strictest).sort()).toEqual([...ORG_POLICY_KEYS].sort());
    expect(loosenedPolicyKeys(base, strictest)).toEqual([]);
    expect(loosenedPolicyKeys(strictest, base).sort()).toEqual(
      ORG_POLICY_KEYS.filter((k) => JSON.stringify(base[k]) !== JSON.stringify(strictest[k])).sort(),
    );
  });
});
