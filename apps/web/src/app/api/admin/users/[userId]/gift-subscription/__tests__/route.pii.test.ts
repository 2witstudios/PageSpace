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

let selectCount = 0;

vi.mock('@pagespace/db', () => {
  const noActiveSelect = {
    from: () => ({
      where: () => ({
        orderBy: () => ({
          limit: () => Promise.resolve([]),
        }),
      }),
    }),
  };
  const activeSelect = {
    from: () => ({
      where: () => ({
        orderBy: () => ({
          limit: () => Promise.resolve([subscriptionRow]),
        }),
      }),
    }),
  };
  const userSelect = {
    from: () => ({
      where: () => Promise.resolve([targetUser]),
    }),
  };

  return {
    db: {
      select: vi.fn(() => {
        selectCount++;
        // POST: 1st call user lookup, 2nd call subscriptions check (should return [])
        // DELETE: 1st user, 2nd active subscription (should return [active])
        if (selectCount % 2 === 1) return userSelect;
        return process.env.__GIFT_TEST_MODE__ === 'delete' ? activeSelect : noActiveSelect;
      }),
    },
    users: {},
    subscriptions: { userId: 'userId', status: 'status', updatedAt: 'updatedAt' },
    eq: vi.fn(),
    and: vi.fn(),
    inArray: vi.fn(),
    desc: vi.fn(),
  };
});

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

vi.mock('@pagespace/lib/server', () => ({
  loggers: {
    api: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    },
  },
  maskEmail: (email: string) => {
    const [local, domain] = email.split('@');
    if (!local || !domain) return '***@***';
    return `${local.slice(0, Math.min(2, local.length))}***@${domain}`;
  },
}));

import { POST, DELETE } from '../route';
import { loggers } from '@pagespace/lib/server';

describe('Gift subscription PII scrub', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    selectCount = 0;
    delete process.env.__GIFT_TEST_MODE__;
  });

  it('POST: masks targetUserEmail and omits targetUserName in "Admin gifted subscription" log', async () => {
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
    process.env.__GIFT_TEST_MODE__ = 'delete';
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
