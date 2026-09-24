import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockSelect, mockSelectFrom, mockSelectWhere, mockCanConsumeAI, mockReleaseHold } = vi.hoisted(() => ({
  mockSelect: vi.fn(),
  mockSelectFrom: vi.fn(),
  mockSelectWhere: vi.fn(),
  mockCanConsumeAI: vi.fn(),
  mockReleaseHold: vi.fn(),
}));

vi.mock('@pagespace/db/db', () => ({ db: { select: mockSelect } }));
vi.mock('@pagespace/db/operators', () => ({ eq: vi.fn() }));
vi.mock('@pagespace/db/schema/auth', () => ({ users: { id: 'id', subscriptionTier: 'subscriptionTier' } }));
vi.mock('@pagespace/lib/billing/credit-gate', () => ({ canConsumeAI: mockCanConsumeAI }));
vi.mock('@pagespace/lib/billing/credit-consume', () => ({ releaseHold: mockReleaseHold }));
vi.mock('@pagespace/lib/billing/credit-pricing', () => ({ MAX_CHAT_INFLIGHT: 3 }));

import { acquireMentionCreditHold } from '../mention-credit-gate';

// Northwind: Marcus mentions the Research agent in a Product channel.
const PRODUCT_AUTOMATION = { kind: 'automation', driveId: 'drive-product' };

describe('acquireMentionCreditHold', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mockSelect.mockReturnValue({ from: mockSelectFrom });
    mockSelectFrom.mockReturnValue({ where: mockSelectWhere });
    mockSelectWhere.mockResolvedValue([{ subscriptionTier: 'pro' }]);
    mockReleaseHold.mockResolvedValue(undefined);
  });

  it('SPEND-6 (partial) a channel mention names the channel\'s drive as consumer, never the sender\'s credits', async () => {
    mockCanConsumeAI.mockResolvedValue({ allowed: true, reason: 'ok', holdId: 'hold-1', walletId: 'w-product' });

    await acquireMentionCreditHold({ userId: 'user-marcus', driveId: 'drive-product' });

    expect(mockCanConsumeAI).toHaveBeenCalledWith('user-marcus', 'pro', { spend: PRODUCT_AUTOMATION, maxInFlight: 3 });
  });

  it('SPEND-6 (partial) an allowed mention carries the drive wallet to settle on and releases its hold once', async () => {
    mockCanConsumeAI.mockResolvedValue({ allowed: true, reason: 'ok', holdId: 'hold-1', walletId: 'w-product' });

    const hold = await acquireMentionCreditHold({ userId: 'user-marcus', driveId: 'drive-product' });
    if (!hold.allowed) throw new Error('expected an allowed hold');
    hold.release();
    hold.release();

    expect(hold.creditSpend).toEqual({ spend: PRODUCT_AUTOMATION, walletId: 'w-product' });
    expect(mockReleaseHold).toHaveBeenCalledTimes(1);
    expect(mockReleaseHold).toHaveBeenCalledWith('hold-1');
  });

  it('SPEND-6 (partial) with only the sender funded and the drive wallet empty the mention is skipped, naming why', async () => {
    mockCanConsumeAI.mockResolvedValue({
      allowed: false,
      reason: 'source_refused',
      refusal: { source: 'drive_wallet', reason: 'drive_wallet_empty', options: [] },
    });

    const hold = await acquireMentionCreditHold({ userId: 'user-marcus', driveId: 'drive-product' });

    expect(hold).toEqual({ allowed: false, error: 'AI credit gate denied: source_refused (drive_wallet_empty)' });
    expect(mockCanConsumeAI).toHaveBeenCalledTimes(1);
  });

  it('SPEND-6 (partial) a mention with no drive has no wallet to spend and is skipped without gating anyone', async () => {
    const hold = await acquireMentionCreditHold({ userId: 'user-marcus', driveId: null });

    expect(hold).toEqual({ allowed: false, error: 'AI credit gate denied: no drive to spend' });
    expect(mockCanConsumeAI).not.toHaveBeenCalled();
  });
});
