/**
 * An agent drive owner never holds its own Stripe customer (ADR 0007
 * Decision 8): getOrCreateStripeCustomer refuses inside
 * startDedicatedSubscription, and the route answers 403, not a 500.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NextRequest } from 'next/server';

const { mockStart } = vi.hoisted(() => ({ mockStart: vi.fn() }));

vi.mock('@/lib/auth', () => ({
  authenticateRequestWithOptions: vi.fn(async () => ({ userId: 'agent_1', tokenType: 'session' })),
  isAuthError: vi.fn(() => false),
}));
vi.mock('@pagespace/db/db', () => ({
  db: {
    select: () => ({
      from: () => ({ where: () => ({ limit: async () => [{ id: 'agent_1', accountType: 'agent' }] }) }),
    }),
  },
}));
vi.mock('@pagespace/db/operators', () => ({ eq: vi.fn() }));
vi.mock('@pagespace/db/schema/auth', () => ({ users: {} }));
vi.mock('@pagespace/lib/audit/audit-log', () => ({ auditRequest: vi.fn() }));
vi.mock('@pagespace/lib/logging/logger-config', () => ({
  loggers: { api: { info: vi.fn(), error: vi.fn(), warn: vi.fn() } },
}));
vi.mock('@pagespace/lib/billing/sandbox-payer', () => ({ lookupDriveOwnerId: vi.fn(async () => 'agent_1') }));
vi.mock('@pagespace/lib/services/app-hosting/provisioner', () => ({
  getPublishedApp: vi.fn(async () => ({ id: 'app_1', driveId: 'drive_1', guestPreset: 'small' })),
}));
vi.mock('@pagespace/lib/services/app-hosting/dedicated-tier-service', () => ({
  isDedicatedTierPurchasable: vi.fn(() => true),
}));
vi.mock('@/lib/app-hosting/dedicated-subscription', () => ({
  startDedicatedSubscription: (...args: unknown[]) => mockStart(...args),
  cancelDedicatedSubscription: vi.fn(),
}));

import { POST } from '../route';
import { AgentStripeCustomerRefusedError } from '@pagespace/lib/billing/stripe-customer-eligibility';

async function post(): Promise<Response> {
  const response = await POST(
    new Request('https://example.com/api/app-hosting/apps/app_1/dedicated', { method: 'POST' }) as unknown as NextRequest,
    { params: Promise.resolve({ appId: 'app_1' }) },
  );
  if (!response) throw new Error('route returned no response');
  return response;
}

describe('POST /api/app-hosting/apps/[appId]/dedicated — agent owner', () => {
  beforeEach(() => vi.clearAllMocks());

  it('given the Stripe customer helper refuses an agent owner, should answer 403 with the refusal', async () => {
    mockStart.mockRejectedValue(new AgentStripeCustomerRefusedError('agent_1'));

    const response = await post();

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: 'Agent accounts are billed through their owner' });
  });

  it('given any other failure (control), should stay a 500', async () => {
    mockStart.mockRejectedValue(new Error('stripe down'));

    const response = await post();

    expect(response.status).toBe(500);
  });
});
