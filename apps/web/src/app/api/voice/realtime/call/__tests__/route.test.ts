/**
 * Route tests: the gates in front of the handshake, and the shape of what comes
 * back. The handshake itself is mocked — it has its own suite — so these assert
 * the route's own decisions: who gets in, what the model is resolved from, and
 * that the ephemeral secret never appears in a response body.
 */

import { readSpendFallbackHeaders } from '@pagespace/lib/billing/spend-fallback';
import { describe, it, expect, vi, beforeEach } from 'vitest';

const {
  mockAuth,
  mockIsAuthError,
  mockGetManagedKey,
  mockIsBillingEnabled,
  mockGetUserSettings,
  mockRunCallHandshake,
  mockSignHeaders,
  mockLoadVoiceBinding,
} = vi.hoisted(() => ({
  mockLoadVoiceBinding: vi.fn(),
  mockAuth: vi.fn(),
  mockIsAuthError: vi.fn(),
  mockGetManagedKey: vi.fn(),
  mockIsBillingEnabled: vi.fn(),
  mockGetUserSettings: vi.fn(),
  mockRunCallHandshake: vi.fn(),
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
  PAID_TIERS: new Set(['pro', 'business']),
}));
vi.mock('@pagespace/lib/auth/broadcast-auth', () => ({
  createSignedBroadcastHeaders: mockSignHeaders,
}));
vi.mock('@/lib/ai/realtime/call-handshake', () => ({ runCallHandshake: mockRunCallHandshake }));
vi.mock('@/lib/ai/realtime/binding-loader', () => ({ loadVoiceBinding: mockLoadVoiceBinding }));
// A FACTORY, not a value: the binding deps take the caller's auth principal,
// because the active-plan lookup behind them needs a principal-aware page check.
vi.mock('@/lib/ai/realtime/voice-runtime-deps', () => ({ voiceBindingDeps: () => ({}), voiceSpendDeps: () => ({}) }));
const { mockResolveVoiceSpend } = vi.hoisted(() => ({ mockResolveVoiceSpend: vi.fn() }));
vi.mock('@/lib/ai/realtime/voice-spend', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/ai/realtime/voice-spend')>()),
  resolveVoiceSpend: mockResolveVoiceSpend,
}));
const { mockResolveRequestContext, mockResolveEntitlementTier } = vi.hoisted(() => ({
  mockResolveRequestContext: vi.fn(),
  mockResolveEntitlementTier: vi.fn(),
}));
vi.mock('@/lib/ai/core/resolve-request-context', () => ({ resolveRequestContext: mockResolveRequestContext }));
vi.mock('@pagespace/lib/billing/credit-gate', () => ({ resolveEntitlementTier: mockResolveEntitlementTier }));
vi.mock('@/lib/ai/core/ai-tools', () => ({ buildPageSpaceTools: () => ({}) }));
// POL-8: the org model policy the route asks before the handshake (its own real-Postgres proof is the factory's).
const { mockOrgModelRefusal } = vi.hoisted(() => ({ mockOrgModelRefusal: vi.fn() }));
vi.mock('@/lib/ai/core/provider-factory', () => ({ orgModelRefusal: mockOrgModelRefusal }));
const { mockMemberDrivesReadable } = vi.hoisted(() => ({ mockMemberDrivesReadable: vi.fn() }));
vi.mock('@/lib/ai/core/org-model-policy', () => ({ memberDrivesReadableByModel: mockMemberDrivesReadable }));
vi.mock('@pagespace/lib/audit/audit-log', () => ({ auditRequest: vi.fn() }));
vi.mock('@pagespace/lib/logging/logger-config', () => ({
  loggers: { ai: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } },
}));

import { POST } from '../route';
import { REALTIME_MAX_SESSION_SECONDS } from '@pagespace/lib/billing/credit-pricing';

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
    mockResolveVoiceSpend.mockResolvedValue({ kind: 'personal' });
    mockOrgModelRefusal.mockResolvedValue(null);
    mockMemberDrivesReadable.mockResolvedValue({ driveIds: [], allReadable: true });
    vi.unstubAllEnvs();
    mockAuth.mockResolvedValue({ userId: 'u1' });
    mockIsAuthError.mockReturnValue(false);
    mockGetManagedKey.mockReturnValue({ apiKey: 'sk-managed' });
    mockIsBillingEnabled.mockReturnValue(true);
    mockGetUserSettings.mockResolvedValue({ subscriptionTier: 'pro' });
    mockResolveRequestContext.mockResolvedValue(null);
    // Unless a test says otherwise, the caller funds their own call.
    mockResolveEntitlementTier.mockImplementation(async (_userId: string, tier: string) => tier);
    mockLoadVoiceBinding.mockResolvedValue({ seed: [], instructions: 'Speak out loud.', tools: TOOLS });
    mockSignHeaders.mockReturnValue({ 'X-Broadcast-Signature': 't=1,v1=sig' });
    mockRunCallHandshake.mockResolvedValue({
      ok: true,
      callId: 'rtc_abc',
      answerSdp: 'v=0 answer',
      attached: true,
      spendFallback: null,
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
      maxDurationMs: REALTIME_MAX_SESSION_SECONDS * 1000,
      spendFallback: null,
      historyWithheld: null,
    });
  });

  it('SPEND-4 (partial) a call whose opening gate fell back to another source says so in the answer and its headers, from and to', async () => {
    const spendFallback = { from: 'seat_allowance', to: 'own_credits', walletId: 'w-own' } as const;
    mockRunCallHandshake.mockResolvedValue({ ok: true, callId: 'rtc_abc', answerSdp: 'v=0 answer', attached: true, spendFallback });

    const res = await POST(callRequest({ sdp: 'v=0 offer' }));

    expect(res.status).toBe(200);
    expect((await res.json()).spendFallback).toEqual(spendFallback);
    expect(readSpendFallbackHeaders(res.headers)).toEqual(spendFallback);
  });

  it('should report the server-enforced duration cap so the client can chain ahead of it', async () => {
    // The browser cannot read REALTIME_MAX_SESSION_SECONDS, and the realtime
    // server hangs the call up when it passes. Without this field the client
    // would have to keep its own copy of a server env var.
    const res = await POST(callRequest({ sdp: 'v=0 offer' }));

    const body = (await res.json()) as { maxDurationMs?: unknown };
    expect(body.maxDurationMs).toBe(REALTIME_MAX_SESSION_SECONDS * 1000);
    expect(typeof body.maxDurationMs).toBe('number');
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

  it('given a MINT failure, should NOT pass the upstream body through', async () => {
    // A mint body describes the managed API key request — it can name the
    // organization, the quota state or a masked key. The passthrough exists
    // only so a bad OPENAI_REALTIME_MODEL is visible, and only the
    // calls-endpoint body carries that.
    mockRunCallHandshake.mockResolvedValue({
      ok: false,
      code: 'mint_failed',
      message: 'Could not mint a realtime session secret.',
      upstream: { error: { message: 'quota exceeded for org-acme, key sk-...9f2' } },
      upstreamStatus: 429,
    });

    const res = await POST(callRequest({ sdp: 'v=0 offer' }));
    const body = (await res.json()) as Record<string, unknown>;
    const text = JSON.stringify(body);

    expect(res.status).toBe(502);
    // The code and status still reach the caller — those are the diagnosis.
    expect(body).toMatchObject({ code: 'mint_failed', upstreamStatus: 429 });
    expect(body).not.toHaveProperty('upstream');
    expect(text).not.toContain('org-acme');
  });

  it('given admission refused for credit, should answer 402 rather than a 502 that reads as "retry"', async () => {
    mockRunCallHandshake.mockResolvedValue({
      ok: false,
      code: 'admission_refused',
      message: 'You do not have enough credit for a voice call.',
      upstreamStatus: 402,
    });

    const res = await POST(callRequest({ sdp: 'v=0 offer' }));

    expect(res.status).toBe(402);
    await expect(res.json()).resolves.toMatchObject({ code: 'admission_refused' });
  });

  it('given admission refused for concurrency, should answer 429', async () => {
    mockRunCallHandshake.mockResolvedValue({
      ok: false,
      code: 'admission_refused',
      message: 'Too many voice calls are already running. Try again in a moment.',
      upstreamStatus: 429,
    });

    const res = await POST(callRequest({ sdp: 'v=0 offer' }));

    expect(res.status).toBe(429);
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

  /**
   * The binding is resolved from the AUTHORIZED conversation, and nothing about
   * it is read off the request body — which is what stops a caller naming an
   * agent whose reach is wider than the conversation they can actually see.
   */
  describe('the bound assistant', () => {
    const assistant = {
      agentPageId: 'agent1',
      agentTitle: 'Release Notes Bot',
      enabledTools: ['read_page'],
    };

    it("should advertise the binding's own tools rather than building a second set", async () => {
      // The tools and the instructions come from ONE exposure, computed where
      // the allowlist is resolved. A route that rebuilt them from the assistant
      // could advertise a set the prompt does not describe — and would repeat a
      // whole registry build on a handshake the caller is waiting through.
      const agentTools = [
        { type: 'function' as const, name: 'read_page', description: 'r', parameters: {} },
      ];
      mockLoadVoiceBinding.mockResolvedValue({
        seed: [],
        instructions: 'You are "Release Notes Bot".',
        tools: agentTools,
        assistant,
      });

      await POST(callRequest({ sdp: 'v=0 offer', conversationId: 'conv1' }));

      expect(mockRunCallHandshake).toHaveBeenCalledWith(
        expect.objectContaining({ tools: agentTools }),
        expect.anything(),
      );
    });

    it('should hand the instructions and the assistant to the handshake', async () => {
      mockLoadVoiceBinding.mockResolvedValue({
        seed: [],
        instructions: 'You are "Release Notes Bot".',
        tools: TOOLS,
        assistant,
      });

      await POST(callRequest({ sdp: 'v=0 offer', conversationId: 'conv1' }));

      expect(mockRunCallHandshake).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          instructions: 'You are "Release Notes Bot".',
          assistant,
        }),
      );
    });

    it('should resolve the binding from the CONVERSATION, never from the request body', async () => {
      // A body naming its own agentPageId must change nothing.
      await POST(
        callRequest({
          sdp: 'v=0 offer',
          conversationId: 'conv1',
          assistant: { agentPageId: 'someone-elses-agent', agentTitle: 'x', enabledTools: null },
        }),
      );

      expect(mockLoadVoiceBinding).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ userId: 'u1', conversationId: 'conv1' }),
      );
      expect(mockRunCallHandshake).toHaveBeenCalledWith(
        expect.anything(),
        expect.not.objectContaining({
          assistant: expect.objectContaining({ agentPageId: 'someone-elses-agent' }),
        }),
      );
    });
  });

  describe('the source the call spends', () => {
    it('SPEND-1 (partial) should carry the resolved drive to the handshake, which carries it to the meter', async () => {
      mockResolveVoiceSpend.mockResolvedValue({ kind: 'drive', driveId: 'drive-1' });

      await POST(callRequest({ sdp: 'v=0 offer', conversationId: 'conv1' }));

      expect(mockRunCallHandshake).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ spendDriveId: 'drive-1' }));
    });

    it('SPEND-1 (partial) should resolve from the conversation and the named agent page, never take a drive from the body', async () => {
      await POST(callRequest({ sdp: 'v=0 offer', conversationId: 'conv1', agentPageId: 'agent1', spendDriveId: 'someone-elses-drive' }));

      expect(mockResolveVoiceSpend).toHaveBeenCalledWith(expect.anything(), { userId: 'u1', conversationId: 'conv1', agentPageId: 'agent1' });
      const [, input] = mockRunCallHandshake.mock.calls[0] as unknown[];
      expect(input).not.toHaveProperty('spendDriveId');
    });

    it('SPEND-4 (partial) a call whose drive cannot be resolved is refused by name before OpenAI is contacted — never billed personally', async () => {
      mockResolveVoiceSpend.mockResolvedValue({ kind: 'refused', reason: 'voice_spend_unresolved' });

      const response = await POST(callRequest({ sdp: 'v=0 offer', conversationId: 'fresh', agentPageId: 'agent1' }));

      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({ code: 'voice_spend_unresolved' });
      expect(mockRunCallHandshake).not.toHaveBeenCalled();
    });

    it('SPEND-1 (partial) a Global Assistant call spends in the drive the caller stands in — as the server resolves it from their location behind its own view check, never the id the location claims', async () => {
      mockResolveRequestContext.mockResolvedValue({ currentPage: null, currentDrive: { id: 'drive-verified', name: 'Product', slug: 'product' }, breadcrumbs: [] });
      const locationContext = { currentDrive: { id: 'drive-claimed', name: 'Product', slug: 'product' } };

      await POST(callRequest({ sdp: 'v=0 offer', conversationId: 'conv1', locationContext }));

      expect(mockResolveRequestContext).toHaveBeenCalledWith({ userId: 'u1' }, { routeType: 'drive', driveId: 'drive-claimed' });
      expect(mockResolveVoiceSpend).toHaveBeenCalledWith(expect.anything(), { userId: 'u1', conversationId: 'conv1', contextDriveId: 'drive-verified' });
    });

    it('SPEND-1 (partial) a location the caller cannot view places the call nowhere: no context drive reaches the resolution', async () => {
      mockResolveRequestContext.mockResolvedValue(null);

      await POST(callRequest({ sdp: 'v=0 offer', conversationId: 'conv1', locationContext: { currentDrive: { id: 'not-mine', name: 'X', slug: 'x' } } }));

      expect(mockResolveVoiceSpend).toHaveBeenCalledWith(expect.anything(), { userId: 'u1', conversationId: 'conv1' });
    });

    it('a conversation the caller cannot read is refused with 403 before OpenAI is contacted', async () => {
      mockResolveVoiceSpend.mockResolvedValue({ kind: 'refused', reason: 'voice_conversation_forbidden' });

      const response = await POST(callRequest({ sdp: 'v=0 offer', conversationId: 'conv1' }));

      expect(response.status).toBe(403);
      expect(mockRunCallHandshake).not.toHaveBeenCalled();
    });
  });

  describe('the org model policy', () => {
    it('POL-8 (partial) judges the realtime model and its vendor against the org of the drive the call belongs to, before OpenAI is contacted', async () => {
      mockResolveVoiceSpend.mockResolvedValue({ kind: 'drive', driveId: 'drive-1' });
      vi.stubEnv('OPENAI_REALTIME_MODEL', 'gpt-realtime-x');

      await POST(callRequest({ sdp: 'v=0 offer', conversationId: 'conv1' }));

      expect(mockOrgModelRefusal).toHaveBeenCalledWith(['drive-1'], [{ modelId: 'gpt-realtime-x', provider: 'openai' }]);
      expect(mockRunCallHandshake).toHaveBeenCalledWith(expect.objectContaining({ model: 'gpt-realtime-x' }), expect.anything());
    });

    it('POL-8 (partial) a call in a drive whose org does not allow the realtime model is refused with the policy code; nothing is minted, no binding is loaded', async () => {
      mockResolveVoiceSpend.mockResolvedValue({ kind: 'drive', driveId: 'drive-1' });
      mockOrgModelRefusal.mockResolvedValue({ error: "This organization doesn't allow this model.", status: 403, code: 'org_policy', policy: 'providerAllowlist' });

      const response = await POST(callRequest({ sdp: 'v=0 offer', conversationId: 'conv1' }));

      expect(response.status).toBe(403);
      expect(await response.json()).toEqual({ error: "This organization doesn't allow this model.", code: 'org_policy', policy: 'providerAllowlist' });
      expect(mockRunCallHandshake).not.toHaveBeenCalled();
      expect(mockLoadVoiceBinding).not.toHaveBeenCalled();
    });

    describe('a Global Assistant call\'s replayed history', () => {
      const SEED = [{ role: 'user', text: 'what did the Q3 board deck say?' }, { role: 'assistant', text: 'Revenue grew 40%.' }];

      it('POL-8 (partial) is replayed when every org the person is in allows the voice model', async () => {
        mockLoadVoiceBinding.mockResolvedValue({ seed: SEED, instructions: 'Speak.', tools: TOOLS });
        const res = await POST(callRequest({ sdp: 'v=0 offer', conversationId: 'global1' }));
        expect(mockMemberDrivesReadable).toHaveBeenCalledWith(expect.objectContaining({ userId: 'u1' }), { provider: 'openai', modelId: expect.any(String) });
        expect(mockRunCallHandshake).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ seed: SEED }));
        expect((await res.json()).historyWithheld).toBeNull();
      });

      it('POL-8 (partial) is left out, and the caller told why, when some org the person is in does not allow the voice model', async () => {
        mockLoadVoiceBinding.mockResolvedValue({ seed: SEED, instructions: 'Speak.', tools: TOOLS });
        mockMemberDrivesReadable.mockResolvedValue({ driveIds: ['personal'], allReadable: false });
        const res = await POST(callRequest({ sdp: 'v=0 offer', conversationId: 'global1' }));
        expect(res.status).toBe(200);
        expect(mockRunCallHandshake).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ seed: [] }));
        expect((await res.json()).historyWithheld).toMatch(/earlier messages/);
      });

      it('a drive conversation\'s history is governed by its drive (judged before the handshake), not by every org', async () => {
        mockResolveVoiceSpend.mockResolvedValue({ kind: 'drive', driveId: 'drive-1' });
        mockLoadVoiceBinding.mockResolvedValue({ seed: SEED, instructions: 'Speak.', tools: TOOLS });
        await POST(callRequest({ sdp: 'v=0 offer', conversationId: 'conv1' }));
        expect(mockMemberDrivesReadable).not.toHaveBeenCalled();
        expect(mockRunCallHandshake).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ seed: SEED }));
      });
    });

    it('a personal (Global Assistant) call is judged with no drive, which no org restricts', async () => {
      await POST(callRequest({ sdp: 'v=0 offer' }));
      expect(mockOrgModelRefusal).toHaveBeenCalledWith([null], [expect.objectContaining({ provider: 'openai' })]);
      expect(mockRunCallHandshake).toHaveBeenCalled();
    });
  });

  describe('who must be on a paid plan', () => {
    it('WAL-8 (partial) a Free caller whose call an org drive funds may talk: the plan judged is the FUNDER\'s, resolved on the drive the call spends in', async () => {
      mockGetUserSettings.mockResolvedValue({ subscriptionTier: 'free' });
      mockResolveVoiceSpend.mockResolvedValue({ kind: 'drive', driveId: 'org-drive' });
      mockResolveEntitlementTier.mockResolvedValue('business');

      const res = await POST(callRequest({ sdp: 'v=0 offer', conversationId: 'conv1' }));

      expect(res.status).toBe(200);
      expect(mockResolveEntitlementTier).toHaveBeenCalledWith('u1', 'free', { kind: 'drive', driveId: 'org-drive', chosen: null });
      // The meter's consumer tier stays the caller's own.
      expect(mockRunCallHandshake).toHaveBeenCalledWith(expect.objectContaining({ subscriptionTier: 'free' }), expect.anything());
    });

    it('WAL-8 (partial) a Pro caller on a drive whose funder is not on a paid plan is refused before OpenAI is contacted', async () => {
      mockResolveVoiceSpend.mockResolvedValue({ kind: 'drive', driveId: 'free-drive' });
      mockResolveEntitlementTier.mockResolvedValue('free');

      const res = await POST(callRequest({ sdp: 'v=0 offer', conversationId: 'conv1' }));

      expect(res.status).toBe(403);
      await expect(res.json()).resolves.toMatchObject({ error: 'Pro plan required' });
      expect(mockRunCallHandshake).not.toHaveBeenCalled();
    });
  });
});
