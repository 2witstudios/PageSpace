/**
 * ADR 0005 §3.3, §10.10 — RED at G1b-store before `plan-store-identity.ts` existed.
 */
import { describe, it, expect } from 'vitest';
import type { TenantId } from '@pagespace/db/schema/agent-accounts';
import { planStoreIdentity } from '../plan-store-identity';

const TENANT = 'user:u1' as TenantId;

describe('planStoreIdentity', () => {
  it('given model A and tier free, should return blastRadius tier', () => {
    const actual = planStoreIdentity({ tenantId: TENANT, tier: 'free', model: 'A' });
    expect(actual.blastRadius).toBe('tier');
  });

  it('given model A and tier paid, should return blastRadius tenant', () => {
    const actual = planStoreIdentity({ tenantId: TENANT, tier: 'paid', model: 'A' });
    expect(actual.blastRadius).toBe('tenant');
  });

  it('given model B, should return blastRadius tenant for both tiers', () => {
    const actual = [
      planStoreIdentity({ tenantId: TENANT, tier: 'free', model: 'B' }).blastRadius,
      planStoreIdentity({ tenantId: TENANT, tier: 'paid', model: 'B' }).blastRadius,
    ];
    expect(actual).toEqual(['tenant', 'tenant']);
  });

  it('given model C, should return blastRadius all', () => {
    const actual = planStoreIdentity({ tenantId: TENANT, tier: 'paid', model: 'C' });
    expect(actual.blastRadius).toBe('all');
  });
});
