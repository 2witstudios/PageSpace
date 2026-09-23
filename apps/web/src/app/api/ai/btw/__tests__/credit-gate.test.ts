import { beforeEach, describe, expect, it, vi } from 'vitest';

// ============================================================================
// Prepaid credit gate + metering for POST /api/ai/btw (side questions).
//
// The route shipped calling the model with no gate, no usage row and no hold
// (#2678). These pin the contract the chat route already keeps: gate BEFORE the
// provider is built, refuse with the shared credit-gate error shape, record
// exactly one usage row carrying the real cost when the stream ends however it
// ends, and never leak the hold. `side-question` is real; only the AI SDK's
// streamText is faked so the test can drive the stream's terminal callbacks.
// ============================================================================

type StreamOptions = {
  onFinish?: (event: { totalUsage: Record<string, number | undefined>; steps: unknown[] }) => unknown;
  onAbort?: (event: { steps: unknown[] }) => unknown;
  onError?: (event: { error: unknown }) => unknown;
  onStepFinish?: (step: unknown) => unknown;
  onChunk?: (event: { chunk: { type: string; text?: string } }) => unknown;
};

const mocks = vi.hoisted(() => ({
  auth: vi.fn(),
  audit: vi.fn(),
  conversationRow: vi.fn(),
  userRow: vi.fn(),
  access: vi.fn(),
  messages: vi.fn(),
  plan: vi.fn(),
  provider: vi.fn(),
  gate: vi.fn(),
  releaseHold: vi.fn(),
  trackUsage: vi.fn(),
  streamText: vi.fn(),
  calculateCost: vi.fn(),
  requiresPro: vi.fn(),
  sessionDrive: vi.fn(),
  entitlement: vi.fn(),
}));

vi.mock('@/lib/auth', () => ({
  authenticateRequestWithOptions: mocks.auth,
  isAuthError: (value: unknown) => Boolean((value as { error?: unknown })?.error),
}));
vi.mock('@pagespace/lib/audit/audit-log', () => ({ auditRequest: mocks.audit }));
vi.mock('@pagespace/lib/logging/logger-config', () => ({
  loggers: { ai: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } },
}));
vi.mock('@pagespace/db/schema/conversations', () => ({ conversations: { __table: 'conversations', id: 'id', userId: 'userId', isShared: 'isShared', type: 'type', contextId: 'contextId' } }));
vi.mock('@pagespace/db/schema/auth', () => ({ users: { __table: 'users', id: 'id', subscriptionTier: 'subscriptionTier', role: 'role', currentAiProvider: 'currentAiProvider', currentAiModel: 'currentAiModel' } }));
vi.mock('@pagespace/db/operators', () => ({ eq: vi.fn() }));
vi.mock('@pagespace/db/db', () => ({
  db: {
    select: () => ({
      from: (table: { __table: string }) => ({
        where: () => ({ limit: () => (table.__table === 'users' ? mocks.userRow() : mocks.conversationRow()) }),
      }),
    }),
  },
}));
vi.mock('@pagespace/lib/permissions/conversation-access', () => ({ canAccessConversation: mocks.access }));
vi.mock('@/lib/repositories/message-repository', () => ({ messageRepository: { getMessagesByConversationId: mocks.messages } }));
vi.mock('@/lib/ai/core/plan-binding', () => ({ getActivePlan: mocks.plan }));
vi.mock('@/lib/ai/core/provider-factory', () => ({ createAIProvider: mocks.provider }));
vi.mock('@/lib/ai/core/ai-providers-config', () => ({
  ADMIN_ONLY_PROVIDERS: new Set(['glm']),
  resolveProviderModel: (_p: unknown, _m: unknown, provider?: string, model?: string) => ({ provider: provider ?? 'openrouter', model: model ?? 'openai/gpt-5.4-nano' }),
}));
vi.mock('@/lib/subscription/rate-limit-middleware', () => ({
  createAdminRestrictedResponse: () => new Response(JSON.stringify({ error: 'admin_only' }), { status: 403 }),
  createSubscriptionRequiredResponse: () => new Response(JSON.stringify({ error: 'Subscription required' }), { status: 403 }),
  requiresProSubscription: mocks.requiresPro,
}));
vi.mock('@pagespace/lib/billing/credit-gate', () => ({ canConsumeAI: mocks.gate, resolveEntitlementTier: mocks.entitlement }));
vi.mock('@/lib/ai/core/session-spend', () => ({ conversationSessionDriveId: mocks.sessionDrive }));
vi.mock('@pagespace/lib/billing/credit-consume', () => ({ releaseHold: mocks.releaseHold }));
vi.mock('@pagespace/lib/billing/credit-pricing', () => ({ MAX_CHAT_INFLIGHT: 8, MARKUP_BPS: 15000 }));
vi.mock('@pagespace/lib/ai/model-defaults', () => ({ isMeteringExempt: (provider: string) => provider === 'glm' }));
vi.mock('@pagespace/lib/monitoring/chat-pricing', () => ({ estimateChatHoldCentsForModel: () => 7 }));
vi.mock('@pagespace/lib/monitoring/ai-monitoring', () => ({
  AIMonitoring: { trackUsage: mocks.trackUsage },
  calculateCost: mocks.calculateCost,
  estimateTokens: (text: string) => Math.ceil(text.length / 4),
  extractOpenRouterCostDollars: (steps: Array<{ providerMetadata?: { openrouter?: { usage?: { cost?: number } } } }> | undefined) =>
    steps?.reduce<number | undefined>((sum, step) => {
      const cost = step.providerMetadata?.openrouter?.usage?.cost;
      return cost === undefined ? sum : (sum ?? 0) + cost;
    }, undefined),
  extractOpenRouterGenerationIds: (steps: Array<{ providerMetadata?: { openrouter?: { id?: string } } }> | undefined) =>
    (steps ?? []).flatMap((step) => (step.providerMetadata?.openrouter?.id ? [step.providerMetadata.openrouter.id] : [])),
}));
vi.mock('ai', () => ({ streamText: mocks.streamText }));

import { POST } from '../route';

const post = () => POST(new Request('http://test/api/ai/btw', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ conversationId: 'c1', question: 'What changed?' }),
}));

const streamOptions = (): StreamOptions => mocks.streamText.mock.calls[0][0] as StreamOptions;
const billedStep = { usage: { inputTokens: 900, outputTokens: 100, totalTokens: 1000 }, providerMetadata: { openrouter: { id: 'gen-1', usage: { cost: 0.0042 } } } };

describe('POST /api/ai/btw credit gate', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.auth.mockResolvedValue({ userId: 'u1' });
    mocks.conversationRow.mockResolvedValue([{ userId: 'u1', isShared: false, type: 'page', contextId: 'p1' }]);
    mocks.userRow.mockResolvedValue([{ subscriptionTier: 'free', role: 'user', currentAiProvider: 'openrouter', currentAiModel: 'openai/gpt-5.4-nano' }]);
    mocks.access.mockResolvedValue(true);
    mocks.messages.mockResolvedValue([]);
    mocks.plan.mockResolvedValue(null);
    mocks.provider.mockResolvedValue({ model: {}, provider: 'openrouter', modelName: 'openai/gpt-5.4-nano' });
    mocks.gate.mockResolvedValue({ allowed: true, holdId: 'hold_1' });
    mocks.releaseHold.mockResolvedValue(undefined);
    mocks.trackUsage.mockResolvedValue({ status: 'recorded' });
    mocks.streamText.mockReturnValue({ toTextStreamResponse: () => new Response('side') });
    mocks.calculateCost.mockReturnValue(0.002);
    mocks.requiresPro.mockReturnValue(false);
    mocks.sessionDrive.mockResolvedValue('d1');
    // While orgs are dark the funding tier is the caller's own (the real function answers
    // it with no reads); a test that needs a funder's tier overrides this.
    mocks.entitlement.mockImplementation(async (_userId: string, tier: string) => tier);
  });

  it('SPEND-7 (partial) SPEND-3 (partial) names the drive of the conversation the side question asks about, and that conversation (whose stored source the gate reads); the route chooses nothing', async () => {
    await post();
    expect(mocks.sessionDrive).toHaveBeenCalledWith({ userId: 'u1', isShared: false, type: 'page', contextId: 'p1' });
    const spend = { kind: 'drive', driveId: 'd1', chosen: null, conversationId: 'c1' };
    expect(mocks.gate).toHaveBeenCalledWith('u1', 'free', expect.objectContaining({ spend }));
    expect(mocks.entitlement).toHaveBeenCalledWith('u1', 'free', spend);
  });

  it('SPEND-8 (partial) a global conversation has no drive, so the side question spends personal credits', async () => {
    mocks.sessionDrive.mockResolvedValue(null);
    await post();
    expect(mocks.gate).toHaveBeenCalledWith('u1', 'free', expect.objectContaining({ spend: { kind: 'personal' } }));
  });

  it('SPEND-4 (partial) a refused source answers 402 naming it and the options, and never builds the model', async () => {
    mocks.gate.mockResolvedValue({
      allowed: false,
      reason: 'source_refused',
      refusal: { source: 'drive_wallet', reason: 'source_empty', options: ['own_credits'] },
    });
    const response = await post();
    expect(response.status).toBe(402);
    expect(await response.json()).toMatchObject({
      error: 'spend_source_refused',
      source: 'drive_wallet',
      refusalReason: 'source_empty',
      options: ['own_credits'],
    });
    expect(mocks.provider).not.toHaveBeenCalled();
    expect(mocks.trackUsage).not.toHaveBeenCalled();
  });

  it('WAL-8 (partial) the pro-model admission reads the tier of whoever funds the call, not the caller', async () => {
    mocks.entitlement.mockResolvedValue('business');
    await post();
    expect(mocks.requiresPro).toHaveBeenCalledWith('openrouter', 'openai/gpt-5.4-nano', 'business', false);
  });

  it('WAL-5 (partial) settles on the wallet the gate reserved on', async () => {
    mocks.gate.mockResolvedValue({ allowed: true, holdId: 'hold_1', walletId: 'w-product' });
    await post();
    await streamOptions().onFinish?.({ totalUsage: { inputTokens: 900, outputTokens: 100, totalTokens: 1000 }, steps: [billedStep] });
    expect(mocks.trackUsage).toHaveBeenCalledWith(expect.objectContaining({ holdId: 'hold_1', walletId: 'w-product' }));
  });

  it('refuses an out-of-credit user with the shared 402 shape and never builds or calls the model', async () => {
    mocks.gate.mockResolvedValue({ allowed: false, reason: 'out_of_credits' });
    const response = await post();
    expect(response.status).toBe(402);
    expect(await response.json()).toMatchObject({ error: 'out_of_credits' });
    expect(mocks.provider).not.toHaveBeenCalled();
    expect(mocks.streamText).not.toHaveBeenCalled();
    expect(mocks.trackUsage).not.toHaveBeenCalled();
  });

  it('applies the chat in-flight cap and refuses with 429 when it is hit', async () => {
    mocks.gate.mockResolvedValue({ allowed: false, reason: 'too_many_in_flight' });
    const response = await post();
    expect(response.status).toBe(429);
    expect(mocks.gate).toHaveBeenCalledWith('u1', 'free', expect.objectContaining({ maxInFlight: 8, estCostCents: 7 }));
    expect(mocks.streamText).not.toHaveBeenCalled();
  });

  it('refuses a non-admin whose resolved provider is admin-only, before the gate', async () => {
    mocks.userRow.mockResolvedValue([{ subscriptionTier: 'pro', role: 'user', currentAiProvider: 'glm', currentAiModel: 'glm-4.6' }]);
    const response = await post();
    expect(response.status).toBe(403);
    expect(mocks.gate).not.toHaveBeenCalled();
    expect(mocks.streamText).not.toHaveBeenCalled();
  });

  it('records exactly one usage row with the real cost on a finished side question, settling the hold', async () => {
    const response = await post();
    expect(await response.text()).toBe('side');
    const options = streamOptions();
    await options.onStepFinish?.(billedStep);
    await options.onFinish?.({ totalUsage: { inputTokens: 900, outputTokens: 100, totalTokens: 1000 }, steps: [billedStep] });
    // A late terminal callback (the SDK can report more than one) must not bill twice.
    await options.onError?.({ error: new Error('late') });

    expect(mocks.trackUsage).toHaveBeenCalledTimes(1);
    expect(mocks.trackUsage).toHaveBeenCalledWith(expect.objectContaining({
      userId: 'u1',
      provider: 'openrouter',
      model: 'openai/gpt-5.4-nano',
      inputTokens: 900,
      outputTokens: 100,
      totalTokens: 1000,
      providerCostDollars: 0.0042,
      openrouterGenerationIds: ['gen-1'],
      conversationId: 'c1',
      success: true,
      holdId: 'hold_1',
    }));
    // trackUsage owns the hold once the stream starts; a route-level release would double-settle.
    expect(mocks.releaseHold).not.toHaveBeenCalled();
  });

  it('refuses a paid-tier model for a user whose tier does not include it, before the gate (chat admission)', async () => {
    mocks.requiresPro.mockReturnValue(true);
    const response = await post();
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ error: 'Subscription required' });
    expect(mocks.requiresPro).toHaveBeenCalledWith('openrouter', 'openai/gpt-5.4-nano', 'free', false);
    expect(mocks.gate).not.toHaveBeenCalled();
    expect(mocks.streamText).not.toHaveBeenCalled();
  });

  it('an in-stream error still bills the real usage the SDK reports at finish, once, as a failure', async () => {
    await post();
    const options = streamOptions();
    // ai@6 order: the error part fires onError inline; the flush fires onFinish after.
    await options.onError?.({ error: new Error('upstream hiccup') });
    await options.onFinish?.({ totalUsage: { inputTokens: 900, outputTokens: 100, totalTokens: 1000 }, steps: [billedStep] });

    expect(mocks.trackUsage).toHaveBeenCalledTimes(1);
    expect(mocks.trackUsage).toHaveBeenCalledWith(expect.objectContaining({
      holdId: 'hold_1', success: false, inputTokens: 900, providerCostDollars: 0.0042, error: 'upstream hiccup',
    }));
  });

  // The real SDK hands onAbort `steps: []` for this one-step stream (pinned in
  // side-question.real-sdk.test.ts), so that is the only abort shape tested here.
  it('an abort bills the interrupted step as an estimate — prompt plus streamed output at catalog rate — once, off the reconcile', async () => {
    await post();
    const options = streamOptions();
    await options.onChunk?.({ chunk: { type: 'text-delta', text: 'x'.repeat(400) } });
    await options.onAbort?.({ steps: [] });
    await options.onFinish?.({ totalUsage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 }, steps: [] });

    expect(mocks.trackUsage).toHaveBeenCalledTimes(1);
    const [row] = mocks.trackUsage.mock.calls[0] as [Record<string, unknown> & { inputTokens: number; metadata: { abortedStep: Record<string, unknown> } }];
    expect(row).toMatchObject({
      holdId: 'hold_1',
      success: false,
      outputTokens: 100,
      providerCostDollars: 0.002,
      openrouterGenerationIds: [],
      costSource: 'estimate',
      metadata: { outcome: 'aborted', abortedStep: { outputTokens: 100, costDollars: 0.002, capped: false } },
    });
    expect(row.inputTokens).toBeGreaterThan(0);
    expect(mocks.calculateCost).toHaveBeenCalledWith('openai/gpt-5.4-nano', row.inputTokens, 100);
    expect(mocks.releaseHold).not.toHaveBeenCalled();
  });

  it('caps the interrupted step at the hold reserved for the call (converted back through the markup)', async () => {
    mocks.calculateCost.mockReturnValue(5);
    await post();
    await streamOptions().onAbort?.({ steps: [] });
    // hold 7¢ at a 1.5x markup -> at most $0.0467 of real cost
    expect(mocks.trackUsage).toHaveBeenCalledWith(expect.objectContaining({
      providerCostDollars: 0.07 / 1.5,
      metadata: expect.objectContaining({ abortedStep: expect.objectContaining({ capped: true, costDollars: 0.07 / 1.5 }) }),
    }));
  });

  it('a run that completes no step (no onFinish, no onAbort) still settles the hold once', async () => {
    mocks.streamText.mockReturnValue({ toTextStreamResponse: () => new Response('side'), steps: Promise.reject(new Error('No output generated')) });
    await post();
    await vi.waitFor(() => expect(mocks.trackUsage).toHaveBeenCalledTimes(1));
    expect(mocks.trackUsage).toHaveBeenCalledWith(expect.objectContaining({ holdId: 'hold_1', success: false, error: 'No output generated' }));
  });

  it('releases the hold when the provider cannot be built after the gate allowed the call', async () => {
    mocks.provider.mockResolvedValue({ error: 'not configured', status: 503 });
    const response = await post();
    expect(response.status).toBe(503);
    expect(mocks.streamText).not.toHaveBeenCalled();
    expect(mocks.releaseHold).toHaveBeenCalledWith('hold_1');
    expect(mocks.trackUsage).not.toHaveBeenCalled();
  });

  it('skips the gate for a metering-exempt provider and bills with no hold', async () => {
    mocks.userRow.mockResolvedValue([{ subscriptionTier: 'pro', role: 'admin', currentAiProvider: 'glm', currentAiModel: 'glm-4.6' }]);
    mocks.provider.mockResolvedValue({ model: {}, provider: 'glm', modelName: 'glm-4.6' });
    await post();
    expect(mocks.gate).not.toHaveBeenCalled();
    await streamOptions().onFinish?.({ totalUsage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 }, steps: [] });
    expect(mocks.trackUsage).toHaveBeenCalledWith(expect.objectContaining({ provider: 'glm', holdId: undefined }));
  });
});
