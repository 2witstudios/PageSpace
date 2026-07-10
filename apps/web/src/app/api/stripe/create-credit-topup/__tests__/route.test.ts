import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest, NextResponse } from 'next/server';
const createMockRequest = (url: string, init?: RequestInit): NextRequest =>
  new Request(url, init) as unknown as NextRequest;

const { mockCheckoutCreate, mockGetOrCreateStripeCustomer, StripeError } = vi.hoisted(() => {
  const StripeError = class extends Error {
    constructor(message: string) {
      super(message);
      this.name = 'StripeError';
    }
  };
  return {
    mockCheckoutCreate: vi.fn(),
    mockGetOrCreateStripeCustomer: vi.fn(),
    StripeError,
  };
});

vi.mock('@/lib/stripe', () => ({
  stripe: { checkout: { sessions: { create: mockCheckoutCreate } } },
  Stripe: { errors: { StripeError } },
}));

vi.mock('@/lib/stripe-customer', () => ({
  getOrCreateStripeCustomer: mockGetOrCreateStripeCustomer,
}));

vi.mock('@/lib/stripe-errors', () => ({
  getUserFriendlyStripeError: vi.fn(() => 'Friendly stripe error'),
}));

const mockSelectWhere = vi.fn();
vi.mock('@pagespace/db/db', () => ({
  db: {
    select: vi.fn(() => ({
      from: vi.fn(() => ({ where: mockSelectWhere })),
    })),
  },
}));
vi.mock('@pagespace/db/operators', () => ({
  eq: vi.fn((field: unknown, value: unknown) => ({ field, value, type: 'eq' })),
}));
vi.mock('@pagespace/db/schema/auth', () => ({ users: {} }));

vi.mock('@/lib/auth/request-auth', () => ({
  authenticateRequestWithOptions: vi.fn(),
}));
vi.mock('@/lib/auth/auth-core', () => ({
  isAuthError: vi.fn(),
}));

vi.mock('@pagespace/lib/logging/logger-config', () => ({
  loggers: { api: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } },
  logger: { child: vi.fn(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() })) },
}));
vi.mock('@pagespace/lib/audit/audit-log', () => ({ audit: vi.fn(), auditRequest: vi.fn() }));

import { POST } from '../route';
import { auditRequest } from '@pagespace/lib/audit/audit-log';
import { CREDIT_PACKS, CREDIT_TOPUP_MIN_CENTS, CREDIT_TOPUP_MAX_CENTS } from '@pagespace/lib/billing/credit-pricing';
import type { SessionAuthResult, AuthError } from '@/lib/auth/auth-types';
import { authenticateRequestWithOptions } from '@/lib/auth/request-auth';
import { isAuthError } from '@/lib/auth/auth-core';

const mockWebAuth = (userId: string): SessionAuthResult => ({
  userId,
  tokenVersion: 0,
  tokenType: 'session',
  sessionId: 'test-session-id',
  adminRoleVersion: 0,
  role: 'user',
});

const mockAuthError = (status = 401): AuthError => ({
  error: NextResponse.json({ error: 'Unauthorized' }, { status }),
});

const mockUser = (overrides: Partial<{ id: string; email: string; stripeCustomerId: string | null }> = {}) => ({
  id: overrides.id ?? 'user_123',
  name: 'Test User',
  email: overrides.email ?? 'test@example.com',
  subscriptionTier: 'free',
  stripeCustomerId: overrides.stripeCustomerId ?? null,
});

const PACK = Object.values(CREDIT_PACKS)[0]; // e.g. pack_10

describe('POST /api/stripe/create-credit-topup', () => {
  const mockUserId = 'user_123';

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(authenticateRequestWithOptions).mockResolvedValue(mockWebAuth(mockUserId));
    vi.mocked(isAuthError).mockReturnValue(false);
    mockSelectWhere.mockResolvedValue([mockUser()]);
    mockGetOrCreateStripeCustomer.mockResolvedValue('cus_abc');
    mockCheckoutCreate.mockResolvedValue({ id: 'cs_test_123', url: 'https://checkout.stripe.test/cs_test_123' });
  });

  const req = (body: unknown) =>
    createMockRequest('https://example.com/api/stripe/create-credit-topup', {
      method: 'POST',
      body: JSON.stringify(body),
    });

  it('creates a payment-mode checkout session for a known pack and returns its url', async () => {
    const response = await POST(req({ packId: PACK.id }));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.url).toBe('https://checkout.stripe.test/cs_test_123');
    expect(body.sessionId).toBe('cs_test_123');

    expect(mockCheckoutCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        mode: 'payment',
        customer: 'cus_abc',
        metadata: expect.objectContaining({
          kind: 'credit_pack',
          packId: PACK.id,
          packCents: String(PACK.cents),
          userId: mockUserId,
        }),
      }),
    );
  });

  it('prices the line item from the canonical pack cents', async () => {
    await POST(req({ packId: PACK.id }));
    const arg = mockCheckoutCreate.mock.calls[0][0];
    expect(arg.line_items[0].price_data.unit_amount).toBe(PACK.cents);
    expect(arg.line_items[0].price_data.currency).toBe('usd');
  });

  it('returns 400 when packId is missing', async () => {
    const response = await POST(req({}));
    expect(response.status).toBe(400);
    expect((await response.json()).error).toMatch(/packId/i);
    expect(mockCheckoutCreate).not.toHaveBeenCalled();
  });

  it('returns 400 for an unknown pack', async () => {
    const response = await POST(req({ packId: 'pack_does_not_exist' }));
    expect(response.status).toBe(400);
    expect((await response.json()).error).toMatch(/unknown/i);
  });

  it('creates a checkout for a valid custom amount, pricing+metadata from amountCents', async () => {
    const amountCents = 1234; // $12.34, within [min, max]
    const response = await POST(req({ amountCents }));
    expect(response.status).toBe(200);

    const arg = mockCheckoutCreate.mock.calls[0][0];
    expect(arg.line_items[0].price_data.unit_amount).toBe(amountCents);
    expect(arg.metadata).toEqual(
      expect.objectContaining({ kind: 'credit_pack', packId: 'custom', packCents: String(amountCents), userId: mockUserId }),
    );
  });

  it('returns 400 for a custom amount below the minimum', async () => {
    const response = await POST(req({ amountCents: CREDIT_TOPUP_MIN_CENTS - 1 }));
    expect(response.status).toBe(400);
    expect(mockCheckoutCreate).not.toHaveBeenCalled();
  });

  it('returns 400 for a custom amount above the maximum', async () => {
    const response = await POST(req({ amountCents: CREDIT_TOPUP_MAX_CENTS + 1 }));
    expect(response.status).toBe(400);
    expect(mockCheckoutCreate).not.toHaveBeenCalled();
  });

  it('returns 400 for a non-integer custom amount (fractional cents)', async () => {
    const response = await POST(req({ amountCents: 1000.5 }));
    expect(response.status).toBe(400);
    expect(mockCheckoutCreate).not.toHaveBeenCalled();
  });

  it('returns 404 when the user is not found', async () => {
    mockSelectWhere.mockResolvedValue([]);
    const response = await POST(req({ packId: PACK.id }));
    expect(response.status).toBe(404);
  });

  it('returns 401 when not authenticated', async () => {
    vi.mocked(isAuthError).mockReturnValue(true);
    vi.mocked(authenticateRequestWithOptions).mockResolvedValue(mockAuthError(401));
    const response = await POST(req({ packId: PACK.id }));
    expect(response.status).toBe(401);
  });

  it('maps a StripeError to a 400 with a friendly message', async () => {
    mockCheckoutCreate.mockRejectedValue(new StripeError('card declined'));
    const response = await POST(req({ packId: PACK.id }));
    expect(response.status).toBe(400);
    expect((await response.json()).error).toBe('Friendly stripe error');
  });

  it('returns 500 when the session has no url', async () => {
    mockCheckoutCreate.mockResolvedValue({ id: 'cs_no_url' });
    const response = await POST(req({ packId: PACK.id }));
    expect(response.status).toBe(500);
  });

  it('logs an audit event on success', async () => {
    await POST(req({ packId: PACK.id }));
    expect(auditRequest).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        eventType: 'data.write',
        userId: mockUserId,
        resourceType: 'credit_topup',
        resourceId: 'cs_test_123',
      }),
    );
  });
});
