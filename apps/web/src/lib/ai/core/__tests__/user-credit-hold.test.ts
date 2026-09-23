import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockCanConsumeAI, mockReleaseHold, mockSelectWhere } = vi.hoisted(() => ({
  mockCanConsumeAI: vi.fn(),
  mockReleaseHold: vi.fn(),
  mockSelectWhere: vi.fn(),
}));

vi.mock('@pagespace/db/db', () => ({
  db: { select: vi.fn(() => ({ from: vi.fn(() => ({ where: mockSelectWhere })) })) },
}));
vi.mock('@pagespace/db/operators', () => ({ eq: vi.fn() }));
vi.mock('@pagespace/db/schema/auth', () => ({ users: { id: 'id', subscriptionTier: 'subscriptionTier' } }));
vi.mock('@pagespace/lib/billing/credit-gate', () => ({ canConsumeAI: mockCanConsumeAI }));
vi.mock('@pagespace/lib/billing/credit-consume', () => ({ releaseHold: mockReleaseHold }));

import { acquireUserCreditHold } from '../user-credit-hold';

beforeEach(() => {
  vi.clearAllMocks();
  mockSelectWhere.mockResolvedValue([{ subscriptionTier: 'pro' }]);
  mockReleaseHold.mockResolvedValue(undefined);
});

describe('acquireUserCreditHold', () => {
  it('given a user, should gate them at their own tier with the caller options', async () => {
    mockCanConsumeAI.mockResolvedValue({ allowed: true, reason: 'ok', holdId: 'h' });

    await acquireUserCreditHold('user-1', { skipDailyCap: true });

    expect(mockCanConsumeAI).toHaveBeenCalledWith('user-1', 'pro', { skipDailyCap: true });
  });

  it('given no user row, should gate at the free tier', async () => {
    mockSelectWhere.mockResolvedValue([]);
    mockCanConsumeAI.mockResolvedValue({ allowed: false, reason: 'needs_init' });

    await acquireUserCreditHold('ghost', {});

    expect(mockCanConsumeAI).toHaveBeenCalledWith('ghost', 'free', {});
  });

  it('given a refusal, should return the gate reason', async () => {
    mockCanConsumeAI.mockResolvedValue({ allowed: false, reason: 'out_of_credits' });

    expect(await acquireUserCreditHold('user-1', {})).toEqual({ allowed: false, reason: 'out_of_credits' });
  });

  it('given release is called twice, should free the hold exactly once', async () => {
    mockCanConsumeAI.mockResolvedValue({ allowed: true, reason: 'ok', holdId: 'hold-1' });

    const hold = await acquireUserCreditHold('user-1', {});
    if (!hold.allowed) throw new Error('expected an allowed hold');
    hold.release();
    hold.release();

    expect(mockReleaseHold).toHaveBeenCalledTimes(1);
    expect(mockReleaseHold).toHaveBeenCalledWith('hold-1');
  });

  it('given an allowed gate with no hold, should release nothing', async () => {
    mockCanConsumeAI.mockResolvedValue({ allowed: true, reason: 'unlimited' });

    const hold = await acquireUserCreditHold('user-1', {});
    if (!hold.allowed) throw new Error('expected an allowed hold');
    hold.release();

    expect(mockReleaseHold).not.toHaveBeenCalled();
  });
});
