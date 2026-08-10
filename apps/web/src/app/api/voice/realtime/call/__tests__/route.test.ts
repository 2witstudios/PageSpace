/**
 * Route tests: the gates in front of the handshake, and the shape of what comes
 * back. The handshake itself is mocked — it has its own suite — so these assert
 * the route's own decisions: who gets in, what the model is resolved from, and
 * that the ephemeral secret never appears in a response body.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const {
  mockAuth,
  mockIsAuthError,
  mockGetManagedKey,
  mockIsBillingEnabled,
  mockGetUserSettings,
  mockRunCallHandshake,
  mockBuildRealtimeTools,
  mockSignHeaders,
} = vi.hoisted(() => ({
  mockAuth: vi.fn(),
  mockIsAuthError: vi.fn(),
  mockGetManagedKey: vi.fn(),
  mockIsBillingEnabled: vi.fn(),
  mockGetUserSettings: vi.fn(),
  mockRunCallHandshake: vi.fn(),
  mockBuildRealtimeTools: vi.fn(),
  mockSignHeaders: vi.fn(),
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
vi.mock('@pagespace/lib/auth/broadcast-auth', () => ({
  createSignedBroadcastHeaders: mockSignHeaders,
}));
vi.mock('@/lib/ai/realtime/call-handshake', () => ({ runCallHandshake: mockRunCallHandshake }));
vi.mock('@/lib/ai/realtime/tools', () => ({ buildRealtimeTools: mockBuildRealtimeTools }));
vi.mock('@/lib/ai/core/ai-tools', () => ({ buildPageSpaceTools: () => ({}) }));
vi.mock('@pagespace/lib/audit/audit-log', () => ({ auditRequest: vi.fn() }));
vi.mock('@pagespace/lib/logging/logger-config', () => ({
  loggers: { ai: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } },
}));

import { POST } from '../route';

const SECRET = 'ek_never_leaves_the_server';
const TOOLS = [{ type: 'function' as const, name: 'read_page', description: 'r', parameters: {} }];

function callRequest(body: unknown) {
  return new Request('http://localhost/api/voice/realtime/call', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('POST /api/voice/realtime/call', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.unstubAllEnvs();
    mockAuth.mockResolvedValue({ userId: 'u1' });
    mockIsAuthError.mockReturnValue(false);
    mockGetManagedKey.mockReturnValue({ apiKey: 'sk-managed' });
    mockIsBillingEnabled.mockReturnValue(true);
    mockGetUserSettings.mockResolvedValue({ subscriptionTier: 'pro' });
    mockBuildRealtimeTools.mockReturnValue(TOOLS);
    mockSignHeaders.mockReturnValue({ 'X-Broadcast-Signature': 't=1,v1=sig' });
    mockRunCallHandshake.mockResolvedValue({
      ok: true,
      callId: 'rtc_abc',
      answerSdp: 'v=0 answer',
      attached: true,
    });
  });

  it('given an unauthenticated request, should 401 without minting anything', async () => {
    mockIsAuthError.mockReturnValue(true);
    mockAuth.mockResolvedValue({
      error: new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401 }),
    });

    const res = await POST(callRequest({ sdp: 'v=0 offer' }));

    expect(res.status).toBe(401);
    expect(mockRunCallHandshake).not.toHaveBeenCalled();
    expect(mockGetManagedKey).not.toHaveBeenCalled();
  });

  it('given a free-tier user while billing is enabled, should 403 with the upgrade message', async () => {
    mockGetUserSettings.mockResolvedValue({ subscriptionTier: 'free' });

    const res = await POST(callRequest({ sdp: 'v=0 offer' }));

    expect(res.status).toBe(403);
    await expect(res.json()).resolves.toMatchObject({
      error: 'Pro plan required',
      upgradeUrl: '/settings/plan',
    });
    expect(mockRunCallHandshake).not.toHaveBeenCalled();
  });

  it('given billing is disabled, should let a free-tier user through', async () => {
    mockIsBillingEnabled.mockReturnValue(false);
    mockGetUserSettings.mockResolvedValue({ subscriptionTier: 'free' });

    const res = await POST(callRequest({ sdp: 'v=0 offer' }));

    expect(res.status).toBe(200);
    // The tier is never even looked up when billing is off.
    expect(mockGetUserSettings).not.toHaveBeenCalled();
  });

  it('given no managed voice key, should 503', async () => {
    mockGetManagedKey.mockReturnValue(undefined);

    const res = await POST(callRequest({ sdp: 'v=0 offer' }));

    expect(res.status).toBe(503);
    expect(mockRunCallHandshake).not.toHaveBeenCalled();
  });

  it('given no SDP offer, should 400', async () => {
    const res = await POST(callRequest({}));
    expect(res.status).toBe(400);
    expect(mockRunCallHandshake).not.toHaveBeenCalled();
  });

  it('given an oversized SDP offer, should 400 rather than relay it', async () => {
    const res = await POST(callRequest({ sdp: 'x'.repeat(256 * 1024 + 1) }));
    expect(res.status).toBe(400);
    expect(mockRunCallHandshake).not.toHaveBeenCalled();
  });

  it('given OPENAI_REALTIME_MODEL is set, should hand THAT model to the handshake', async () => {
    vi.stubEnv('OPENAI_REALTIME_MODEL', 'gpt-realtime-from-env');

    await POST(callRequest({ sdp: 'v=0 offer' }));

    expect(mockRunCallHandshake).toHaveBeenCalledWith(
      expect.objectContaining({ model: 'gpt-realtime-from-env' }),
      expect.anything(),
    );
  });

  it('given no override, should resolve the default model rather than pass undefined', async () => {
    vi.stubEnv('OPENAI_REALTIME_MODEL', '');

    await POST(callRequest({ sdp: 'v=0 offer' }));

    const model = mockRunCallHandshake.mock.calls[0][0].model;
    expect(typeof model).toBe('string');
    expect(model.length).toBeGreaterThan(0);
  });

  it('should pass the built tool set and the real signer into the handshake', async () => {
    await POST(callRequest({ sdp: 'v=0 offer', conversationId: 'conv1' }));

    expect(mockRunCallHandshake).toHaveBeenCalledWith(
      expect.objectContaining({ tools: TOOLS, signHeaders: mockSignHeaders }),
      expect.objectContaining({ offerSdp: 'v=0 offer', userId: 'u1', conversationId: 'conv1' }),
    );
  });

  it('given a blank conversationId, should omit it rather than forward an empty string', async () => {
    await POST(callRequest({ sdp: 'v=0 offer', conversationId: '' }));

    expect(mockRunCallHandshake.mock.calls[0][1]).not.toHaveProperty('conversationId');
  });

  it('given a successful handshake, should return the callId, answer SDP and attach state', async () => {
    const res = await POST(callRequest({ sdp: 'v=0 offer' }));

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({
      callId: 'rtc_abc',
      answerSdp: 'v=0 answer',
      attached: true,
    });
  });

  it('given the realtime server was unreachable, should still return 200 with attached:false', async () => {
    mockRunCallHandshake.mockResolvedValue({
      ok: true,
      callId: 'rtc_abc',
      answerSdp: 'v=0 answer',
      attached: false,
    });

    const res = await POST(callRequest({ sdp: 'v=0 offer' }));

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({ attached: false });
  });

  it('given OpenAI rejected the model, should 502 carrying the upstream body and status', async () => {
    const upstream = {
      error: { message: 'model not found', code: 'model_not_found' },
    };
    mockRunCallHandshake.mockResolvedValue({
      ok: false,
      code: 'realtime_call_rejected',
      message: 'OpenAI rejected the realtime call.',
      upstream,
      upstreamStatus: 403,
    });

    const res = await POST(callRequest({ sdp: 'v=0 offer' }));

    // 502, not 403 — a 403 here would be indistinguishable from the tier gate.
    expect(res.status).toBe(502);
    await expect(res.json()).resolves.toMatchObject({
      code: 'realtime_call_rejected',
      upstreamStatus: 403,
      upstream,
    });
  });

  it('given the handshake throws, should 500 rather than leak the error', async () => {
    mockRunCallHandshake.mockRejectedValue(new Error('boom'));

    const res = await POST(callRequest({ sdp: 'v=0 offer' }));

    expect(res.status).toBe(500);
    await expect(res.json()).resolves.toEqual({ error: 'Failed to start voice call' });
  });

  it('should NEVER put the ephemeral secret in the response body', async () => {
    // Even if a future handshake result carried one, the route must not echo it.
    mockRunCallHandshake.mockResolvedValue({
      ok: true,
      callId: 'rtc_abc',
      answerSdp: 'v=0 answer',
      attached: true,
      secret: SECRET,
    });

    const res = await POST(callRequest({ sdp: 'v=0 offer' }));
    const text = await res.text();

    expect(text).not.toContain(SECRET);
    expect(text).not.toContain('ek_');
  });
});
