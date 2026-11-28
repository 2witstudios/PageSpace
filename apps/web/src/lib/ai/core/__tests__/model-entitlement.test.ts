import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * The shared pro-model gate for request-less calls (workflows, mention replies, agent consults): the caller's own
 * tier goes in as the consumer tier, the spend names the funder, and the tier the spend resolution returns decides
 * (POL-8, WAL-8). The resolution itself is proven against real wallets in lib (entitlement-tier.integration.test.ts).
 */
const userRow = vi.hoisted(() => ({ subscriptionTier: 'pro', role: 'user' }));
vi.mock('@pagespace/db/db', () => ({
  db: { select: () => ({ from: () => ({ where: () => ({ limit: async () => [userRow] }) }) }) },
}));
vi.mock('@pagespace/lib/billing/credit-gate', () => ({ resolveEntitlementTier: vi.fn() }));
vi.mock('@/lib/subscription/rate-limit-middleware', () => ({
  requiresProSubscription: (_provider: string, _model: string | undefined, tier: string | undefined, isAdmin: boolean) => !isAdmin && tier === 'free',
}));

import { resolveEntitlementTier } from '@pagespace/lib/billing/credit-gate';
import { modelEntitlement } from '../model-entitlement';

const spend = { kind: 'automation' as const, driveId: 'drive-1' };
const ask = () => modelEntitlement({ userId: 'u1', provider: 'openai', model: 'openai/gpt-6-sol', spend });

describe('modelEntitlement', () => {
  beforeEach(() => {
    userRow.role = 'user';
    vi.mocked(resolveEntitlementTier).mockReset();
  });

  it('POL-8 (partial) WAL-8 (partial) asks the spend resolution for the funder tier, passing the caller\'s own tier and the spend', async () => {
    vi.mocked(resolveEntitlementTier).mockResolvedValue('business');
    expect(await ask()).toEqual({ allowed: true });
    expect(resolveEntitlementTier).toHaveBeenCalledWith('u1', 'pro', spend);
  });

  it('POL-8 (partial) WAL-8 (partial) a funder not entitled to the model is a tier refusal, whatever the caller\'s own tier', async () => {
    vi.mocked(resolveEntitlementTier).mockResolvedValue('free');
    expect(await ask()).toEqual({ allowed: false, reason: 'subscription_required' });
  });

  it('an admin-only provider is a role refusal for a non-admin', async () => {
    vi.mocked(resolveEntitlementTier).mockResolvedValue('business');
    expect(await modelEntitlement({ userId: 'u1', provider: 'glm', model: 'glm-x', spend })).toEqual({ allowed: false, reason: 'provider_admin_only' });
  });
});
