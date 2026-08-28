/**
 * A reclaim row that reaches STRIPE_RECLAIM_MAX_ATTEMPTS is a subscription this
 * cron can no longer cancel unattended — the docblock calls that alert-worthy,
 * so this proves the alert actually fires at the threshold and NOT before it.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockCancel, mockCaptureMessage } = vi.hoisted(() => ({
  mockCancel: vi.fn(),
  mockCaptureMessage: vi.fn(),
}));

vi.mock('@/lib/stripe', () => ({
  stripe: { subscriptions: { cancel: mockCancel } },
  Stripe: { errors: { StripeInvalidRequestError: class StripeInvalidRequestError extends Error {} } },
}));
vi.mock('@sentry/nextjs', () => ({ captureMessage: mockCaptureMessage }));
vi.mock('@pagespace/lib/logging/logger-config', () => ({
  loggers: { system: { error: vi.fn() } },
}));

type ReclaimRow = {
  stripeSubscriptionId: string;
  publishedAppId: string | null;
  recordedAt: Date;
  attempts: number;
  lastAttemptAt: Date | null;
  lastError: string | null;
};

function makeRow(overrides: Partial<ReclaimRow> = {}): ReclaimRow {
  return {
    stripeSubscriptionId: 'sub_1',
    publishedAppId: 'app_1',
    recordedAt: new Date(),
    attempts: 0,
    lastAttemptAt: null,
    lastError: null,
    ...overrides,
  };
}

let selectedRows: ReclaimRow[] = [];
const updateSetCalls: Array<Record<string, unknown>> = [];

vi.mock('@pagespace/db/db', () => ({
  db: {
    select: () => ({
      from: () => ({
        where: () => ({
          orderBy: () => ({
            limit: async () => selectedRows,
          }),
        }),
      }),
    }),
    update: () => ({
      set: (values: Record<string, unknown>) => {
        updateSetCalls.push(values);
        return { where: async () => undefined };
      },
    }),
    delete: () => ({ where: async () => undefined }),
  },
}));

vi.mock('@pagespace/db/schema/app-hosting-stripe-reclaims', () => ({
  appHostingStripeReclaims: {
    stripeSubscriptionId: 'stripeSubscriptionId',
    attempts: 'attempts',
    recordedAt: 'recordedAt',
  },
}));

import { drainAppHostingStripeReclaims, STRIPE_RECLAIM_MAX_ATTEMPTS } from '../stripe-reclaim';

beforeEach(() => {
  vi.clearAllMocks();
  selectedRows = [];
  updateSetCalls.length = 0;
});

describe('drainAppHostingStripeReclaims — exhaustion alert', () => {
  it('does NOT alert while a reclaim still has attempts left', async () => {
    selectedRows = [makeRow({ attempts: STRIPE_RECLAIM_MAX_ATTEMPTS - 3 })];
    mockCancel.mockRejectedValue(new Error('stripe is down'));

    const result = await drainAppHostingStripeReclaims();

    expect(result.failed).toBe(1);
    expect(mockCaptureMessage).not.toHaveBeenCalled();
  });

  it('alerts the exact tick a reclaim first reaches the max-attempts threshold', async () => {
    selectedRows = [makeRow({ attempts: STRIPE_RECLAIM_MAX_ATTEMPTS - 1 })];
    mockCancel.mockRejectedValue(new Error('stripe is down'));

    const result = await drainAppHostingStripeReclaims();

    expect(result.failed).toBe(1);
    expect(mockCaptureMessage).toHaveBeenCalledTimes(1);
    const [message, options] = mockCaptureMessage.mock.calls[0];
    expect(message).toMatch(/exhausted/i);
    expect(options.fingerprint).toEqual(['app-hosting-stripe-reclaim-exhausted', 'sub_1']);
    expect(options.extra.attempts).toBe(STRIPE_RECLAIM_MAX_ATTEMPTS);

    // The concurrency guard: the failing update must be scoped to the attempts
    // value it read, so a row that raced ahead concurrently is never clobbered.
    expect(updateSetCalls[0].attempts).toBe(STRIPE_RECLAIM_MAX_ATTEMPTS);
  });

  it('does not alert on a clean cancel', async () => {
    selectedRows = [makeRow({ attempts: STRIPE_RECLAIM_MAX_ATTEMPTS - 1 })];
    mockCancel.mockResolvedValue({ status: 'canceled' });

    const result = await drainAppHostingStripeReclaims();

    expect(result.canceled).toBe(1);
    expect(mockCaptureMessage).not.toHaveBeenCalled();
  });
});
