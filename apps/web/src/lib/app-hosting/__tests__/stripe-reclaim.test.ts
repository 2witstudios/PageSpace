/**
 * A reclaim row that reaches STRIPE_RECLAIM_MAX_ATTEMPTS is a subscription this
 * cron can no longer cancel unattended — the docblock calls that alert-worthy,
 * so this proves the alert actually fires at the threshold and NOT before it.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockCancel, mockUpdate, mockCaptureMessage } = vi.hoisted(() => ({
  mockCancel: vi.fn(),
  mockUpdate: vi.fn(),
  mockCaptureMessage: vi.fn(),
}));

vi.mock('@/lib/stripe', () => ({
  stripe: { subscriptions: { cancel: mockCancel, update: mockUpdate } },
  Stripe: { errors: { StripeInvalidRequestError: class StripeInvalidRequestError extends Error {} } },
}));
vi.mock('@sentry/nextjs', () => ({ captureMessage: mockCaptureMessage }));
vi.mock('@pagespace/lib/logging/logger-config', () => ({
  loggers: { system: { error: vi.fn() } },
}));

type ReclaimRow = {
  stripeSubscriptionId: string;
  publishedAppId: string | null;
  cancelAt: string;
  recordedAt: Date;
  attempts: number;
  lastAttemptAt: Date | null;
  lastError: string | null;
};

function makeRow(overrides: Partial<ReclaimRow> = {}): ReclaimRow {
  return {
    stripeSubscriptionId: 'sub_1',
    publishedAppId: 'app_1',
    cancelAt: 'now',
    recordedAt: new Date(),
    attempts: 0,
    lastAttemptAt: null,
    lastError: null,
    ...overrides,
  };
}

let selectedRows: ReclaimRow[] = [];
// Each compare-and-delete answers the next entry (rows deleted); an empty queue means it matched.
let deleteResults: Array<Array<{ stripeSubscriptionId: string }>> = [];
// What a re-read of one row returns (null: the row is gone).
let rereadRow: ReclaimRow | null = null;
const deleteCalls: number[] = [];
const updateSetCalls: Array<Record<string, unknown>> = [];
// Controls whether the CAS-guarded UPDATE "wins" (returns the updated row, as
// a real `WHERE attempts = row.attempts` match would) or "loses" (returns
// nothing, as it would when another process already advanced the row first).
let updateWinsCAS = true;

vi.mock('@pagespace/db/db', () => ({
  db: {
    select: () => ({
      from: () => ({
        where: () => ({
          orderBy: () => ({
            limit: async () => selectedRows,
          }),
          // The drain's re-read of one row after a compare-and-delete found it changed.
          limit: async () => (rereadRow ? [rereadRow] : []),
        }),
      }),
    }),
    update: () => ({
      set: (values: Record<string, unknown>) => {
        updateSetCalls.push(values);
        return {
          where: () => ({
            returning: async () => (updateWinsCAS ? [{ ...values }] : []),
          }),
        };
      },
    }),
    delete: () => ({
      where: () => ({
        returning: async () => {
          deleteCalls.push(1);
          return deleteResults.shift() ?? [{ stripeSubscriptionId: 'sub_1' }];
        },
      }),
    }),
  },
}));

vi.mock('@pagespace/db/schema/app-hosting-stripe-reclaims', () => ({
  appHostingStripeReclaims: {
    stripeSubscriptionId: 'stripeSubscriptionId',
    cancelAt: 'cancelAt',
    attempts: 'attempts',
    recordedAt: 'recordedAt',
  },
}));

import { drainAppHostingStripeReclaims, STRIPE_RECLAIM_MAX_ATTEMPTS } from '../stripe-reclaim';

beforeEach(() => {
  vi.clearAllMocks();
  selectedRows = [];
  deleteResults = [];
  rereadRow = null;
  deleteCalls.length = 0;
  updateSetCalls.length = 0;
  updateWinsCAS = true;
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

  it('does NOT alert when the CAS loses the race, even though the pre-write computed attempts crossed the threshold', async () => {
    selectedRows = [makeRow({ attempts: STRIPE_RECLAIM_MAX_ATTEMPTS - 1 })];
    mockCancel.mockRejectedValue(new Error('stripe is down'));
    updateWinsCAS = false; // another process already advanced/reset this row first

    const result = await drainAppHostingStripeReclaims();

    expect(result.failed).toBe(1);
    expect(mockCaptureMessage).not.toHaveBeenCalled();
  });

  it('does not alert on a clean cancel', async () => {
    selectedRows = [makeRow({ attempts: STRIPE_RECLAIM_MAX_ATTEMPTS - 1 })];
    mockCancel.mockResolvedValue({ status: 'canceled' });

    const result = await drainAppHostingStripeReclaims();

    expect(result.canceled).toBe(1);
    expect(mockCaptureMessage).not.toHaveBeenCalled();
  });

  it('WAL-9 (partial) a period-end release (its drive left the paying org) sets the subscription to end with the paid period — never an immediate cancel — and clears once Stripe confirms (D-OW-64)', async () => {
    selectedRows = [makeRow({ cancelAt: 'period_end' })];
    mockUpdate.mockResolvedValue({ status: 'active', cancel_at_period_end: true });

    const result = await drainAppHostingStripeReclaims();

    expect(mockUpdate).toHaveBeenCalledWith('sub_1', { cancel_at_period_end: true });
    expect(mockCancel).not.toHaveBeenCalled();
    expect(result).toMatchObject({ canceled: 1, failed: 0 });
  });

  it('a period-end release Stripe did not confirm stays queued and counts as failed', async () => {
    selectedRows = [makeRow({ cancelAt: 'period_end' })];
    mockUpdate.mockResolvedValue({ status: 'active', cancel_at_period_end: false });

    const result = await drainAppHostingStripeReclaims();

    expect(result).toMatchObject({ canceled: 0, failed: 1 });
  });

  it('WAL-9 (partial) a period-end release upgraded to "cancel now" while the drain worked is not discarded: the compare-and-delete misses, the row is re-read and cancelled immediately (D-OW-64)', async () => {
    selectedRows = [makeRow({ cancelAt: 'period_end' })];
    mockUpdate.mockResolvedValue({ status: 'active', cancel_at_period_end: true });
    mockCancel.mockResolvedValue({ status: 'canceled' });
    // The first delete (on cancelAt = period_end) matches nothing: the app was destroyed meanwhile.
    deleteResults = [[], [{ stripeSubscriptionId: 'sub_1' }]];
    rereadRow = makeRow({ cancelAt: 'now' });

    const result = await drainAppHostingStripeReclaims();

    expect(mockUpdate).toHaveBeenCalledWith('sub_1', { cancel_at_period_end: true });
    expect(mockCancel).toHaveBeenCalledWith('sub_1');
    expect(deleteCalls).toHaveLength(2);
    expect(result).toMatchObject({ canceled: 1, failed: 0 });
  });

  it('a row another drain already removed is not re-processed', async () => {
    selectedRows = [makeRow({ cancelAt: 'period_end' })];
    mockUpdate.mockResolvedValue({ status: 'active', cancel_at_period_end: true });
    deleteResults = [[]];
    rereadRow = null;

    const result = await drainAppHostingStripeReclaims();

    expect(mockCancel).not.toHaveBeenCalled();
    expect(result).toMatchObject({ canceled: 1, failed: 0 });
  });
});
