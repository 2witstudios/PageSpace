/**
 * Unit tests for PII handling in gift-subscription admin routes.
 *
 * users.name/users.email are AES-GCM ciphertext at rest. The route must
 * decrypt the loaded row BEFORE any use — the Stripe coupon name, response
 * messages, and masked log metadata must all receive plaintext, never
 * ciphertext (H1). Also covers the audit-trail details (tier/reason) and the
 * cancel-at-period-end revoke path.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextRequest } from 'next/server';

vi.mock('@/lib/auth', () => ({
  withAdminAuth: <T>(handler: (admin: { id: string }, req: Request, ctx: T) => Promise<Response>) =>
    (req: Request, ctx: T) => handler({ id: 'admin-1' }, req, ctx),
}));

vi.mock('@pagespace/lib/audit/mask-email', () => ({
  maskEmail: (email: string) => {
    const [local, domain] = email.split('@');
    if (!local || !domain) return '***@***';
    return `${local.slice(0, Math.min(2, local.length))}***@${domain}`;
  },
}));

const CIPHERTEXT_EMAIL = 'v1:aabbcc:ciphertext-email';
const CIPHERTEXT_NAME = 'v1:aabbcc:ciphertext-name';
const PLAINTEXT_EMAIL = 'jane@example.com';
const PLAINTEXT_NAME = 'Jane Doe';

// The row as it comes out of the database: encrypted PII.
const targetUser = {
  id: 'user-target',
  name: CIPHERTEXT_NAME,
  email: CIPHERTEXT_EMAIL,
  subscriptionTier: 'free',
};

vi.mock('@pagespace/lib/auth/user-repository', () => ({
  decryptUserRow: vi.fn(async <T extends { email?: string | null; name?: string | null }>(row: T): Promise<T> => ({
    ...row,
    email: row.email === CIPHERTEXT_EMAIL ? PLAINTEXT_EMAIL : row.email,
    name: row.name === CIPHERTEXT_NAME ? PLAINTEXT_NAME : row.name,
  })),
}));

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

vi.mock('@pagespace/db/db', () => ({
  db: {
    select: dbSelectMock,
  },
}));
vi.mock('@pagespace/db/operators', () => ({
  eq: vi.fn(),
  and: vi.fn(),
  inArray: vi.fn(),
  desc: vi.fn(),
}));
vi.mock('@pagespace/db/schema/auth', () => ({
  users: {},
}));
vi.mock('@pagespace/db/schema/subscriptions', () => ({
  subscriptions: { userId: 'userId', status: 'status', updatedAt: 'updatedAt' },
}));

vi.mock('@/lib/stripe', () => ({
  stripe: {
    coupons: {
      create: vi.fn().mockResolvedValue({ id: 'coupon_1' }),
    },
    subscriptions: {
      create: vi.fn().mockResolvedValue({ id: 'sub_new', status: 'active' }),
      cancel: vi.fn().mockResolvedValue({ id: 'sub_stripe_1', status: 'canceled' }),
      update: vi.fn().mockResolvedValue({ id: 'sub_stripe_1', status: 'active', cancel_at_period_end: true }),
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

vi.mock('@pagespace/lib/audit/audit-log', () => ({
  auditRequest: vi.fn(),
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
import { auditRequest } from '@pagespace/lib/audit/audit-log';
import { stripe } from '@/lib/stripe';
import { getOrCreateStripeCustomer } from '@/lib/stripe-customer';

function postRequest(body: unknown) {
  return new NextRequest('http://localhost/api/admin/users/user-target/gift-subscription', {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

function deleteRequest(body?: unknown) {
  return new NextRequest('http://localhost/api/admin/users/user-target/gift-subscription', {
    method: 'DELETE',
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
}

const ctx = { params: Promise.resolve({ userId: 'user-target' }) };

describe('Gift subscription PII handling', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    dbSelectMock.mockReset();
  });

  describe('POST', () => {
    it('decrypts the target user before use: Stripe coupon name and response message get plaintext, never ciphertext (H1)', async () => {
      dbSelectMock
        .mockReturnValueOnce(userSelectThenable)
        .mockReturnValueOnce(noActiveSubsSelect);

      const res = await POST(postRequest({ tier: 'pro', reason: 'thanks' }), ctx);
      const body = await res.json();

      expect(res.status).toBe(200);

      // Coupon name must carry the DECRYPTED email — this used to leak AES-GCM
      // ciphertext into the Stripe dashboard.
      const couponArgs = vi.mocked(stripe.coupons.create).mock.calls[0][0] as { name: string };
      expect(couponArgs.name).toBe(`Gift for ${PLAINTEXT_EMAIL}`);
      expect(couponArgs.name).not.toContain(CIPHERTEXT_EMAIL);

      // The decrypted row (not the ciphertext row) goes to customer lookup.
      expect(vi.mocked(getOrCreateStripeCustomer).mock.calls[0][0]).toMatchObject({
        email: PLAINTEXT_EMAIL,
        name: PLAINTEXT_NAME,
      });

      // Response message uses plaintext name.
      expect(body.message).toBe(`Gifted pro subscription to ${PLAINTEXT_NAME}`);
      expect(JSON.stringify(body)).not.toContain(CIPHERTEXT_EMAIL);
      expect(JSON.stringify(body)).not.toContain(CIPHERTEXT_NAME);
    });

    it('masks the DECRYPTED email (not ciphertext) and omits targetUserName in the log', async () => {
      dbSelectMock
        .mockReturnValueOnce(userSelectThenable)
        .mockReturnValueOnce(noActiveSubsSelect);

      await POST(postRequest({ tier: 'pro', reason: 'thanks' }), ctx);

      const call = vi.mocked(loggers.api.info).mock.calls.find(
        c => c[0] === 'Admin gifted subscription'
      );
      expect(call).toBeDefined();
      const meta = call?.[1] as Record<string, unknown>;
      expect(meta.targetUserEmail).toBe('ja***@example.com');
      expect(meta).not.toHaveProperty('targetUserName');
    });

    it('records tier and reason in the tamper-evident audit trail', async () => {
      dbSelectMock
        .mockReturnValueOnce(userSelectThenable)
        .mockReturnValueOnce(noActiveSubsSelect);

      await POST(postRequest({ tier: 'pro', reason: 'thanks' }), ctx);

      expect(auditRequest).toHaveBeenCalledWith(
        expect.any(Request),
        expect.objectContaining({
          eventType: 'data.write',
          userId: 'admin-1',
          resourceType: 'user',
          resourceId: 'user-target',
          details: expect.objectContaining({
            action: 'gift_subscription',
            tier: 'pro',
            reason: 'thanks',
          }),
        })
      );
    });

    it('rejects an invalid tier with 400', async () => {
      const res = await POST(postRequest({ tier: 'ultra', reason: 'nope' }), ctx);
      expect(res.status).toBe(400);
      expect(dbSelectMock).not.toHaveBeenCalled();
    });
  });

  describe('DELETE', () => {
    it('requires a non-empty reason', async () => {
      const res = await DELETE(deleteRequest(), ctx);
      expect(res.status).toBe(400);
      expect(vi.mocked(stripe.subscriptions.cancel)).not.toHaveBeenCalled();

      const resEmpty = await DELETE(deleteRequest({ reason: '   ' }), ctx);
      expect(resEmpty.status).toBe(400);
    });

    it('masks the DECRYPTED email, cancels immediately by default, and audits reason', async () => {
      dbSelectMock
        .mockReturnValueOnce(userSelectThenable)
        .mockReturnValueOnce(activeSubsSelect);

      const res = await DELETE(deleteRequest({ reason: 'policy violation' }), ctx);
      const body = await res.json();

      expect(res.status).toBe(200);
      expect(vi.mocked(stripe.subscriptions.cancel)).toHaveBeenCalledWith('sub_stripe_1');
      expect(vi.mocked(stripe.subscriptions.update)).not.toHaveBeenCalled();

      const call = vi.mocked(loggers.api.info).mock.calls.find(
        c => c[0] === 'Admin revoked subscription'
      );
      expect(call).toBeDefined();
      const meta = call?.[1] as Record<string, unknown>;
      expect(meta.targetUserEmail).toBe('ja***@example.com');
      expect(meta).not.toHaveProperty('targetUserName');

      // Response message uses plaintext, never ciphertext.
      expect(body.message).toContain(PLAINTEXT_NAME);
      expect(JSON.stringify(body)).not.toContain(CIPHERTEXT_NAME);

      expect(auditRequest).toHaveBeenCalledWith(
        expect.any(Request),
        expect.objectContaining({
          eventType: 'data.write',
          resourceId: 'user-target',
          details: expect.objectContaining({
            action: 'revoke_subscription',
            reason: 'policy violation',
            cancelAtPeriodEnd: false,
          }),
        })
      );
    });

    it('schedules cancel-at-period-end instead of cancelling when requested', async () => {
      dbSelectMock
        .mockReturnValueOnce(userSelectThenable)
        .mockReturnValueOnce(activeSubsSelect);

      const res = await DELETE(deleteRequest({ reason: 'downgrade requested', cancelAtPeriodEnd: true }), ctx);
      const body = await res.json();

      expect(res.status).toBe(200);
      expect(vi.mocked(stripe.subscriptions.update)).toHaveBeenCalledWith('sub_stripe_1', {
        cancel_at_period_end: true,
      });
      expect(vi.mocked(stripe.subscriptions.cancel)).not.toHaveBeenCalled();
      expect(body.cancelAtPeriodEnd).toBe(true);

      expect(auditRequest).toHaveBeenCalledWith(
        expect.any(Request),
        expect.objectContaining({
          details: expect.objectContaining({
            action: 'revoke_subscription',
            cancelAtPeriodEnd: true,
          }),
        })
      );
    });
  });
});
