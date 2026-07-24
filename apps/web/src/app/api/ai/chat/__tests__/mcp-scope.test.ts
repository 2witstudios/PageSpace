/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextResponse } from 'next/server';
import { POST } from '../route';
import type { SessionAuthResult, MCPAuthResult } from '@/lib/auth';

// ============================================================================
// MCP Page Scope Enforcement Tests for POST /api/ai/chat
//
// Verifies that scoped MCP tokens cannot access AI chats on pages
// outside their allowed drives. Session auth should pass through unchanged.
// ============================================================================

// Mock all heavy dependencies to isolate scope enforcement logic

vi.mock('@/lib/auth', () => ({
  authenticateRequestWithOptions: vi.fn(),
  isAuthError: vi.fn((result: any) => 'error' in result),
  checkMCPPageScope: vi.fn().mockResolvedValue(null),
  getAllowedDriveIds: vi.fn(() => []),
  isScopedMCPAuth: vi.fn(() => false),
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
      info: vi.fn(),
      error: vi.fn(),
      warn: vi.fn(),
      debug: vi.fn(),
      trace: vi.fn(),
      child: vi.fn(() => ({
        info: vi.fn(),
        error: vi.fn(),
        warn: vi.fn(),
        debug: vi.fn(),
        trace: vi.fn(),
      })),
    },
  },
  logger: { child: vi.fn(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() })) },
}));
vi.mock('@pagespace/lib/audit/audit-log', () => ({
    auditRequest: vi.fn(),
}));

vi.mock('@pagespace/db/db', () => ({
  db: {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn().mockResolvedValue([
          {
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
          },
        ]),
        orderBy: vi.fn().mockResolvedValue([]),
        limit: vi.fn().mockResolvedValue([]),
      })),
    })),
  },
}));
// exists/sql: globalConversationRepository's module-scope `hasMessages` query
// (now reachable transitively via stream-takeover -> materialize-interrupted-stream
// -> global-conversation-repository, #2153) needs both or the module throws on import.
vi.mock('@pagespace/db/operators', () => ({
  eq: vi.fn(),
  and: vi.fn(),
  exists: vi.fn(),
  sql: vi.fn(),
}));
vi.mock('@pagespace/db/schema/auth', () => ({
  users: { id: 'id' },
}));
vi.mock('@pagespace/db/schema/core', () => ({
  chatMessages: { pageId: 'pageId', conversationId: 'conversationId', isActive: 'isActive', createdAt: 'createdAt' },
  pages: { id: 'id' },
  drives: { id: 'id', drivePrompt: 'drivePrompt' },
}));

vi.mock('@/lib/subscription/rate-limit-middleware', () => ({
  requiresProSubscription: vi.fn().mockReturnValue(false),
  createSubscriptionRequiredResponse: vi.fn(),
}));

vi.mock('@pagespace/lib/billing/credit-gate', () => ({
  canConsumeAI: vi.fn().mockResolvedValue({ allowed: true, reason: 'unlimited' }),
}));

vi.mock('@/lib/websocket', () => ({
  broadcastCreditsEvent: vi.fn(),
}));

vi.mock('@/lib/ai/core/provider-factory', () => ({
  createAIProvider: vi.fn().mockResolvedValue({ model: {} }),
  updateUserProviderSettings: vi.fn(),
  createProviderErrorResponse: vi.fn(),
  isProviderError: vi.fn().mockReturnValue(false),
}));
vi.mock('@/lib/ai/core/ai-tools', () => ({
  pageSpaceTools: {},
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
vi.mock('@/lib/ai/core/model-capabilities', () => ({
  getModelCapabilities: vi.fn(),
}));
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

vi.mock('@/lib/logging/mask', () => ({
  maskIdentifier: vi.fn((id: string) => `***${id.slice(-3)}`),
}));

vi.mock('@pagespace/lib/monitoring/activity-tracker', () => ({
  trackFeature: vi.fn(),
}));

vi.mock('@pagespace/lib/monitoring/ai-monitoring', () => ({
  AIMonitoring: {
    trackUsage: vi.fn(),
    trackToolUsage: vi.fn(),
  },
  extractOpenRouterCostDollars: vi.fn(() => undefined),
  extractOpenRouterGenerationIds: vi.fn(() => []),
}));

vi.mock('@/lib/mcp', () => ({
  getMCPBridge: vi.fn(),
}));

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
  hasVisionCapability: vi.fn().mockReturnValue(true),
}));

import { authenticateRequestWithOptions, checkMCPPageScope } from '@/lib/auth';

// ============================================================================
// Test Fixtures
// ============================================================================

const mockUserId = 'user_123';
const chatIdInScope = 'page_123';     // Page in drive_A (within scope)
const chatIdOutOfScope = 'page_456';  // Page in drive_B (outside scope)

const mockWebAuth = (userId: string): SessionAuthResult => ({
  userId,
  tokenVersion: 0,
  tokenType: 'session',
  sessionId: 'test-session-id',
  role: 'user',
  adminRoleVersion: 0,
});

const mockMCPAuth = (userId: string, allowedDriveIds: string[]): MCPAuthResult => ({
  userId,
  tokenVersion: 0,
  tokenType: 'mcp',
  tokenId: 'mcp-token-id',
  role: 'user',
  adminRoleVersion: 0,
  allowedDriveIds,
});

const createChatRequest = (chatId: string) => {
  return new Request('https://example.com/api/ai/chat', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'content-length': '200', 'X-Browser-Session-Id': 'session-1' },
    body: JSON.stringify({
      messages: [
        { id: 'msg_1', role: 'user', parts: [{ type: 'text', text: 'Hello' }] },
      ],
      chatId,
      selectedProvider: 'openai',
      selectedModel: 'openai/gpt-5.3-chat',
    }),
  });
};

// ============================================================================
// MCP Scope Enforcement Tests
// ============================================================================

describe('POST /api/ai/chat - MCP page scope enforcement', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should return 403 when scoped MCP token accesses a page outside its scope', async () => {
    const auth = mockMCPAuth(mockUserId, ['drive_A']);
    vi.mocked(authenticateRequestWithOptions).mockResolvedValue(auth);

    // Simulate checkMCPPageScope returning 403 for out-of-scope page
    vi.mocked(checkMCPPageScope).mockResolvedValue(
      NextResponse.json(
        { error: 'This token does not have access to this drive' },
        { status: 403 }
      )
    );

    const request = createChatRequest(chatIdOutOfScope);
    const response = await POST(request);

    expect(response.status).toBe(403);
    const body = await response.json();
    expect(body.error).toContain('token does not have access');
    expect(checkMCPPageScope).toHaveBeenCalledWith(auth, chatIdOutOfScope);
  });

  it('should proceed when scoped MCP token accesses a page within its scope', async () => {
    const auth = mockMCPAuth(mockUserId, ['drive_A']);
    vi.mocked(authenticateRequestWithOptions).mockResolvedValue(auth);
    vi.mocked(checkMCPPageScope).mockResolvedValue(null);

    const request = createChatRequest(chatIdInScope);
    // The route will proceed past scope check but may fail at streaming setup.
    // The important thing: checkMCPPageScope was called and returned null (pass).
    // We can catch the eventual error from the complex streaming logic.
    const response = await POST(request);

    expect(checkMCPPageScope).toHaveBeenCalledWith(auth, chatIdInScope);
    // Should NOT be a 403 scope error
    if (response.status === 403) {
      const body = await response.json();
      expect(body.error).not.toContain('token does not have access');
    }
  });

  it('should pass through for session auth without scope check blocking', async () => {
    const auth = mockWebAuth(mockUserId);
    vi.mocked(authenticateRequestWithOptions).mockResolvedValue(auth);
    vi.mocked(checkMCPPageScope).mockResolvedValue(null);

    const request = createChatRequest(chatIdInScope);
    const response = await POST(request);

    expect(checkMCPPageScope).toHaveBeenCalledWith(auth, chatIdInScope);
    // Session auth: scope check always returns null (passthrough)
    // Should NOT be a 403 scope error
    if (response.status === 403) {
      const body = await response.json();
      expect(body.error).not.toContain('token does not have access');
    }
  });
});
