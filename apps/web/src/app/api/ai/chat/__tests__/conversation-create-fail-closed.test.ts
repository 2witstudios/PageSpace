/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { SessionAuthResult } from '@/lib/auth';

// ============================================================================
// FAIL-CLOSED conversation creation for POST /api/ai/chat
//
// The eager `conversationRepository.createConversation(...)` used to be
// `.catch(() => {})`. That was defensible while nothing downstream needed the
// row — but migration 0250 gave `ai_stream_sessions.conversationId` a real FK
// to `conversations`, so a swallowed failure stopped degrading gracefully: it
// re-emerged ~900 lines later as an FK violation inside `createStreamLifecycle`,
// under the advisory lock, where it reads as lock-machinery failure. This suite
// pins the fix — a throwing create returns a 500 BEFORE any model call, and the
// credit hold taken moments earlier is released rather than leaked.
//
// (Carry-forward from PR #2344's review, landed with Phase 4 PR 10.)
//
// The mock preamble below is shared with credit-gate.test.ts — same route,
// same heavy dependency graph.
// ============================================================================

vi.mock('@/lib/auth', () => ({
  authenticateRequestWithOptions: vi.fn(),
  isAuthError: vi.fn((result: any) => 'error' in result),
  isMCPAuthResult: vi.fn((r: any) => r?.tokenType === 'mcp'),
  checkMCPPageScope: vi.fn().mockResolvedValue(null),
  getAllowedDriveIds: vi.fn(() => []),
  isScopedMCPAuth: vi.fn(() => false),
  // Same boolean as isScopedMCPAuth for these fixtures; the real helper reads
  // through getAllowedDriveIds so it also covers dispatched service auth.
  //
  // Typed from the REAL exports, so a signature change here fails typecheck
  // rather than leaving a silently stale stub. The bodies reimplement rather
  // than delegate to the sibling `getAllowedDriveIds` mock: that mock is a
  // fixed `() => []` in these fixtures, so delegating would make every
  // credential read as unscoped and the scope assertions vacuous.
  isDriveScopedPrincipal: vi.fn<typeof import('@/lib/auth').isDriveScopedPrincipal>(
    (auth) => (('allowedDriveIds' in auth ? auth.allowedDriveIds : []) ?? []).length > 0,
  ),
  isServiceAuthResult: vi.fn<typeof import('@/lib/auth').isServiceAuthResult>(
    (result): result is import('@/lib/auth').ServiceAuthResult =>
      !('error' in result) && 'tokenType' in result && result.tokenType === 'service',
  ),
  canPrincipalViewPage: vi.fn(async (auth: { userId: string }, pageId: string) => {
    const { canUserViewPage } = await import('@pagespace/lib/permissions/permissions');
    return canUserViewPage(auth.userId, pageId);
  }),
  canPrincipalEditPage: vi.fn(async (auth: { userId: string }, pageId: string) => {
    const { canUserEditPage } = await import('@pagespace/lib/permissions/permissions');
    return canUserEditPage(auth.userId, pageId);
  }),
}));

vi.mock('@pagespace/lib/permissions/permissions', () => ({
  canUserViewPage: vi.fn().mockResolvedValue(true),
  canUserEditPage: vi.fn().mockResolvedValue(true),
}));
vi.mock('@pagespace/lib/monitoring/activity-logger', () => ({
  getActorInfo: vi.fn().mockResolvedValue({ actorEmail: 'test@test.com', actorDisplayName: 'Test' }),
}));
vi.mock('@pagespace/lib/logging/logger-config', () => ({
  loggers: {
    ai: {
      info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn(), trace: vi.fn(),
      child: vi.fn(() => ({ info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn(), trace: vi.fn() })),
    },
  },
  logger: { child: vi.fn(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() })) },
}));
vi.mock('@pagespace/lib/audit/audit-log', () => ({ auditRequest: vi.fn() }));

// Chainable, thenable query builder: every method returns the builder, and the
// builder itself resolves (awaits) to a single-row result. This satisfies both
// `db.select().from().where()` and `db.select().from().where().limit(1)` shapes.
vi.mock('@pagespace/db/db', () => {
  const row = {
    id: 'page_123',
    title: 'Test Page',
    systemPrompt: null,
    enabledTools: null,
    aiProvider: 'openai',
    aiModel: 'openai/gpt-5.4-nano',
    driveId: 'drive_A',
    includeDrivePrompt: false,
    includePageTree: false,
    pageTreeScope: null,
    revision: 0,
    subscriptionTier: 'free',
    displayName: 'Tester',
  };
  const makeBuilder = () => {
    const builder: any = {
      from: vi.fn(() => builder),
      where: vi.fn(() => builder),
      orderBy: vi.fn(() => builder),
      limit: vi.fn(() => builder),
      leftJoin: vi.fn(() => builder),
      innerJoin: vi.fn(() => builder),
      then: (resolve: (v: unknown[]) => unknown) => resolve([row]),
      catch: () => builder,
    };
    return builder;
  };
  return {
    db: {
      select: vi.fn(() => makeBuilder()),
      update: vi.fn(() => ({ set: vi.fn(() => ({ where: vi.fn().mockResolvedValue(undefined) })) })),
      insert: vi.fn(() => ({ values: vi.fn().mockResolvedValue(undefined) })),
    },
  };
});
// exists/sql: globalConversationRepository's module-scope `hasMessages` query
// (now reachable transitively via stream-takeover -> materialize-interrupted-stream
// -> global-conversation-repository, #2153) needs both or the module throws on import.
vi.mock('@pagespace/db/operators', () => ({ eq: vi.fn(), and: vi.fn(), exists: vi.fn(), sql: vi.fn() }));
vi.mock('@pagespace/db/schema/auth', () => ({ users: { id: 'id' } }));
vi.mock('@pagespace/db/schema/core', () => ({
  pages: { id: 'id' },
  drives: { id: 'id', drivePrompt: 'drivePrompt' },
}));

vi.mock('@/lib/subscription/rate-limit-middleware', () => ({
  requiresProSubscription: vi.fn().mockReturnValue(false),
  createSubscriptionRequiredResponse: vi.fn(),
  createAdminRestrictedResponse: vi.fn(),
}));

// The credit gate under test. Default: allowed. Individual tests override.
vi.mock('@pagespace/lib/billing/credit-gate', () => ({
  canConsumeAI: vi.fn().mockResolvedValue({ allowed: true, reason: 'unlimited' }),
}));

vi.mock('@/lib/websocket', () => ({
  broadcastCreditsEvent: vi.fn(),
  broadcastChatUserMessage: vi.fn(),
}));

vi.mock('@/lib/ai/core/provider-factory', () => ({
  createAIProvider: vi.fn().mockResolvedValue({ model: {} }),
  updateUserProviderSettings: vi.fn(),
  createProviderErrorResponse: vi.fn(),
  isProviderError: vi.fn().mockReturnValue(false),
}));
vi.mock('@/lib/ai/core/message-utils', () => ({
  extractMessageContent: vi.fn().mockReturnValue('test content'),
  extractToolCalls: vi.fn().mockReturnValue([]),
  extractToolResults: vi.fn().mockReturnValue([]),
  saveMessageToDatabase: vi.fn(),
  sanitizeMessagesForModel: vi.fn().mockReturnValue([]),
  convertDbMessageToUIMessage: vi.fn(),
}));
vi.mock('@/lib/ai/core/mention-processor', () => ({
  processMentionsInMessage: vi.fn().mockReturnValue({ mentions: [], pageIds: [] }),
}));
vi.mock('@/lib/ai/core/timestamp-utils', () => ({
  buildTimestampSystemPrompt: vi.fn().mockReturnValue(''),
}));
vi.mock('@/lib/ai/core/system-prompt', () => ({
  buildSystemPrompt: vi.fn().mockReturnValue(''),
  buildPersonalizationPrompt: vi.fn().mockReturnValue(''),
}));
vi.mock('@/lib/ai/core/tool-filtering', () => ({
  filterToolsForSandboxTier: vi.fn((tools: unknown) => tools),
  filterToolsForEphemeralWorkspace: vi.fn((tools: unknown) => tools),
  filterToolsForSandboxEnablement: vi.fn((tools: unknown) => tools),
  filterToolsForAgentAllowlist: vi.fn((tools: unknown) => tools),
  filterToolsForReadOnly: vi.fn().mockReturnValue({}),
  filterToolsForWebSearch: vi.fn().mockReturnValue({}),
  filterToolsForMcpScope: vi.fn().mockReturnValue({}),
  buildPageAITools: vi.fn().mockReturnValue({}),
}));
vi.mock('@/lib/ai/core/page-tree-context', () => ({
  getPageTreeContext: vi.fn(),
}));
vi.mock('@/lib/ai/core/ai-tools', () => ({ pageSpaceTools: {}, corePageSpaceTools: {} }));
vi.mock('@/lib/ai/core/mcp-tool-converter', () => ({
  convertMCPToolsToAISDKSchemas: vi.fn(),
  parseMCPToolName: vi.fn(),
  sanitizeToolNamesForProvider: vi.fn(),
}));
vi.mock('@/lib/ai/core/personalization-utils', () => ({
  getUserPersonalization: vi.fn().mockResolvedValue(null),
}));
vi.mock('ai', () => ({
  streamText: vi.fn(),
  convertToModelMessages: vi.fn().mockReturnValue([]),
  stepCountIs: vi.fn(),
  hasToolCall: vi.fn(() => () => false),
  tool: vi.fn((config) => config),
  createUIMessageStream: vi.fn(),
  createUIMessageStreamResponse: vi.fn(),
}));

vi.mock('@paralleldrive/cuid2', () => ({
  createId: vi.fn().mockReturnValue('generated_id'),
  init: vi.fn(() => vi.fn(() => 'test-cuid')),
}));

vi.mock('@/lib/logging/mask', () => ({ maskIdentifier: vi.fn((id: string) => `***${id.slice(-3)}`) }));
vi.mock('@pagespace/lib/monitoring/activity-tracker', () => ({ trackFeature: vi.fn() }));
vi.mock('@pagespace/lib/monitoring/ai-monitoring', () => ({
  AIMonitoring: { trackUsage: vi.fn(), trackToolUsage: vi.fn() },
  extractOpenRouterCostDollars: vi.fn(() => undefined),
  extractOpenRouterGenerationIds: vi.fn(() => []),
}));
vi.mock('@/lib/mcp', () => ({ getMCPBridge: vi.fn() }));
vi.mock('@/services/api/page-mutation-service', () => ({
  applyPageMutation: vi.fn(),
  PageRevisionMismatchError: class extends Error {},
}));
vi.mock('@/lib/ai/core/stream-abort-registry', () => ({
  createStreamAbortController: vi.fn().mockReturnValue({ streamId: 'stream_123', signal: new AbortController().signal }),
  removeStream: vi.fn(),
  STREAM_ID_HEADER: 'x-stream-id',
}));
vi.mock('@/lib/ai/core/validate-image-parts', () => ({
  validateUserMessageFileParts: vi.fn().mockReturnValue({ valid: true }),
  hasFileParts: vi.fn().mockReturnValue(false),
}));
vi.mock('@/lib/ai/core/model-capabilities', () => ({
  getModelCapabilities: vi.fn().mockResolvedValue({}),
  hasVisionCapability: vi.fn().mockReturnValue(true),
}));


// The subject: the eager conversation ensure, plus the credit hold it must not leak.
vi.mock('@/lib/repositories/conversation-repository', () => ({
  conversationRepository: {
    createConversation: vi.fn().mockResolvedValue('exists'),
    autoTitleConversation: vi.fn().mockResolvedValue(undefined),
    getConversationById: vi.fn().mockResolvedValue(null),
  },
}));
vi.mock('@pagespace/lib/billing/credit-consume', () => ({
  releaseHold: vi.fn().mockResolvedValue(undefined),
}));

import { POST } from '../route';
import { authenticateRequestWithOptions } from '@/lib/auth';
import { canConsumeAI } from '@pagespace/lib/billing/credit-gate';
import { conversationRepository } from '@/lib/repositories/conversation-repository';
import { releaseHold } from '@pagespace/lib/billing/credit-consume';
import { streamText } from 'ai';

const mockUserId = 'user_123';

const mockWebAuth = (userId: string): SessionAuthResult => ({
  userId,
  tokenVersion: 0,
  tokenType: 'session',
  sessionId: 'test-session-id',
  role: 'user',
  adminRoleVersion: 0,
});

const createChatRequest = () =>
  new Request('https://example.com/api/ai/chat', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'content-length': '200', 'X-Browser-Session-Id': 'session-1' },
    body: JSON.stringify({
      messages: [{ id: 'msg_1', role: 'user', parts: [{ type: 'text', text: 'Hello' }] }],
      chatId: 'page_123',
      selectedProvider: 'openai',
      selectedModel: 'openai/gpt-5.4-nano',
    }),
  });

describe('POST /api/ai/chat - conversation creation is fail-closed', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(authenticateRequestWithOptions).mockResolvedValue(mockWebAuth(mockUserId));
    vi.mocked(canConsumeAI).mockResolvedValue({ allowed: true, reason: 'unlimited', holdId: 'hold_1' } as never);
    vi.mocked(conversationRepository.createConversation).mockResolvedValue('exists');
  });

  it('given the conversation create THROWS, returns 500 and never invokes the model', async () => {
    vi.mocked(conversationRepository.createConversation).mockRejectedValue(
      new Error('deadlock detected'),
    );

    const response = await POST(createChatRequest());

    expect(response.status).toBe(500);
    const body = await response.json();
    expect(body.error).toContain('Failed to start conversation');
    // The whole point: the failure surfaces HERE, not later as an FK violation
    // inside createStreamLifecycle — so no generation is ever started.
    expect(streamText).not.toHaveBeenCalled();
  });

  it('surfaces the underlying database error so the failure is diagnosable', async () => {
    vi.mocked(conversationRepository.createConversation).mockRejectedValue(
      new Error('deadlock detected'),
    );

    const body = await (await POST(createChatRequest())).json();

    expect(body.details).toBe('deadlock detected');
  });

  it('releases the credit hold taken moments earlier rather than leaking it', async () => {
    vi.mocked(conversationRepository.createConversation).mockRejectedValue(new Error('boom'));

    await POST(createChatRequest());

    expect(releaseHold).toHaveBeenCalledWith('hold_1');
  });

  // These two assert the gate does NOT fire. They check the error BODY rather
  // than the status: this heavily-mocked request cannot be driven all the way
  // to a streamed response, so it ends in an unrelated downstream 500 — which
  // a bare `status !== 500` would mistake for the very failure under test.
  it('given the create RESOLVES, does not short-circuit the request', async () => {
    vi.mocked(conversationRepository.createConversation).mockResolvedValue('created');

    const body = await (await POST(createChatRequest())).json();

    expect(conversationRepository.createConversation).toHaveBeenCalled();
    expect(body.error).not.toContain('Failed to start conversation');
  });

  it('given message_owner_conflict (a status, not an error), proceeds as before', async () => {
    // Deliberately NOT turned into an error response by the fail-closed fix:
    // the message write's own in-transaction create/lock decides what happens,
    // exactly as it did before this change.
    vi.mocked(conversationRepository.createConversation).mockResolvedValue('message_owner_conflict');

    const body = await (await POST(createChatRequest())).json();

    expect(body.error).not.toContain('Failed to start conversation');
  });
});
