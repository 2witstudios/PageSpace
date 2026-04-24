/**
 * Unit tests for PII scrubbing in gift-subscription admin routes.
 * Asserts that targetUser.email is masked and targetUserName is omitted from log metadata.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextRequest } from 'next/server';

vi.mock('@/lib/auth', () => ({
  withAdminAuth: <T>(handler: (admin: { id: string }, req: Request, ctx: T) => Promise<Response>) =>
    (req: Request, ctx: T) => handler({ id: 'admin-1' }, req, ctx),
}));

const targetUser = {
  id: 'user-target',
  name: 'Jane Doe',
  email: 'jane@example.com',
  subscriptionTier: 'free',
};

const subscriptionRow = {
  id: 'sub-row-1',
  userId: 'user-target',
  stripeSubscriptionId: 'sub_stripe_1',
  status: 'active',
};

const userSelectThenable = {
  from: () => ({
    where: () => Promise.resolve([targetUser]),
  }),
};

const noActiveSubsSelect = {
  from: () => ({
    where: () => ({
      orderBy: () => ({
        limit: () => Promise.resolve([]),
      }),
    }),
  }),
};

const activeSubsSelect = {
  from: () => ({
    where: () => ({
      orderBy: () => ({
        limit: () => Promise.resolve([subscriptionRow]),
      }),
    }),
  }),
};

const { dbSelectMock } = vi.hoisted(() => ({ dbSelectMock: vi.fn() }));

vi.mock('@pagespace/db', () => ({
  db: {
    select: dbSelectMock,
  },
  users: {},
  subscriptions: { userId: 'userId', status: 'status', updatedAt: 'updatedAt' },
  eq: vi.fn(),
  and: vi.fn(),
  inArray: vi.fn(),
  desc: vi.fn(),
}));

vi.mock('@/lib/stripe', () => ({
  stripe: {
    coupons: {
      create: vi.fn().mockResolvedValue({ id: 'coupon_1' }),
    },
    subscriptions: {
      create: vi.fn().mockResolvedValue({ id: 'sub_new', status: 'active' }),
      cancel: vi.fn().mockResolvedValue({ id: 'sub_stripe_1', status: 'canceled' }),
    },
  },
  Stripe: { errors: { StripeError: class extends Error {} } },
}));

vi.mock('@/lib/stripe-customer', () => ({
  getOrCreateStripeCustomer: vi.fn().mockResolvedValue('cus_1'),
}));

vi.mock('@/lib/stripe-errors', () => ({
  getUserFriendlyStripeError: (e: Error) => e.message,
}));

vi.mock('@/lib/stripe-config', () => ({
  stripeConfig: {
    priceIds: { pro: 'price_pro', founder: 'price_founder', business: 'price_business' },
  },
}));

vi.mock('@pagespace/lib/logging/logger-config', () => ({
  loggers: {
      api: {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      },
    },

  logger: { child: vi.fn(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() })) },
}));

import { POST, DELETE } from '../route';
import { loggers } from '@pagespace/lib/logging/logger-config';

describe('Gift subscription PII scrub', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    dbSelectMock.mockReset();
  });

  it('POST: masks targetUserEmail and omits targetUserName in "Admin gifted subscription" log', async () => {
    dbSelectMock
      .mockReturnValueOnce(userSelectThenable)
      .mockReturnValueOnce(noActiveSubsSelect);

    const req = new NextRequest('http://localhost/api/admin/users/user-target/gift-subscription', {
      method: 'POST',
      body: JSON.stringify({ tier: 'pro', reason: 'thanks' }),
    });
    const ctx = { params: Promise.resolve({ userId: 'user-target' }) };
    await POST(req, ctx);

    const call = vi.mocked(loggers.api.info).mock.calls.find(
      c => c[0] === 'Admin gifted subscription'
    );
    expect(call).toBeDefined();
    const meta = call?.[1] as Record<string, unknown>;
    expect(meta.targetUserEmail).toBe('ja***@example.com');
    expect(meta).not.toHaveProperty('targetUserName');
  });

  it('DELETE: masks targetUserEmail and omits targetUserName in "Admin revoked subscription" log', async () => {
    dbSelectMock
      .mockReturnValueOnce(userSelectThenable)
      .mockReturnValueOnce(activeSubsSelect);

    const req = new NextRequest('http://localhost/api/admin/users/user-target/gift-subscription', {
      method: 'DELETE',
    });
    const ctx = { params: Promise.resolve({ userId: 'user-target' }) };
    await DELETE(req, ctx);

    const call = vi.mocked(loggers.api.info).mock.calls.find(
      c => c[0] === 'Admin revoked subscription'
    );
    expect(call).toBeDefined();
    const meta = call?.[1] as Record<string, unknown>;
    expect(meta.targetUserEmail).toBe('ja***@example.com');
    expect(meta).not.toHaveProperty('targetUserName');
  });
});
