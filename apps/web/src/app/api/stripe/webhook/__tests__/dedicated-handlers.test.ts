import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Stripe } from '@/lib/stripe';

const { mockFindByStripeId, mockRecord, mockSync } = vi.hoisted(() => ({
  mockFindByStripeId: vi.fn(),
  mockRecord: vi.fn(),
  mockSync: vi.fn(),
}));

vi.mock('@sentry/nextjs', () => ({ captureMessage: vi.fn() }));
vi.mock('@pagespace/lib/logging/logger-config', () => ({
  loggers: { api: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } },
}));
vi.mock('@pagespace/lib/services/app-hosting/dedicated-tier-service', () => ({
  findDedicatedSubscriptionByStripeId: mockFindByStripeId,
  recordDedicatedSubscription: mockRecord,
  syncAppTierToSubscription: mockSync,
}));

import { handleDedicatedSubscriptionEvent } from '../dedicated-handlers';

const NOW = Math.floor(Date.now() / 1000);

function subscription(metadata: Record<string, string>): Stripe.Subscription {
  return {
    id: 'sub_1',
    status: 'active',
    metadata,
    cancel_at_period_end: false,
    items: { data: [{ price: { id: 'price_small' }, current_period_start: NOW, current_period_end: NOW + 30 * 86_400 }] },
  } as unknown as Stripe.Subscription;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockFindByStripeId.mockResolvedValue(null);
  mockRecord.mockResolvedValue({ outcome: 'applied', row: { status: 'active' } });
  mockSync.mockResolvedValue({ outcome: 'unchanged' });
});

describe('handleDedicatedSubscriptionEvent — who the mirror says pays (WAL-9)', () => {
  it('WAL-9 (partial) an org drive\'s subscription is mirrored with the org it bills and the person who bought it', async () => {
    await handleDedicatedSubscriptionEvent(
      subscription({ kind: 'published_app_dedicated', publishedAppId: 'app_1', guestPreset: 'small', userId: 'user_admin', orgId: 'org_northwind' }),
      'evt_1',
      NOW,
    );
    expect(mockRecord).toHaveBeenCalledWith(expect.objectContaining({ publishedAppId: 'app_1', orgId: 'org_northwind', userId: 'user_admin' }));
  });

  it('WAL-9 (partial) an org subscription whose buyer is gone still resolves through the org on the mirror row', async () => {
    mockFindByStripeId.mockResolvedValue({ publishedAppId: 'app_1', userId: null, orgId: 'org_northwind', guestPreset: 'small', stripePriceId: 'price_small' });
    await handleDedicatedSubscriptionEvent(subscription({ kind: 'published_app_dedicated' }), 'evt_2', NOW);
    expect(mockRecord).toHaveBeenCalledWith(expect.objectContaining({ orgId: 'org_northwind', userId: null }));
  });

  it('a subscription naming no payer at all — neither a person nor an org — is acked without a write', async () => {
    await handleDedicatedSubscriptionEvent(subscription({ kind: 'published_app_dedicated', publishedAppId: 'app_1', guestPreset: 'small' }), 'evt_3', NOW);
    expect(mockRecord).not.toHaveBeenCalled();
  });
});
