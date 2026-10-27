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
  PAID_TIERS: new Set(['pro', 'business']),
}));
vi.mock('@pagespace/lib/billing/credit-gate', () => ({ canConsumeAI: mockCanConsumeAI }));
const { mockResolveVoiceSpend, mockResolveRequestContext } = vi.hoisted(() => ({
  mockResolveVoiceSpend: vi.fn(),
  mockResolveRequestContext: vi.fn(),
}));
vi.mock('@/lib/ai/realtime/voice-spend', () => ({ resolveVoiceSpend: mockResolveVoiceSpend }));
vi.mock('@/lib/ai/realtime/voice-runtime-deps', () => ({ voiceSpendDeps: () => ({}) }));
vi.mock('@/lib/ai/core/resolve-request-context', () => ({ resolveRequestContext: mockResolveRequestContext }));
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

/** Build a synthesize POST request with the given JSON body. */
function ttsRequest(body: Record<string, unknown>) {
  return new Request('http://localhost/api/voice/synthesize', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

/** Mock `fetch` returning a successful OpenAI TTS audio response. */
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
    mockResolveVoiceSpend.mockResolvedValue({ kind: 'personal' });
    mockResolveRequestContext.mockResolvedValue(null);
  });

  it('WAL-8 (partial) refuses a caller funding speech from a Free plan with 403: judged on the held source\'s funder, the hold freed, the provider never called', async () => {
    mockGetUserSettings.mockResolvedValue({ subscriptionTier: 'free' });
    mockCanConsumeAI.mockResolvedValue({ allowed: true, reason: 'ok', holdId: 'hold_1', entitlementTier: 'free' });
    const fetchSpy = okAudioFetch();
    vi.stubGlobal('fetch', fetchSpy);

    const res = await POST(ttsRequest({ text: 'hello world' }));

    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ error: 'Pro plan required' });
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(mockTrackUsage).not.toHaveBeenCalled();
    expect(mockReleaseHold).toHaveBeenCalledWith('hold_1');
  });

  it('WAL-8 (partial) a Free caller whose speech an org drive funds is served: the plan judged is the funder\'s', async () => {
    mockGetUserSettings.mockResolvedValue({ subscriptionTier: 'free' });
    mockResolveVoiceSpend.mockResolvedValue({ kind: 'drive', driveId: 'org-drive' });
    mockCanConsumeAI.mockResolvedValue({ allowed: true, reason: 'ok', holdId: 'hold_1', walletId: 'w-org', entitlementTier: 'business' });
    vi.stubGlobal('fetch', okAudioFetch());

    const res = await POST(ttsRequest({ text: 'hello world', conversationId: 'conv1' }));

    expect(res.status).toBe(200);
  });

  it('SPEND-1 (partial) speech read aloud from a drive conversation reserves in that drive — the conversation\'s stored source applies — and its usage is attributed there', async () => {
    mockResolveVoiceSpend.mockResolvedValue({ kind: 'drive', driveId: 'drive-1' });
    mockCanConsumeAI.mockResolvedValue({ allowed: true, reason: 'ok', holdId: 'hold_1', walletId: 'w-drive', entitlementTier: 'business' });
    vi.stubGlobal('fetch', okAudioFetch());

    await POST(ttsRequest({ text: 'hello', conversationId: 'conv1', agentPageId: 'agent1' }));

    expect(mockResolveVoiceSpend).toHaveBeenCalledWith(expect.anything(), { userId: 'u1', conversationId: 'conv1', agentPageId: 'agent1' });
    expect(mockCanConsumeAI).toHaveBeenCalledWith('u1', 'pro', expect.objectContaining({ spend: { kind: 'drive', driveId: 'drive-1', chosen: null, conversationId: 'conv1' } }));
    expect(mockTrackUsage).toHaveBeenCalledWith(expect.objectContaining({ walletId: 'w-drive', driveId: 'drive-1', conversationId: 'conv1' }));
  });

  it('SPEND-1 (partial) a Global Assistant reply read aloud spends in the drive the server resolves from the caller\'s contextRef, never an id the body claims', async () => {
    mockResolveRequestContext.mockResolvedValue({ currentPage: null, currentDrive: { id: 'drive-verified', name: 'P', slug: 'p' }, breadcrumbs: [] });
    vi.stubGlobal('fetch', okAudioFetch());

    await POST(ttsRequest({ text: 'hello', conversationId: 'g1', contextRef: { routeType: 'drive', driveId: 'drive-claimed' }, driveId: 'drive-smuggled' }));

    expect(mockResolveRequestContext).toHaveBeenCalledWith({ userId: 'u1' }, { routeType: 'drive', driveId: 'drive-claimed' });
    expect(mockResolveVoiceSpend).toHaveBeenCalledWith(expect.anything(), { userId: 'u1', conversationId: 'g1', contextDriveId: 'drive-verified' });
  });

  it('SPEND-4 (partial) speech whose drive cannot be resolved is refused by name, reserving and charging nothing', async () => {
    mockResolveVoiceSpend.mockResolvedValue({ kind: 'refused', reason: 'voice_spend_unresolved' });
    const fetchSpy = okAudioFetch();
    vi.stubGlobal('fetch', fetchSpy);

    const res = await POST(ttsRequest({ text: 'hello', conversationId: 'fresh', agentPageId: 'agent1' }));

    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: 'voice_spend_unresolved' });
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
    expect(mockCanConsumeAI).toHaveBeenCalledWith('u1', 'pro', { spend: { kind: 'personal' }, estCostCents: 3, maxInFlight: 4 });
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
