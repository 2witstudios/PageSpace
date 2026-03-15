import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Mock @pagespace/db ────────────────────────────────────────────────────────
// vi.mock is hoisted — must not reference outer variables in factory
vi.mock('@pagespace/db', () => {
  const mockWhere = vi.fn().mockResolvedValue([]);
  const mockSet = vi.fn().mockReturnValue({ where: mockWhere });
  const mockUpdate = vi.fn().mockReturnValue({ set: mockSet });
  return {
    db: { update: mockUpdate },
    eq: vi.fn((col: unknown, val: unknown) => ({ col, val })),
    users: { id: 'id', stripeCustomerId: 'stripeCustomerId', updatedAt: 'updatedAt' },
  };
});

// ── Mock @/lib/stripe ─────────────────────────────────────────────────────────
vi.mock('@/lib/stripe', () => {
  class MockStripeError extends Error {
    code: string;
    constructor(message: string, code: string) {
      super(message);
      this.code = code;
    }
  }

  return {
    stripe: {
      customers: {
        retrieve: vi.fn(),
        create: vi.fn(),
      },
    },
    Stripe: {
      errors: {
        StripeError: MockStripeError,
      },
    },
  };
});

// ── Import under test ─────────────────────────────────────────────────────────
import { getOrCreateStripeCustomer } from '../stripe-customer';
import { db, eq, users } from '@pagespace/db';
import { stripe, Stripe } from '@/lib/stripe';

const mockCustomersRetrieve = stripe.customers.retrieve as ReturnType<typeof vi.fn>;
const mockCustomersCreate = stripe.customers.create as ReturnType<typeof vi.fn>;
const mockDbUpdate = db.update as ReturnType<typeof vi.fn>;

describe('getOrCreateStripeCustomer', () => {
  const baseUser = {
    id: 'user-1',
    email: 'user@example.com',
    name: 'Test User',
    stripeCustomerId: null as string | null,
  };

  beforeEach(() => {
    vi.clearAllMocks();
    // Re-wire the chain each time after clearAllMocks
    const mockWhere = vi.fn().mockResolvedValue([]);
    const mockSet = vi.fn().mockReturnValue({ where: mockWhere });
    mockDbUpdate.mockReturnValue({ set: mockSet });
  });

  it('should create a new customer when stripeCustomerId is null', async () => {
    mockCustomersCreate.mockResolvedValueOnce({ id: 'cus_new123' });

    const result = await getOrCreateStripeCustomer({ ...baseUser, stripeCustomerId: null });

    expect(mockCustomersCreate).toHaveBeenCalledWith({
      email: 'user@example.com',
      name: 'Test User',
      metadata: { userId: 'user-1' },
    });
    expect(result).toBe('cus_new123');
  });

  it('should update the database with new customer id', async () => {
    mockCustomersCreate.mockResolvedValueOnce({ id: 'cus_new456' });

    await getOrCreateStripeCustomer({ ...baseUser, stripeCustomerId: null });

    expect(mockDbUpdate).toHaveBeenCalled();
  });

  it('should return existing customer id when customer still exists in Stripe', async () => {
    mockCustomersRetrieve.mockResolvedValueOnce({ id: 'cus_existing', deleted: false });

    const result = await getOrCreateStripeCustomer({
      ...baseUser,
      stripeCustomerId: 'cus_existing',
    });

    expect(mockCustomersRetrieve).toHaveBeenCalledWith('cus_existing');
    expect(mockCustomersCreate).not.toHaveBeenCalled();
    expect(result).toBe('cus_existing');
  });

  it('should create new customer when existing customer is deleted in Stripe', async () => {
    mockCustomersRetrieve.mockResolvedValueOnce({ id: 'cus_deleted', deleted: true });
    mockCustomersCreate.mockResolvedValueOnce({ id: 'cus_fresh' });

    const result = await getOrCreateStripeCustomer({
      ...baseUser,
      stripeCustomerId: 'cus_deleted',
    });

    expect(mockCustomersCreate).toHaveBeenCalled();
    expect(result).toBe('cus_fresh');
  });

  it('should create new customer when Stripe returns resource_missing error', async () => {
    const notFoundError = new Stripe.errors.StripeError('No such customer', 'resource_missing');
    mockCustomersRetrieve.mockRejectedValueOnce(notFoundError);
    mockCustomersCreate.mockResolvedValueOnce({ id: 'cus_replaced' });

    const result = await getOrCreateStripeCustomer({
      ...baseUser,
      stripeCustomerId: 'cus_stale',
    });

    expect(mockCustomersCreate).toHaveBeenCalled();
    expect(result).toBe('cus_replaced');
  });

  it('should rethrow non-resource_missing Stripe errors', async () => {
    const stripeError = new Stripe.errors.StripeError('API connection failed', 'api_connection_error');
    mockCustomersRetrieve.mockRejectedValueOnce(stripeError);

    await expect(
      getOrCreateStripeCustomer({ ...baseUser, stripeCustomerId: 'cus_x' })
    ).rejects.toThrow('API connection failed');

    expect(mockCustomersCreate).not.toHaveBeenCalled();
  });

  it('should pass undefined name when user name is null', async () => {
    mockCustomersCreate.mockResolvedValueOnce({ id: 'cus_noname' });

    await getOrCreateStripeCustomer({ ...baseUser, name: null, stripeCustomerId: null });

    expect(mockCustomersCreate).toHaveBeenCalledWith(
      expect.objectContaining({ name: undefined })
    );
  });

  it('should not call retrieve when stripeCustomerId is null', async () => {
    mockCustomersCreate.mockResolvedValueOnce({ id: 'cus_new' });

    await getOrCreateStripeCustomer({ ...baseUser, stripeCustomerId: null });

    expect(mockCustomersRetrieve).not.toHaveBeenCalled();
  });

  it('should rethrow generic (non-Stripe) errors thrown during retrieve', async () => {
    const genericError = new Error('Network error');
    mockCustomersRetrieve.mockRejectedValueOnce(genericError);

    await expect(
      getOrCreateStripeCustomer({ ...baseUser, stripeCustomerId: 'cus_x' })
    ).rejects.toThrow('Network error');
  });
});
