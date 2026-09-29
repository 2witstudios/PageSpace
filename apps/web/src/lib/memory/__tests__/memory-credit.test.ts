import { describe, it, expect, vi, beforeEach } from 'vitest';

const { tierRows } = vi.hoisted(() => ({ tierRows: { value: [] as Array<{ subscriptionTier: string }> } }));

vi.mock('@pagespace/db/db', () => ({
  db: { select: () => ({ from: () => ({ where: async () => tierRows.value }) }) },
}));
vi.mock('@pagespace/db/operators', () => ({ eq: vi.fn() }));
vi.mock('@pagespace/db/schema/auth', () => ({ users: { id: 'id', subscriptionTier: 'subscriptionTier' } }));
vi.mock('@pagespace/lib/logging/logger-config', () => ({
  loggers: { api: { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() } },
}));
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
  tierRows.value = [{ subscriptionTier: 'pro' }];
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

  it('reserves as scheduled work, outside the interactive daily cap', async () => {
    await reserveMemoryCall('user-1', { provider: 'openrouter', model: 'm', inputChars: 400 });
    expect(mockGate.mock.calls[0][1]).toMatchObject({ skipDailyCap: true });
  });

  it('refuses a tier without Memory before consulting the credit gate, whatever the provider', async () => {
    tierRows.value = [{ subscriptionTier: 'free' }];
    expect(await reserveMemoryCall('user-free', { provider: 'openrouter', model: 'm', inputChars: 400 })).toEqual({ allowed: false, reason: 'tier_not_eligible' });
    expect(await reserveMemoryCall('user-free', { provider: 'glm', model: 'm', inputChars: 400 })).toEqual({ allowed: false, reason: 'tier_not_eligible' });
    expect(mockGate).not.toHaveBeenCalled();
  });

  it('refuses as gate_error when the gate throws, instead of failing the pass, with nothing reserved', async () => {
    mockGate.mockRejectedValue(new Error('lock timeout'));
    expect(await reserveMemoryCall('user-1', { provider: 'openrouter', model: 'm', inputChars: 400 })).toEqual({ allowed: false, reason: 'gate_error' });
    expect(mockRelease).not.toHaveBeenCalled();
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
