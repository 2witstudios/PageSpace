import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Stripe } from '@/lib/stripe';

const { mockFindByStripeId, mockRecord, mockSync, mockResolvePayer } = vi.hoisted(() => ({
  mockFindByStripeId: vi.fn(),
  mockRecord: vi.fn(),
  mockSync: vi.fn(),
  mockResolvePayer: vi.fn(),
}));

vi.mock('@sentry/nextjs', () => ({ captureMessage: vi.fn() }));
vi.mock('@pagespace/lib/logging/logger-config', () => ({
  loggers: { api: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } },
}));
vi.mock('@pagespace/lib/services/app-hosting/dedicated-tier-service', () => ({
  findDedicatedSubscriptionByStripeId: mockFindByStripeId,
  recordDedicatedSubscription: mockRecord,
  syncAppTierToSubscription: mockSync,
  resolveDedicatedPayer: mockResolvePayer,
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
  // The real rule: the mirror's own buyer and org when it exists; else the app's drive payer.
  mockResolvePayer.mockImplementation(async ({ mirror }: { mirror: { userId: string | null; orgId: string | null } | null }) =>
    mirror ? { userId: mirror.userId, orgId: mirror.orgId } : { userId: null, orgId: 'org_northwind' });
});

describe('handleDedicatedSubscriptionEvent — who the mirror says pays (WAL-9, D-OW-64)', () => {
  it('WAL-9 (partial) an org drive\'s subscription with no mirror yet is mirrored with the org its app\'s drive bills — never metadata\'s userId', async () => {
    await handleDedicatedSubscriptionEvent(
      subscription({ kind: 'published_app_dedicated', publishedAppId: 'app_1', guestPreset: 'small', userId: 'user_admin', orgId: 'org_forged' }),
      'evt_1',
      NOW,
    );
    expect(mockResolvePayer).toHaveBeenCalledWith({ mirror: null, publishedAppId: 'app_1' });
    expect(mockRecord).toHaveBeenCalledWith(expect.objectContaining({ publishedAppId: 'app_1', orgId: 'org_northwind', userId: null }));
  });

  it('WAL-9 (partial) a buyer who deleted their account stays null: the stored row wins over metadata\'s stale userId, and the tier still syncs', async () => {
    mockFindByStripeId.mockResolvedValue({ publishedAppId: 'app_1', userId: null, orgId: 'org_northwind', guestPreset: 'small', stripePriceId: 'price_small' });
    await handleDedicatedSubscriptionEvent(subscription({ kind: 'published_app_dedicated', publishedAppId: 'app_1', guestPreset: 'small', userId: 'deleted_admin' }), 'evt_2', NOW);
    expect(mockRecord).toHaveBeenCalledWith(expect.objectContaining({ orgId: 'org_northwind', userId: null }));
    expect(mockSync).toHaveBeenCalledTimes(1);
  });

  it('a subscription whose app is gone resolves no payer and is acked without a write', async () => {
    mockResolvePayer.mockResolvedValue(null);
    await handleDedicatedSubscriptionEvent(subscription({ kind: 'published_app_dedicated', publishedAppId: 'app_1', guestPreset: 'small' }), 'evt_3', NOW);
    expect(mockRecord).not.toHaveBeenCalled();
  });
});
