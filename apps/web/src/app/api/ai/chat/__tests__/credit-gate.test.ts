/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { SessionAuthResult } from '@/lib/auth';

// ============================================================================
// Prepaid credit-gate enforcement for POST /api/ai/chat
//
// Verifies the gate is consulted BEFORE the model is invoked: an out-of-credits
// user gets a 402 and the stream never starts; an allowed/unlimited user is not
// blocked by the gate. Heavy dependencies are mocked to isolate gate behavior.
// ============================================================================

vi.mock('@/lib/auth', () => ({
  authenticateRequestWithOptions: vi.fn(),
  isAuthError: vi.fn((result: any) => 'error' in result),
  isMCPAuthResult: vi.fn((r: any) => r?.tokenType === 'mcp'),
  checkMCPPageScope: vi.fn().mockResolvedValue(null),
  getAllowedDriveIds: vi.fn(() => []),
  isScopedMCPAuth: vi.fn(() => false),
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
    aiModel: 'openai/gpt-5.3-chat',
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
vi.mock('@pagespace/db/operators', () => ({ eq: vi.fn(), and: vi.fn() }));
vi.mock('@pagespace/db/schema/auth', () => ({ users: { id: 'id' } }));
vi.mock('@pagespace/db/schema/core', () => ({
  chatMessages: { pageId: 'pageId', conversationId: 'conversationId', isActive: 'isActive', createdAt: 'createdAt' },
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
// Phase 6 (#2166): the route now derives a Machine Pane binding for every
// request. None of these requests carry a machine-bound conversationId, so
// this resolves to null (not a machine-bound pane) — the real DB-backed
// deps builder is stubbed out since the pure core itself is fully mocked.
vi.mock('@pagespace/lib/services/machines/machine-pane-binding', () => ({
  deriveMachinePaneBinding: vi.fn().mockResolvedValue(null),
}));
vi.mock('@/lib/ai/machine-pane/machine-pane-binding-runtime', () => ({
  buildMachinePaneBindingDeps: vi.fn(() => ({})),
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

import { POST } from '../route';
import { authenticateRequestWithOptions } from '@/lib/auth';
import { canConsumeAI } from '@pagespace/lib/billing/credit-gate';
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
      selectedModel: 'openai/gpt-5.3-chat',
    }),
  });

describe('POST /api/ai/chat - prepaid credit gate', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(authenticateRequestWithOptions).mockResolvedValue(mockWebAuth(mockUserId));
    vi.mocked(canConsumeAI).mockResolvedValue({ allowed: true, reason: 'unlimited' });
  });

  it('returns 402 out_of_credits and never starts the stream when the gate denies', async () => {
    vi.mocked(canConsumeAI).mockResolvedValue({ allowed: false, reason: 'out_of_credits' });

    const response = await POST(createChatRequest());

    expect(response.status).toBe(402);
    const body = await response.json();
    expect(body.error).toBe('out_of_credits');
    expect(streamText).not.toHaveBeenCalled();
  });

  it('returns 429 too_many_in_flight (not 402) when the free in-flight cap is hit', async () => {
    vi.mocked(canConsumeAI).mockResolvedValue({ allowed: false, reason: 'too_many_in_flight' });

    const response = await POST(createChatRequest());

    expect(response.status).toBe(429);
    const body = await response.json();
    expect(body.error).toBe('too_many_in_flight');
    expect(streamText).not.toHaveBeenCalled();
  });

  it('does not block with a 402 when the gate allows', async () => {
    vi.mocked(canConsumeAI).mockResolvedValue({ allowed: true, reason: 'ok' });

    const response = await POST(createChatRequest());

    expect(canConsumeAI).toHaveBeenCalled();
    expect(response.status).not.toBe(402);
  });

  it('does not block with a 402 when billing is disabled (unlimited)', async () => {
    vi.mocked(canConsumeAI).mockResolvedValue({ allowed: true, reason: 'unlimited' });

    const response = await POST(createChatRequest());

    expect(response.status).not.toBe(402);
  });

});
