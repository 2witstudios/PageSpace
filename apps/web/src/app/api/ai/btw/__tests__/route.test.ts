import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  auth: vi.fn(), access: vi.fn(), conversation: vi.fn(), userRow: vi.fn(), messages: vi.fn(), plan: vi.fn(),
  provider: vi.fn(), stream: vi.fn(), audit: vi.fn(), gate: vi.fn(), release: vi.fn(), track: vi.fn(), exempt: vi.fn(),
}));
const usersTable = vi.hoisted(() => ({ id: 'users.id', role: 'role', subscriptionTier: 'subscriptionTier', currentAiProvider: 'currentAiProvider', currentAiModel: 'currentAiModel' }));
vi.mock('@/lib/auth', () => ({ authenticateRequestWithOptions: mocks.auth, isAuthError: (value: unknown) => Boolean((value as { error?: unknown })?.error) }));
vi.mock('@pagespace/lib/audit/audit-log', () => ({ auditRequest: mocks.audit }));
vi.mock('@pagespace/db/db', () => ({
  db: { select: () => ({ from: (table: unknown) => ({ where: () => ({ limit: () => (table === usersTable ? mocks.userRow() : mocks.conversation()) }) }) }) },
}));
vi.mock('@pagespace/db/operators', () => ({ eq: vi.fn() }));
vi.mock('@pagespace/db/schema/conversations', () => ({ conversations: { id: 'id', userId: 'userId', isShared: 'isShared', type: 'type', contextId: 'contextId' } }));
vi.mock('@pagespace/db/schema/auth', () => ({ users: usersTable }));
vi.mock('@pagespace/lib/permissions/conversation-access', () => ({ canAccessConversation: mocks.access }));
vi.mock('@/lib/repositories/message-repository', () => ({ messageRepository: { getMessagesByConversationId: mocks.messages } }));
vi.mock('@/lib/ai/core/plan-binding', () => ({ getActivePlan: mocks.plan }));
vi.mock('@/lib/ai/core/provider-factory', () => ({ createAIProvider: mocks.provider }));
vi.mock('@/lib/ai/core/ai-providers-config', () => ({ ADMIN_ONLY_PROVIDERS: new Set(['glm']), resolveProviderModel: (_p: unknown, _m: unknown, provider: string, model: string) => ({ provider, model }) }));
vi.mock('@/lib/subscription/rate-limit-middleware', () => ({ createAdminRestrictedResponse: () => new Response(JSON.stringify({ error: 'admin_only' }), { status: 403 }) }));
vi.mock('@/lib/ai/btw/side-question', () => ({ buildSideQuestionSnapshot: vi.fn().mockResolvedValue('snapshot'), createSideQuestionStream: mocks.stream }));
vi.mock('@pagespace/lib/billing/credit-gate', () => ({ canConsumeAI: mocks.gate }));
vi.mock('@pagespace/lib/billing/credit-consume', () => ({ releaseHold: mocks.release }));
vi.mock('@pagespace/lib/billing/credit-pricing', () => ({ MAX_CHAT_INFLIGHT: 3 }));
vi.mock('@pagespace/lib/ai/model-defaults', () => ({ isMeteringExempt: mocks.exempt }));
vi.mock('@pagespace/lib/monitoring/chat-pricing', () => ({ estimateChatHoldCentsForModel: () => 7 }));
vi.mock('@pagespace/lib/monitoring/ai-monitoring', () => ({
  AIMonitoring: { trackUsage: mocks.track },
  extractOpenRouterCostDollars: () => undefined,
  extractOpenRouterGenerationIds: () => [],
}));
vi.mock('@pagespace/lib/logging/logger-config', () => ({ loggers: { api: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() } } }));
vi.mock('@/lib/subscription/credit-gate-response', () => ({
  creditGateErrorResponse: (reason: string) => new Response(JSON.stringify({ error: reason }), { status: reason === 'too_many_in_flight' ? 429 : 402 }),
}));
import { POST } from '../route';

const ask = (question = 'What changed?') =>
  POST(new Request('http://test/api/ai/btw', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ conversationId: 'c1', question }) }));

type Settle = (s: { success: boolean; usage?: Record<string, number>; steps: unknown[] }) => Promise<void>;

describe('POST /api/ai/btw', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.auth.mockResolvedValue({ userId: 'u1' });
    mocks.conversation.mockResolvedValue([{ userId: 'u1', isShared: false, type: 'page', contextId: 'p1' }]);
    mocks.userRow.mockResolvedValue([{ role: 'user', subscriptionTier: 'free', currentAiProvider: 'openrouter', currentAiModel: 'm1' }]);
    mocks.messages.mockResolvedValue([]);
    mocks.access.mockResolvedValue(true);
    mocks.exempt.mockReturnValue(false);
    mocks.gate.mockResolvedValue({ allowed: true, holdId: 'hold-1' });
    mocks.release.mockResolvedValue(undefined);
    mocks.track.mockResolvedValue({ creditsSettled: true });
    mocks.provider.mockResolvedValue({ model: {}, provider: 'openrouter', modelName: 'm1' });
    mocks.stream.mockReturnValue(new Response('side'));
  });

  it('authorizes and streams through the detached path without primary writes', async () => {
    const response = await ask();
    expect(await response.text()).toBe('side');
    expect(mocks.access).toHaveBeenCalledWith('u1', expect.anything());
    expect(mocks.stream).toHaveBeenCalledWith(expect.objectContaining({ abortSignal: expect.any(AbortSignal), question: 'What changed?' }));
    expect(mocks.messages).toHaveBeenCalledTimes(0);
  });

  it('rejects oversize questions before provider or stream work', async () => {
    const response = await ask('x'.repeat(2001));
    expect(response.status).toBe(400); expect(mocks.provider).not.toHaveBeenCalled(); expect(mocks.stream).not.toHaveBeenCalled();
    expect(mocks.gate).not.toHaveBeenCalled();
  });

  it('emits authz.access.denied when the conversation is missing or inaccessible', async () => {
    mocks.access.mockResolvedValue(false);
    const response = await ask();
    expect(response.status).toBe(404);
    expect(mocks.audit).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ eventType: 'authz.access.denied', resourceType: 'ai_btw', resourceId: 'c1' }));
    expect(mocks.provider).not.toHaveBeenCalled(); expect(mocks.stream).not.toHaveBeenCalled();
    expect(mocks.gate).not.toHaveBeenCalled();
  });

  describe('credit gate (D-35)', () => {
    it('given an unclaimed agent with no credits, should answer 402 requires_funding and never resolve a provider or stream', async () => {
      mocks.gate.mockResolvedValue({ allowed: false, reason: 'requires_funding' });
      const response = await ask();
      expect(response.status).toBe(402);
      expect(await response.json()).toEqual({ error: 'requires_funding' });
      expect(mocks.provider).not.toHaveBeenCalled();
      expect(mocks.stream).not.toHaveBeenCalled();
      expect(mocks.release).not.toHaveBeenCalled();
      expect(mocks.audit).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ eventType: 'authz.access.denied', resourceType: 'ai_btw', details: expect.objectContaining({ reason: 'credit_gate', gateReason: 'requires_funding' }) }));
    });

    it('given a human at zero balance, should answer 402 out_of_credits without streaming', async () => {
      mocks.gate.mockResolvedValue({ allowed: false, reason: 'out_of_credits' });
      const response = await ask();
      expect(response.status).toBe(402);
      expect(mocks.provider).not.toHaveBeenCalled();
      expect(mocks.stream).not.toHaveBeenCalled();
    });

    it('should gate with the concurrency cap and the model-sized hold BEFORE resolving the provider', async () => {
      await ask();
      expect(mocks.gate).toHaveBeenCalledWith('u1', 'free', { estCostCents: 7, maxInFlight: 3 });
      expect(mocks.gate.mock.invocationCallOrder[0]).toBeLessThan(mocks.provider.mock.invocationCallOrder[0]);
    });

    it('given a metering-exempt provider, should skip the gate and take no hold', async () => {
      mocks.exempt.mockReturnValue(true);
      const response = await ask();
      expect(response.status).toBe(200);
      expect(mocks.gate).not.toHaveBeenCalled();
    });
  });

  describe('admin-only providers (mirrors consult and v1)', () => {
    it('given a non-admin whose stored provider is admin-only, should refuse 403 before any gate, hold or provider', async () => {
      mocks.userRow.mockResolvedValue([{ role: 'user', subscriptionTier: 'free', currentAiProvider: 'glm', currentAiModel: 'glm-x' }]);
      mocks.exempt.mockReturnValue(true);
      const response = await ask();
      expect(response.status).toBe(403);
      expect(mocks.gate).not.toHaveBeenCalled();
      expect(mocks.provider).not.toHaveBeenCalled();
      expect(mocks.stream).not.toHaveBeenCalled();
      expect(mocks.audit).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ eventType: 'authz.access.denied', details: expect.objectContaining({ reason: 'admin_only_provider' }) }));
    });

    it('given an admin on the admin-only provider, should stream (metering-exempt, no hold)', async () => {
      mocks.userRow.mockResolvedValue([{ role: 'admin', subscriptionTier: 'free', currentAiProvider: 'glm', currentAiModel: 'glm-x' }]);
      mocks.exempt.mockReturnValue(true);
      expect((await ask()).status).toBe(200);
      expect(mocks.gate).not.toHaveBeenCalled();
    });
  });

  describe('client disconnect is not a free answer', () => {
    it("should NOT hand the client's request signal to the model — a server-side timeout bounds it instead", async () => {
      const request = new Request('http://test/api/ai/btw', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ conversationId: 'c1', question: 'q' }) });
      await POST(request);
      const { abortSignal } = mocks.stream.mock.calls[0][0] as { abortSignal: AbortSignal };
      expect(abortSignal).toBeInstanceOf(AbortSignal);
      expect(abortSignal).not.toBe(request.signal);
    });
  });

  describe('metering and hold release', () => {
    it('should settle the hold through trackUsage (ai_usage_logs + consumeCredits) when the stream ends', async () => {
      await ask();
      const { onSettle } = mocks.stream.mock.calls[0][0] as { onSettle: Settle };
      expect(mocks.track).not.toHaveBeenCalled();
      await onSettle({ success: true, usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 }, steps: [] });
      expect(mocks.track).toHaveBeenCalledWith(expect.objectContaining({
        userId: 'u1', provider: 'openrouter', model: 'm1', source: 'chat', conversationId: 'c1',
        inputTokens: 10, outputTokens: 5, totalTokens: 15, success: true, holdId: 'hold-1',
      }));
      // The stream owns the hold: the route must not also release it.
      expect(mocks.release).not.toHaveBeenCalled();
    });

    it('given an aborted or failed stream, should still settle (success false) so the hold never leaks', async () => {
      await ask();
      const { onSettle } = mocks.stream.mock.calls[0][0] as { onSettle: Settle };
      await onSettle({ success: false, usage: undefined, steps: [] });
      expect(mocks.track).toHaveBeenCalledWith(expect.objectContaining({ success: false, holdId: 'hold-1', inputTokens: undefined }));
    });

    it('given a provider error after the gate, should release the hold in finally and AWAIT it before answering', async () => {
      mocks.provider.mockResolvedValue({ error: 'not configured', status: 503 });
      let released = false;
      mocks.release.mockImplementation(async () => { await new Promise((r) => setTimeout(r, 5)); released = true; });
      const response = await ask();
      expect(released).toBe(true);
      expect(response.status).toBe(503);
      expect(mocks.release).toHaveBeenCalledWith('hold-1');
      expect(mocks.stream).not.toHaveBeenCalled();
    });

    it('given the stream construction throws, should release the hold and rethrow', async () => {
      mocks.stream.mockImplementation(() => { throw new Error('boom'); });
      await expect(ask()).rejects.toThrow('boom');
      expect(mocks.release).toHaveBeenCalledWith('hold-1');
    });
  });
});
