/**
 * The pure half of the ONE org authorization function (Spec ORG-5): decideOrgRole and the
 * boolean form every org service asks (holdsOrgRole). No IO.
 */
import { describe, it, expect } from 'vitest';
import type { OrgRole } from '@pagespace/db/schema/organizations';
import { decideOrgRole, holdsOrgRole } from '../authorize-core';

const ROLES: readonly (OrgRole | null)[] = [null, 'MEMBER', 'ADMIN', 'OWNER'];
const MINS: readonly OrgRole[] = ['MEMBER', 'ADMIN', 'OWNER'];
const RANK: Record<OrgRole, number> = { MEMBER: 1, ADMIN: 2, OWNER: 3 };

describe('authorize-core', () => {
  it('ORG-5 (partial) holdsOrgRole is exactly decideOrgRole(...).ok for every role and minimum', () => {
    for (const role of ROLES) {
      for (const min of MINS) {
        const expected = role !== null && RANK[role] >= RANK[min];
        expect(holdsOrgRole(role, min)).toBe(expected);
        expect(decideOrgRole({ membershipRole: role, minRole: min }).ok).toBe(expected);
      }
    }
  });

  it('ORG-5 (partial) a missing or unknown role never holds any org role (fails closed)', () => {
    expect(holdsOrgRole(undefined, 'MEMBER')).toBe(false);
    expect(holdsOrgRole('GUEST' as OrgRole, 'MEMBER')).toBe(false);
    expect(decideOrgRole({ membershipRole: 'GUEST' as OrgRole, minRole: 'MEMBER' })).toEqual({ ok: false, status: 403, reason: 'insufficient_role' });
  });
});
