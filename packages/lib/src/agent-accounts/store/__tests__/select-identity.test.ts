/**
 * ADR 0005 §3.3 pinned to D-29 = B — RED at G1b-store before `select-identity.ts` existed.
 */
import { describe, it, expect } from 'vitest';
import type { TenantId } from '@pagespace/db/schema/agent-accounts';
import { selectIdentity } from '../select-identity';

describe('selectIdentity', () => {
  it('given a tenant, should return a dedicated tenant-scoped identity (D-29 = B)', () => {
    const tenantId = 'user:u1' as TenantId;
    const actual = selectIdentity({ tenantId });
    expect(actual).toEqual({ tenantId, identityId: 'tenant-identity:user:u1', blastRadius: 'tenant' });
  });

  it('given a tenant-A identity and a tenant-B reference, should name different identities', () => {
    const a = selectIdentity({ tenantId: 'user:u1' as TenantId });
    const b = selectIdentity({ tenantId: 'user:u2' as TenantId });
    expect(a.identityId).not.toBe(b.identityId);
  });

  it('given the same tenant twice, should return the same identity (pure)', () => {
    const tenantId = 'drive:d1' as TenantId;
    const actual = [selectIdentity({ tenantId }), selectIdentity({ tenantId })];
    expect(actual[0]).toEqual(actual[1]);
  });
});
