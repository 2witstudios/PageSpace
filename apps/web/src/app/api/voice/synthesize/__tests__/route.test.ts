import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Mocks ────────────────────────────────────────────────────────────────────
const {
  mockAuth,
  mockIsAuthError,
  mockGetManagedKey,
  mockIsBillingEnabled,
  mockGetUserSettings,
  mockCanConsumeAI,
  mockReleaseHold,
  mockTrackUsage,
  mockEmitCreditsUpdated,
} = vi.hoisted(() => ({
  mockAuth: vi.fn(),
  mockIsAuthError: vi.fn(),
  mockGetManagedKey: vi.fn(),
  mockIsBillingEnabled: vi.fn(),
  mockGetUserSettings: vi.fn(),
  mockCanConsumeAI: vi.fn(),
  mockReleaseHold: vi.fn(),
  mockTrackUsage: vi.fn(),
  mockEmitCreditsUpdated: vi.fn(),
}));

vi.mock('@/lib/auth', () => ({
  authenticateRequestWithOptions: mockAuth,
  isAuthError: mockIsAuthError,
}));
vi.mock('@/lib/ai/core/ai-utils', () => ({ getManagedProviderKey: mockGetManagedKey }));
vi.mock('@pagespace/lib/deployment-mode', () => ({ isBillingEnabled: mockIsBillingEnabled }));
vi.mock('@/lib/repositories/ai-settings-repository', () => ({
  aiSettingsRepository: { getUserSettings: mockGetUserSettings },
}));
vi.mock('@/lib/subscription/rate-limit-middleware', () => ({
  PAID_TIERS: new Set(['pro', 'founder', 'business']),
}));
vi.mock('@pagespace/lib/billing/credit-gate', () => ({ canConsumeAI: mockCanConsumeAI }));
vi.mock('@pagespace/lib/billing/credit-consume', () => ({ releaseHold: mockReleaseHold }));
vi.mock('@pagespace/lib/monitoring/ai-monitoring', () => ({
  AIMonitoring: { trackUsage: mockTrackUsage },
}));
vi.mock('@/lib/subscription/credit-balance', () => ({ emitCreditsUpdated: mockEmitCreditsUpdated }));
vi.mock('@pagespace/lib/audit/audit-log', () => ({ auditRequest: vi.fn() }));
vi.mock('@pagespace/lib/logging/logger-config', () => ({
  loggers: { ai: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } },
}));

import { POST } from '../route';

function ttsRequest(body: Record<string, unknown>) {
  return new Request('http://localhost/api/voice/synthesize', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function okAudioFetch() {
  return vi.fn().mockResolvedValue({
    ok: true,
    arrayBuffer: () => Promise.resolve(new ArrayBuffer(16)),
  });
}

describe('POST /api/voice/synthesize — metering', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuth.mockResolvedValue({ userId: 'u1' });
    mockIsAuthError.mockReturnValue(false);
    mockGetManagedKey.mockReturnValue({ apiKey: 'sk-test' });
    mockIsBillingEnabled.mockReturnValue(true);
    mockGetUserSettings.mockResolvedValue({ subscriptionTier: 'pro' });
    mockCanConsumeAI.mockResolvedValue({ allowed: true, reason: 'ok', holdId: 'hold_1' });
    mockTrackUsage.mockResolvedValue(undefined);
    mockReleaseHold.mockResolvedValue(undefined);
    mockEmitCreditsUpdated.mockResolvedValue(undefined);
  });

  it('blocks free users with 403 before gating or calling the provider', async () => {
    mockGetUserSettings.mockResolvedValue({ subscriptionTier: 'free' });
    const fetchSpy = okAudioFetch();
    vi.stubGlobal('fetch', fetchSpy);

    const res = await POST(ttsRequest({ text: 'hello world' }));

    expect(res.status).toBe(403);
    expect(mockCanConsumeAI).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('meters a successful call: gates with the small voice hold, bills real char cost, releases nothing', async () => {
    const fetchSpy = okAudioFetch();
    vi.stubGlobal('fetch', fetchSpy);

    const res = await POST(ttsRequest({ text: 'a'.repeat(1000), model: 'tts-1', voice: 'nova' }));

    expect(res.status).toBe(200);
    // Gated with the exact per-call reservation: 1000 chars × $15/1M × 1.5 = $0.0225
    // → ceil to 3¢ (not a flat estimate), plus the voice concurrency cap.
    expect(mockCanConsumeAI).toHaveBeenCalledWith('u1', 'pro', { estCostCents: 3, maxInFlight: 4 });
    // Billed real cost: 1000 chars × $15/1M = $0.015, tagged as voice/list_price.
    expect(mockTrackUsage).toHaveBeenCalledTimes(1);
    const usage = mockTrackUsage.mock.calls[0][0];
    expect(usage).toMatchObject({
      userId: 'u1',
      provider: 'openai_voice',
      model: 'tts-1',
      holdId: 'hold_1',
      success: true,
      costSource: 'list_price',
    });
    expect(usage.providerCostDollars).toBeCloseTo(0.015, 6);
    expect(usage.metadata).toMatchObject({ type: 'voice_tts', chars: 1000 });
    // trackUsage owns the hold release; the route must not double-release.
    expect(mockReleaseHold).not.toHaveBeenCalled();
    expect(mockEmitCreditsUpdated).toHaveBeenCalledWith('u1');
  });

  it('returns the gate denial (402/429) and never calls the provider or bills', async () => {
    mockCanConsumeAI.mockResolvedValue({ allowed: false, reason: 'out_of_credits' });
    const fetchSpy = okAudioFetch();
    vi.stubGlobal('fetch', fetchSpy);

    const res = await POST(ttsRequest({ text: 'hello' }));

    expect(res.status).toBe(402);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(mockTrackUsage).not.toHaveBeenCalled();
    // No hold was issued on a denial, so nothing to release.
    expect(mockReleaseHold).not.toHaveBeenCalled();
  });

  it('releases the hold (and does not bill) when the provider call fails', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      json: () => Promise.resolve({ error: { message: 'boom' } }),
    }));

    const res = await POST(ttsRequest({ text: 'hello' }));

    expect(res.status).toBe(500);
    expect(mockTrackUsage).not.toHaveBeenCalled();
    expect(mockReleaseHold).toHaveBeenCalledWith('hold_1');
  });
});
