/**
 * An agent can never buy credits into its own Stripe customer (ADR 0007
 * Decision 8). Runs the REAL getOrCreateStripeCustomer — only Stripe and the db
 * are faked — so removing the helper's refusal turns this red.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NextRequest } from 'next/server';

const { mockCheckoutCreate, mockCustomersCreate, mockCustomersRetrieve, mockSelectWhere } = vi.hoisted(() => ({
  mockCheckoutCreate: vi.fn(),
  mockCustomersCreate: vi.fn(),
  mockCustomersRetrieve: vi.fn(),
  mockSelectWhere: vi.fn(),
}));

vi.mock('@/lib/stripe', () => ({
  stripe: {
    checkout: { sessions: { create: mockCheckoutCreate } },
    customers: { create: mockCustomersCreate, retrieve: mockCustomersRetrieve },
  },
  Stripe: { errors: { StripeError: class extends Error {} } },
}));
vi.mock('@/lib/stripe-errors', () => ({ getUserFriendlyStripeError: vi.fn(() => 'Friendly') }));
vi.mock('@pagespace/db/db', () => ({
  db: {
    select: () => ({ from: () => ({ where: mockSelectWhere }) }),
    update: () => ({ set: () => ({ where: vi.fn().mockResolvedValue(undefined) }) }),
  },
}));
vi.mock('@pagespace/db/operators', () => ({ eq: vi.fn() }));
vi.mock('@pagespace/db/schema/auth', () => ({ users: {} }));
vi.mock('@/lib/auth', () => ({
  authenticateRequestWithOptions: vi.fn(async () => ({ userId: 'agent_1', tokenType: 'session' })),
  isAuthError: vi.fn(() => false),
}));
vi.mock('@pagespace/lib/logging/logger-config', () => ({
  loggers: { api: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } },
}));
vi.mock('@pagespace/lib/audit/audit-log', () => ({ audit: vi.fn(), auditRequest: vi.fn() }));

import { POST } from '../route';
import { CREDIT_PACKS } from '@pagespace/lib/billing/credit-pricing';

const PACK = Object.values(CREDIT_PACKS)[0];
const req = () =>
  new Request('https://example.com/api/stripe/create-credit-topup', {
    method: 'POST',
    body: JSON.stringify({ packId: PACK.id }),
  }) as unknown as NextRequest;

const account = (accountType: 'agent' | 'human') => ({
  id: 'agent_1',
  name: 'Agent',
  email: 'agent_1@agents.pagespace.invalid',
  subscriptionTier: 'free',
  stripeCustomerId: null,
  accountType,
});

describe('POST /api/stripe/create-credit-topup — agent accounts', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCustomersCreate.mockResolvedValue({ id: 'cus_new' });
    mockCheckoutCreate.mockResolvedValue({ id: 'cs_1', url: 'https://checkout.stripe.test/cs_1' });
  });

  it('given an agent, should refuse 403 and never create a Stripe customer or checkout session', async () => {
    mockSelectWhere.mockResolvedValue([account('agent')]);

    const response = await POST(req());

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: 'Agent accounts are billed through their owner' });
    expect(mockCustomersCreate).not.toHaveBeenCalled();
    expect(mockCheckoutCreate).not.toHaveBeenCalled();
  });

  it('given a human (control), should create the customer and the checkout session', async () => {
    mockSelectWhere.mockResolvedValue([account('human')]);

    const response = await POST(req());

    expect(response.status).toBe(200);
    expect(mockCustomersCreate).toHaveBeenCalledTimes(1);
  });
});
