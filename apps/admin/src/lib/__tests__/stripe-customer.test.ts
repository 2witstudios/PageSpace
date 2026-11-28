import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockRetrieve, mockCreate, mockUpdateWhere } = vi.hoisted(() => ({
  mockRetrieve: vi.fn(),
  mockCreate: vi.fn(),
  mockUpdateWhere: vi.fn(),
}));

vi.mock('@/lib/stripe', () => ({
  stripe: { customers: { retrieve: mockRetrieve, create: mockCreate } },
  Stripe: { errors: { StripeError: class extends Error {} } },
}));
vi.mock('@pagespace/db/db', () => ({
  db: { update: () => ({ set: () => ({ where: mockUpdateWhere }) }) },
}));
vi.mock('@pagespace/db/operators', () => ({ eq: vi.fn() }));
vi.mock('@pagespace/db/schema/auth', () => ({ users: {} }));

import { getOrCreateStripeCustomer } from '../stripe-customer';
import { AgentStripeCustomerRefusedError } from '@pagespace/lib/billing/stripe-customer-eligibility';

const user = (overrides: Partial<Parameters<typeof getOrCreateStripeCustomer>[0]> = {}) => ({
  id: 'user_1',
  email: 'a@example.com',
  name: 'A',
  stripeCustomerId: null,
  accountType: 'human' as const,
  ...overrides,
});

describe('getOrCreateStripeCustomer (admin)', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mockCreate.mockResolvedValue({ id: 'cus_new' });
    mockUpdateWhere.mockResolvedValue(undefined);
  });

  it('given an agent account, should refuse before any Stripe call', async () => {
    await expect(
      getOrCreateStripeCustomer(user({ id: 'agent_1', accountType: 'agent' })),
    ).rejects.toBeInstanceOf(AgentStripeCustomerRefusedError);
    expect(mockCreate).not.toHaveBeenCalled();
    expect(mockRetrieve).not.toHaveBeenCalled();
  });

  it('given an agent that already holds a customer id, should still refuse without retrieving it', async () => {
    await expect(
      getOrCreateStripeCustomer(user({ accountType: 'agent', stripeCustomerId: 'cus_old' })),
    ).rejects.toBeInstanceOf(AgentStripeCustomerRefusedError);
    expect(mockRetrieve).not.toHaveBeenCalled();
  });

  it('given a human with no customer, should create one and return its id', async () => {
    expect(await getOrCreateStripeCustomer(user())).toBe('cus_new');
    expect(mockCreate).toHaveBeenCalledWith({ email: 'a@example.com', name: 'A', metadata: { userId: 'user_1' } });
  });
});
