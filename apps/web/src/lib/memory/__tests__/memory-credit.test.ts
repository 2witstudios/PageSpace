import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/ai/core/user-credit-hold', () => ({ gateUserCall: vi.fn() }));
vi.mock('@pagespace/lib/billing/credit-consume', () => ({ releaseHold: vi.fn(async () => undefined) }));
vi.mock('@pagespace/lib/monitoring/chat-pricing', () => ({ estimateChatHoldCentsForModel: vi.fn(() => 4) }));

import { gateUserCall } from '@/lib/ai/core/user-credit-hold';
import { releaseHold } from '@pagespace/lib/billing/credit-consume';
import { PERSONAL_SPEND } from '@pagespace/lib/billing/spend-target';
import { reserveMemoryCall } from '../memory-credit';

const mockGate = vi.mocked(gateUserCall);
const mockRelease = vi.mocked(releaseHold);

beforeEach(() => {
  vi.clearAllMocks();
  mockGate.mockResolvedValue({ allowed: true, reason: 'ok', holdId: 'hold-1', walletId: 'w-root' });
});

describe('reserveMemoryCall — the nightly memory cron reserves before each model call', () => {
  it('SPEND-8 (partial) a memory call reserves on the person\'s own credits, outside any drive', async () => {
    const r = await reserveMemoryCall('user-1', { provider: 'openrouter', model: 'm', inputChars: 400 });
    expect(mockGate).toHaveBeenCalledOnce();
    const [userId, opts] = mockGate.mock.calls[0];
    expect(userId).toBe('user-1');
    expect(opts.spend).toEqual(PERSONAL_SPEND);
    expect(opts.estCostCents).toBe(4);
    expect(r).toMatchObject({ allowed: true, holdId: 'hold-1', walletId: 'w-root' });
  });

  it('SPEND-1 (partial) an exhausted person\'s memory call is refused, with nothing reserved', async () => {
    mockGate.mockResolvedValue({ allowed: false, reason: 'out_of_credits' });
    expect(await reserveMemoryCall('user-1', { provider: 'openrouter', model: 'm', inputChars: 400 })).toEqual({ allowed: false, reason: 'out_of_credits' });
  });

  it('release frees the reservation once, however often it is called', async () => {
    const r = await reserveMemoryCall('user-1', { provider: 'openrouter', model: 'm', inputChars: 400 });
    if (!r.allowed) throw new Error('expected an allowed reservation');
    r.release();
    r.release();
    expect(mockRelease).toHaveBeenCalledOnce();
    expect(mockRelease).toHaveBeenCalledWith('hold-1');
  });

  it('a flat-rate (metering-exempt) provider reserves nothing', async () => {
    const r = await reserveMemoryCall('user-1', { provider: 'glm', model: 'm', inputChars: 400 });
    expect(mockGate).not.toHaveBeenCalled();
    expect(r).toMatchObject({ allowed: true, holdId: undefined, walletId: undefined });
    if (r.allowed) r.release();
    expect(mockRelease).not.toHaveBeenCalled();
  });
});
