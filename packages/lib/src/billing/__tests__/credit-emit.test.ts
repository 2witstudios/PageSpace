import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mockIsBillingEnabled = vi.hoisted(() => vi.fn(() => true));
const mockGetCreditBalance = vi.hoisted(() => vi.fn());
const mockResolveTier = vi.hoisted(() => vi.fn());
const mockAiLogger = vi.hoisted(() => ({ debug: vi.fn(), error: vi.fn() }));

vi.mock('../../deployment-mode', () => ({ isBillingEnabled: mockIsBillingEnabled }));
vi.mock('../../logging/logger-config', () => ({ loggers: { ai: mockAiLogger } }));
vi.mock('../../auth/broadcast-auth', () => ({
  // The HMAC signing itself is covered by broadcast-auth's own tests; here we only
  // care that emit signs and posts. Return a deterministic header.
  createSignedBroadcastHeaders: vi.fn(() => ({
    'Content-Type': 'application/json',
    'X-Broadcast-Signature': 't=1,v1=sig',
  })),
}));
vi.mock('../credit-balance', () => ({
  getCreditBalance: mockGetCreditBalance,
  resolveTier: mockResolveTier,
}));

import { emitCreditsUpdated } from '../credit-emit';

const SUMMARY = {
  billingEnabled: true,
  monthly: { remaining: 300, allowance: 500, periodEnd: '2026-07-01T00:00:00.000Z' },
  topup: { remaining: 1200 },
  spendable: 1500,
  reserved: 25,
};

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.clearAllMocks();
  mockIsBillingEnabled.mockReturnValue(true);
  mockResolveTier.mockResolvedValue('pro');
  mockGetCreditBalance.mockResolvedValue(SUMMARY);
  process.env.INTERNAL_REALTIME_URL = 'http://realtime.test';
  fetchMock = vi.fn().mockResolvedValue({ ok: true });
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.INTERNAL_REALTIME_URL;
});

function postedBody() {
  const [, init] = fetchMock.mock.calls[0];
  return JSON.parse((init as { body: string }).body);
}

describe('emitCreditsUpdated', () => {
  it('is a no-op when billing is disabled (no balance read, no broadcast)', async () => {
    mockIsBillingEnabled.mockReturnValue(false);
    await emitCreditsUpdated('u1');
    expect(mockGetCreditBalance).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('recomputes the balance and POSTs a credits:updated event to the user channel', async () => {
    await emitCreditsUpdated('u1');

    expect(mockResolveTier).toHaveBeenCalledWith('u1');
    expect(mockGetCreditBalance).toHaveBeenCalledWith('u1', 'pro');

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('http://realtime.test/api/broadcast');
    expect((init as { method: string }).method).toBe('POST');

    const body = postedBody();
    expect(body.channelId).toBe('notifications:u1');
    expect(body.event).toBe('credits:updated');
    expect(body.payload).toMatchObject({
      userId: 'u1',
      operation: 'updated',
      billingEnabled: true,
      spendable: 1500,
      reserved: 25,
      monthly: SUMMARY.monthly,
      topup: SUMMARY.topup,
    });
    // Scopeless by default: no conversation/page hints leak when not provided.
    expect(body.payload.conversationId).toBeUndefined();
    expect(body.payload.pageId).toBeUndefined();
  });

  it('skips the tier lookup when a tier is supplied', async () => {
    await emitCreditsUpdated('u1', { tier: 'free' });
    expect(mockResolveTier).not.toHaveBeenCalled();
    expect(mockGetCreditBalance).toHaveBeenCalledWith('u1', 'free');
  });

  it('carries conversation/page scope when provided (per-conversation usage monitor)', async () => {
    await emitCreditsUpdated('u1', { conversationId: 'c1', pageId: 'p1' });
    const body = postedBody();
    expect(body.payload.conversationId).toBe('c1');
    expect(body.payload.pageId).toBe('p1');
  });

  it('never throws when the broadcast fails (best-effort fire-and-forget)', async () => {
    fetchMock.mockRejectedValue(new Error('network down'));
    await expect(emitCreditsUpdated('u1')).resolves.toBeUndefined();
    expect(mockAiLogger.debug).toHaveBeenCalled();
  });

  it('records a dropped broadcast when the realtime server returns non-2xx', async () => {
    // A 4xx/5xx must not look like success: it should hit the catch path and log,
    // not silently pass (the only signal the navbar push was dropped).
    fetchMock.mockResolvedValue({ ok: false, status: 503 });
    await expect(emitCreditsUpdated('u1')).resolves.toBeUndefined();
    expect(mockAiLogger.debug).toHaveBeenCalled();
  });
});
