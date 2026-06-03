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

/**
 * Build a transcribe request. A real Request's multipart body parse can hang in the
 * test runtime, and the route only ever calls `request.formData()` (auth/audit are
 * mocked), so hand it a minimal stub whose formData() resolves directly.
 */
function audioRequest() {
  const form = new FormData();
  const file = new File([new Uint8Array(2048)], 'clip.webm', { type: 'audio/webm' });
  form.append('audio', file);
  return { formData: () => Promise.resolve(form) } as unknown as Request;
}

/**
 * Mock `fetch` for Whisper's verbose_json response (exact audio `duration` + `text`).
 * Pass `undefined` to simulate a degenerate response with no duration.
 */
function okWhisperFetch(duration: number | undefined) {
  return vi.fn().mockResolvedValue({
    ok: true,
    json: () => Promise.resolve({ text: 'hello there', ...(duration !== undefined ? { duration } : {}) }),
  });
}

describe('POST /api/voice/transcribe — metering', () => {
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
    const fetchSpy = okWhisperFetch(60);
    vi.stubGlobal('fetch', fetchSpy);

    const res = await POST(audioRequest());

    expect(res.status).toBe(403);
    expect(mockCanConsumeAI).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('requests verbose_json and bills real duration cost, releasing nothing on success', async () => {
    const fetchSpy = okWhisperFetch(60); // 60s = 1 min = $0.006
    vi.stubGlobal('fetch', fetchSpy);

    const res = await POST(audioRequest());

    expect(res.status).toBe(200);
    // Provider asked for verbose_json so a real duration comes back to bill on.
    const sentForm = fetchSpy.mock.calls[0][1].body as FormData;
    expect(sentForm.get('response_format')).toBe('verbose_json');

    expect(mockCanConsumeAI).toHaveBeenCalledWith('u1', 'pro', { estCostCents: 2, maxInFlight: 4 });
    expect(mockTrackUsage).toHaveBeenCalledTimes(1);
    const usage = mockTrackUsage.mock.calls[0][0];
    expect(usage).toMatchObject({
      userId: 'u1',
      provider: 'openai_voice',
      model: 'whisper-1',
      holdId: 'hold_1',
      success: true,
      costSource: 'list_price',
    });
    expect(usage.providerCostDollars).toBeCloseTo(0.006, 6);
    expect(usage.metadata).toMatchObject({ type: 'voice_stt' });
    expect(mockReleaseHold).not.toHaveBeenCalled();
    expect(mockEmitCreditsUpdated).toHaveBeenCalledWith('u1');
  });

  it('still bills $0 and hands off (not releases) the hold when Whisper returns no duration', async () => {
    const fetchSpy = okWhisperFetch(undefined);
    vi.stubGlobal('fetch', fetchSpy);

    const res = await POST(audioRequest());

    expect(res.status).toBe(200);
    // A degenerate no-duration response must still settle the hold via trackUsage
    // (billing $0), NOT leak/release it — the row is flagged for observability.
    expect(mockTrackUsage).toHaveBeenCalledTimes(1);
    const usage = mockTrackUsage.mock.calls[0][0];
    expect(usage.providerCostDollars).toBe(0);
    expect(usage.metadata).toMatchObject({ type: 'voice_stt', missingDuration: true });
    expect(mockReleaseHold).not.toHaveBeenCalled();
  });

  it('returns the gate denial (402) and never calls the provider or bills', async () => {
    mockCanConsumeAI.mockResolvedValue({ allowed: false, reason: 'out_of_credits' });
    const fetchSpy = okWhisperFetch(60);
    vi.stubGlobal('fetch', fetchSpy);

    const res = await POST(audioRequest());

    expect(res.status).toBe(402);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(mockTrackUsage).not.toHaveBeenCalled();
    expect(mockReleaseHold).not.toHaveBeenCalled();
  });

  it('releases the hold (and does not bill) when the provider call fails', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      json: () => Promise.resolve({ error: { message: 'boom' } }),
    }));

    const res = await POST(audioRequest());

    expect(res.status).toBe(500);
    expect(mockTrackUsage).not.toHaveBeenCalled();
    expect(mockReleaseHold).toHaveBeenCalledWith('hold_1');
  });
});
