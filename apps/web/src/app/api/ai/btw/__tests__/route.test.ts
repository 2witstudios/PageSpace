import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ auth: vi.fn(), access: vi.fn(), messages: vi.fn(), plan: vi.fn(), provider: vi.fn(), stream: vi.fn(), audit: vi.fn(), user: vi.fn() }));
vi.mock('@/lib/auth', () => ({ authenticateRequestWithOptions: mocks.auth, isAuthError: (value: unknown) => Boolean((value as { error?: unknown })?.error) }));
vi.mock('@pagespace/lib/audit/audit-log', () => ({ auditRequest: mocks.audit }));
vi.mock('@pagespace/db/db', () => ({ db: { select: () => ({ from: (table: { __table?: string }) => ({ where: () => ({ limit: table.__table === 'users' ? mocks.user : mocks.messages }) }) }) } }));
vi.mock('@pagespace/db/schema/auth', () => ({ users: { __table: 'users', id: 'id', subscriptionTier: 'subscriptionTier', role: 'role', currentAiProvider: 'currentAiProvider', currentAiModel: 'currentAiModel' } }));
vi.mock('@pagespace/lib/logging/logger-config', () => ({ loggers: { ai: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } } }));
vi.mock('@pagespace/lib/billing/credit-gate', () => ({ canConsumeAI: vi.fn().mockResolvedValue({ allowed: true, holdId: 'hold_1' }) }));
vi.mock('@pagespace/lib/billing/credit-consume', () => ({ releaseHold: vi.fn().mockResolvedValue(undefined) }));
vi.mock('@pagespace/lib/billing/credit-pricing', () => ({ MAX_CHAT_INFLIGHT: 8 }));
vi.mock('@pagespace/lib/ai/model-defaults', () => ({ isMeteringExempt: () => false }));
vi.mock('@pagespace/lib/monitoring/chat-pricing', () => ({ estimateChatHoldCentsForModel: () => 7 }));
vi.mock('@pagespace/lib/monitoring/ai-monitoring', () => ({ AIMonitoring: { trackUsage: vi.fn() }, estimateTokens: () => 1, extractOpenRouterCostDollars: () => undefined, extractOpenRouterGenerationIds: () => [] }));
vi.mock('@/lib/ai/core/ai-providers-config', () => ({ ADMIN_ONLY_PROVIDERS: new Set<string>(), resolveProviderModel: () => ({ provider: 'openrouter', model: 'm' }) }));
vi.mock('@/lib/subscription/rate-limit-middleware', () => ({ createAdminRestrictedResponse: vi.fn(), createSubscriptionRequiredResponse: vi.fn(), requiresProSubscription: () => false }));
vi.mock('@pagespace/db/operators', () => ({ eq: vi.fn() }));
vi.mock('@pagespace/db/schema/conversations', () => ({ conversations: { __table: 'conversations', id: 'id', userId: 'userId', isShared: 'isShared', type: 'type', contextId: 'contextId' } }));
vi.mock('@pagespace/lib/permissions/conversation-access', () => ({ canAccessConversation: mocks.access }));
vi.mock('@/lib/repositories/message-repository', () => ({ messageRepository: { getMessagesByConversationId: mocks.messages } }));
vi.mock('@/lib/ai/core/plan-binding', () => ({ getActivePlan: mocks.plan }));
vi.mock('@/lib/ai/core/provider-factory', () => ({ createAIProvider: mocks.provider }));
vi.mock('@/lib/ai/btw/side-question', () => ({ buildSideQuestionSnapshot: vi.fn().mockResolvedValue('snapshot'), createSideQuestionStream: mocks.stream }));
import { POST } from '../route';

describe('POST /api/ai/btw', () => {
  beforeEach(() => { vi.clearAllMocks(); mocks.auth.mockResolvedValue({ userId: 'u1' }); mocks.messages.mockResolvedValue([{ userId: 'u1', isShared: false, type: 'page', contextId: 'p1' }]); mocks.access.mockResolvedValue(true); mocks.user.mockResolvedValue([{ subscriptionTier: 'free', role: 'user', currentAiProvider: 'openrouter', currentAiModel: 'm' }]); mocks.provider.mockResolvedValue({ model: {} }); mocks.stream.mockReturnValue(new Response('side')); });
  it('authorizes and streams through the detached path without primary writes', async () => {
    const response = await POST(new Request('http://test/api/ai/btw', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ conversationId: 'c1', question: 'What changed?' }) }));
    expect(await response.text()).toBe('side');
    expect(mocks.access).toHaveBeenCalledWith('u1', expect.anything());
    expect(mocks.stream).toHaveBeenCalledWith(expect.objectContaining({ abortSignal: expect.any(AbortSignal), question: 'What changed?' }));
    expect(mocks.messages).toHaveBeenCalledTimes(1);
  });
  it('rejects oversize questions before provider or stream work', async () => {
    const response = await POST(new Request('http://test/api/ai/btw', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ conversationId: 'c1', question: 'x'.repeat(2001) }) }));
    expect(response.status).toBe(400); expect(mocks.provider).not.toHaveBeenCalled(); expect(mocks.stream).not.toHaveBeenCalled();
  });
  it('emits authz.access.denied when the conversation is missing or inaccessible', async () => {
    mocks.access.mockResolvedValue(false);
    const response = await POST(new Request('http://test/api/ai/btw', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ conversationId: 'c1', question: 'What changed?' }) }));
    expect(response.status).toBe(404);
    expect(mocks.audit).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ eventType: 'authz.access.denied', resourceType: 'ai_btw', resourceId: 'c1' }));
    expect(mocks.provider).not.toHaveBeenCalled(); expect(mocks.stream).not.toHaveBeenCalled();
  });
});
