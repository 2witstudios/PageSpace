import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NextRequest } from 'next/server';

const {
  mockRetrieve,
  mockItemCreate,
  mockItemUpdate,
  mockUser,
  mockSubscriptionRow,
  mockUpdateSet,
  mockIsBillingEnabled,
  usersTable,
  subscriptionsTable,
  StripeError,
} = vi.hoisted(() => {
  class StripeError extends Error {
    type: string;
    constructor(message: string, type = 'StripeCardError') {
      super(message);
      this.type = type;
    }
  }
  return {
    mockRetrieve: vi.fn(),
    mockItemCreate: vi.fn(),
    mockItemUpdate: vi.fn(),
    mockUser: vi.fn(),
    mockSubscriptionRow: vi.fn(),
    mockUpdateSet: vi.fn(),
    mockIsBillingEnabled: vi.fn(() => true),
    usersTable: Symbol('users'),
    subscriptionsTable: Symbol('subscriptions'),
    StripeError,
  };
});

vi.mock('stripe', () => ({ default: { errors: { StripeError } } }));
vi.mock('@/lib/stripe', () => ({
  stripe: {
    subscriptions: { retrieve: mockRetrieve },
    subscriptionItems: { create: mockItemCreate, update: mockItemUpdate },
  },
}));
vi.mock('@/lib/stripe-config', () => ({
  stripeConfig: {
    priceIds: { pro: 'price_pro' },
    orgPriceIds: { businessBase: 'price_org', extraSeat: 'price_seat' },
    storageAddonPriceId: 'price_storage',
  },
}));
vi.mock('@pagespace/lib/deployment-mode', () => ({ isBillingEnabled: mockIsBillingEnabled }));

vi.mock('@pagespace/db/db', () => {
  const chain = (table: symbol) => {
    const rows = () => (table === usersTable ? mockUser() : mockSubscriptionRow());
    const node = {
      where: () => node,
      orderBy: () => node,
      limit: () => Promise.resolve(rows()),
      for: () => Promise.resolve(rows()),
      then: (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) => Promise.resolve(rows()).then(resolve, reject),
    };
    return node;
  };
  const client = {
    select: () => ({ from: (table: symbol) => chain(table) }),
    update: () => ({ set: (values: unknown) => { mockUpdateSet(values); return { where: () => Promise.resolve() }; } }),
  };
  return { db: { ...client, transaction: async (cb: (tx: typeof client) => unknown) => cb(client) } };
});
vi.mock('@pagespace/db/operators', () => ({
  eq: vi.fn(), and: vi.fn(), inArray: vi.fn(), desc: vi.fn(),
}));
vi.mock('@pagespace/db/schema/auth', () => ({ users: usersTable }));
vi.mock('@pagespace/db/schema/subscriptions', () => ({ subscriptions: subscriptionsTable }));
vi.mock('@/lib/auth', () => ({
  authenticateRequestWithOptions: vi.fn(async () => ({ userId: 'user_1' })),
  isAuthError: vi.fn(() => false),
}));
vi.mock('@pagespace/lib/logging/logger-config', () => ({
  loggers: { api: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } },
}));
vi.mock('@pagespace/lib/audit/audit-log', () => ({ auditRequest: vi.fn() }));

import { GET, POST } from '../route';

const periodEnd = Math.floor(Date.now() / 1000) + 10 * 86_400;
const row = (over: Record<string, unknown> = {}) => ({
  id: 'sub_row', userId: 'user_1', stripeSubscriptionId: 'sub_1', status: 'active', gifted: false,
  currentPeriodEnd: new Date(periodEnd * 1000),
  stripeStorageItemId: null, storageBlocks: 0, storageGraceBlocks: 0, storageGraceUntil: null, storageRevision: 0,
  ...over,
});
const stripeSub = (storageQuantity: number | null) => ({
  id: 'sub_1',
  status: 'active',
  items: {
    has_more: false,
    data: [
      { id: 'si_pro', price: { id: 'price_pro' }, quantity: 1, current_period_end: periodEnd },
      ...(storageQuantity === null ? [] : [{ id: 'si_storage', price: { id: 'price_storage' }, quantity: storageQuantity, current_period_end: periodEnd }]),
    ],
  },
});
const post = (blocks: unknown) => POST(new Request('http://localhost/api/stripe/storage-addon', {
  method: 'POST',
  body: JSON.stringify({ blocks }),
}) as unknown as NextRequest);

describe('/api/stripe/storage-addon', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockIsBillingEnabled.mockReturnValue(true);
    mockUser.mockReturnValue([{ subscriptionTier: 'pro' }]);
    mockSubscriptionRow.mockReturnValue([row()]);
    mockItemCreate.mockResolvedValue({ id: 'si_storage' });
    mockItemUpdate.mockResolvedValue({});
  });

  it('given a Pro user, GET should offer the add-on with its price', async () => {
    const res = await GET(new Request('http://localhost/api/stripe/storage-addon') as unknown as NextRequest);
    expect(await res.json()).toMatchObject({ available: true, blocks: 0, entitledBlocks: 0, maxBlocks: 20, blockPriceCents: 500 });
  });

  it('given a gifted plan, GET should not offer the add-on and POST should refuse', async () => {
    mockSubscriptionRow.mockReturnValue([row({ gifted: true })]);
    const res = await GET(new Request('http://localhost/api/stripe/storage-addon') as unknown as NextRequest);
    expect(await res.json()).toMatchObject({ available: false, gifted: true });
    expect((await post(1)).status).toBe(403);
    expect(mockItemCreate).not.toHaveBeenCalled();
  });

  it('given a Free user, POST should refuse', async () => {
    mockUser.mockReturnValue([{ subscriptionTier: 'free' }]);
    expect((await post(1)).status).toBe(403);
  });

  it('given an out-of-range quantity, POST should refuse', async () => {
    expect((await post(21)).status).toBe(400);
    expect((await post(1.5)).status).toBe(400);
  });

  it('given a first purchase, POST should create the storage item with a prorated charge and mirror it', async () => {
    mockRetrieve.mockResolvedValue(stripeSub(null));
    const res = await post(2);
    expect(res.status).toBe(200);
    expect(mockItemCreate).toHaveBeenCalledWith(
      expect.objectContaining({ subscription: 'sub_1', price: 'price_storage', quantity: 2, proration_behavior: 'always_invoice', payment_behavior: 'error_if_incomplete' }),
      expect.objectContaining({ idempotencyKey: expect.any(String) }),
    );
    expect(mockUpdateSet).toHaveBeenCalledWith(expect.objectContaining({ stripeStorageItemId: 'si_storage', storageBlocks: 2, storageRevision: 1 }));
    expect(await res.json()).toMatchObject({ blocks: 2, entitledBlocks: 2, charged: true });
  });

  it('given a decrease, POST should lower Stripe without proration and keep the paid blocks until period end', async () => {
    mockSubscriptionRow.mockReturnValue([row({ stripeStorageItemId: 'si_storage', storageBlocks: 3 })]);
    mockRetrieve.mockResolvedValue(stripeSub(3));
    const res = await post(1);
    expect(mockItemUpdate).toHaveBeenCalledWith('si_storage', expect.objectContaining({ quantity: 1, proration_behavior: 'none' }), expect.anything());
    expect(await res.json()).toMatchObject({ blocks: 1, entitledBlocks: 3, charged: false, graceUntil: new Date(periodEnd * 1000).toISOString() });
  });

  it('given a declined card, POST should answer 402 and store nothing', async () => {
    mockRetrieve.mockResolvedValue(stripeSub(null));
    mockItemCreate.mockRejectedValue(new StripeError('Your card was declined.'));
    const res = await post(1);
    expect(res.status).toBe(402);
    expect(await res.json()).toMatchObject({ error: 'Your card was declined.' });
    expect(mockUpdateSet).not.toHaveBeenCalled();
  });

  it('given a subscription with a stranger item, POST should refuse to touch it', async () => {
    mockRetrieve.mockResolvedValue({
      ...stripeSub(null),
      items: { has_more: false, data: [...stripeSub(null).items.data, { id: 'si_x', price: { id: 'price_other' }, quantity: 1 }] },
    });
    expect((await post(1)).status).toBe(409);
    expect(mockItemCreate).not.toHaveBeenCalled();
  });

  it('given billing is off (tenant/on-prem), POST should not exist', async () => {
    mockIsBillingEnabled.mockReturnValue(false);
    expect((await post(1)).status).toBe(404);
  });
});
