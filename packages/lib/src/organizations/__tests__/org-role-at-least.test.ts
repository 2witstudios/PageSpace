import { describe, it, expect } from 'vitest';
import { orgRoleAtLeast } from '../org-roles';

describe('orgRoleAtLeast', () => {
  it('UI-11 (partial): a plain Member is not an org manager; Admin and Owner are', () => {
    expect(orgRoleAtLeast('MEMBER', 'ADMIN')).toBe(false);
    expect(orgRoleAtLeast('ADMIN', 'ADMIN')).toBe(true);
    expect(orgRoleAtLeast('OWNER', 'ADMIN')).toBe(true);
  });

  it('only the Owner meets an OWNER minimum', () => {
    expect(orgRoleAtLeast('ADMIN', 'OWNER')).toBe(false);
    expect(orgRoleAtLeast('OWNER', 'OWNER')).toBe(true);
  });

  it('every role meets a MEMBER minimum', () => {
    for (const role of ['MEMBER', 'ADMIN', 'OWNER'] as const) expect(orgRoleAtLeast(role, 'MEMBER')).toBe(true);
  });

  it('fails closed for a missing or unknown role', () => {
    expect(orgRoleAtLeast(undefined, 'MEMBER')).toBe(false);
    expect(orgRoleAtLeast(null, 'MEMBER')).toBe(false);
    expect(orgRoleAtLeast('GUEST' as never, 'MEMBER')).toBe(false);
  });
});
