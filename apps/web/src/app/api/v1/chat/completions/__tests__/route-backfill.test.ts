import { describe, test, beforeEach, vi } from 'vitest';
import { assert } from '@/lib/ai/openai-api/__tests__/riteway';

// --- module mocks (must be hoisted before imports) ---

vi.mock('@/lib/auth', () => ({
  authenticateRequestWithOptions: vi.fn(),
  isAuthError: vi.fn((r: unknown) => r != null && typeof r === 'object' && 'error' in r),
  isMCPAuthResult: vi.fn((r: unknown) => (r as { tokenType?: string })?.tokenType === 'mcp'),
  checkMCPPageScope: vi.fn().mockResolvedValue(null),
  getAllowedDriveIds: vi.fn(() => []),
  isScopedMCPAuth: vi.fn(() => false),
  canPrincipalViewPage: vi.fn().mockResolvedValue(true),
  canPrincipalEditPage: vi.fn().mockResolvedValue(true),
}));

vi.mock('@pagespace/db/db', () => ({
  db: {
    select: vi.fn().mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          limit: vi.fn().mockResolvedValue([]),
        }),
      }),
    }),
    insert: vi.fn().mockReturnValue({ values: vi.fn().mockResolvedValue(undefined) }),
    query: {
      chatMessages: { findMany: vi.fn().mockResolvedValue([]) },
    },
  },
}));

vi.mock('@/lib/repositories/conversation-repository', () => ({
  conversationRepository: {
    getConversation: vi.fn().mockResolvedValue({
      id: 'conv-abc',
      userId: 'user-1',
      isActive: true,
      title: null,
      contextId: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    }),
    createConversation: vi.fn().mockResolvedValue(undefined),
  },
}));

vi.mock('@pagespace/db/operators', () => ({
  eq: vi.fn((_col, val) => ({ __eq: val })),
  and: vi.fn((...args) => ({ __and: args })),
}));

vi.mock('@pagespace/db/schema/core', () => ({
  pages: { id: 'pages.id', type: 'pages.type' },
  chatMessages: {},
  drives: {},
}));

vi.mock('@pagespace/db/schema/auth', () => ({
  users: {},
}));

vi.mock('@pagespace/lib/utils/enums', () => ({
  PageType: { AI_CHAT: 'AI_CHAT', DOCUMENT: 'DOCUMENT' },
}));

vi.mock('@pagespace/lib/permissions/permissions', () => ({
  canUserViewPage: vi.fn().mockResolvedValue(true),
  canUserEditPage: vi.fn().mockResolvedValue(true),
}));

vi.mock('@pagespace/lib/logging/logger-config', () => ({
  loggers: {
    ai: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  },
}));

vi.mock('@pagespace/lib/audit/audit-log', () => ({
  auditRequest: vi.fn(),
}));

vi.mock('@/lib/ai/core/provider-factory', () => ({
  createAIProvider: vi.fn().mockResolvedValue({ model: {}, provider: 'openai', modelName: 'openai/gpt-5.3-chat' }),
  isProviderError: vi.fn((r: unknown) => r != null && typeof r === 'object' && 'error' in r && 'status' in r),
}));

vi.mock('@/lib/ai/core/system-prompt', () => ({
  buildSystemPrompt: vi.fn().mockReturnValue('You are a helpful agent.'),
}));

vi.mock('@/lib/ai/core/message-utils', () => ({
  sanitizeMessagesForModel: vi.fn((msgs: unknown[]) => msgs),
  saveMessageToDatabase: vi.fn().mockResolvedValue(undefined),
  convertDbMessageToUIMessage: vi.fn((m: unknown) => {
    const msg = m as { id: string; role: string; content: string };
    return { id: msg.id, role: msg.role as 'user' | 'assistant', parts: [{ type: 'text' as const, text: msg.content || '' }] };
  }),
  extractMessageContent: vi.fn().mockReturnValue('Hello'),
  extractToolResults: vi.fn().mockReturnValue([]),
}));

vi.mock('@/lib/ai/core/ai-tools', () => ({
  pageSpaceTools: {},
}));

vi.mock('@/lib/ai/core/tool-filtering', () => ({
  filterToolsForAgentAllowlist: vi.fn((tools: unknown) => tools),
  filterToolsForReadOnly: vi.fn((tools: unknown) => tools),
  filterToolsForMcpScope: vi.fn((tools: unknown) => tools),
  filterToolsForImageGen: vi.fn((tools: unknown) => tools),
}));

vi.mock('@/lib/ai/core/model-capabilities', () => ({
  getModelCapabilities: vi.fn().mockResolvedValue({}),
  hasVisionCapability: vi.fn().mockReturnValue(true),
}));

vi.mock('@/lib/ai/tools/tool-exposure', () => ({
  applyToolExposureMode: vi.fn((tools: unknown) => ({ tools, toolDiscoveryPrompt: '' })),
}));

vi.mock('@/lib/ai/tools/finish-tool', () => ({
  finishTool: {},
  FINISH_TOOL_NAME: 'finish',
}));

vi.mock('@paralleldrive/cuid2', () => ({
  createId: vi.fn().mockReturnValue('test-id-123'),
}));

vi.mock('@/lib/repositories/chat-message-repository', () => ({
  chatMessageRepository: {
    getMessagesForPage: vi.fn().mockResolvedValue([]),
    getMessagesByConversationId: vi.fn().mockResolvedValue([]),
    updateMessageToolResults: vi.fn().mockResolvedValue(undefined),
  },
}));

vi.mock('@pagespace/lib/monitoring/ai-monitoring', () => ({
  AIMonitoring: {
    trackUsage: vi.fn().mockResolvedValue(undefined),
  },
  extractOpenRouterCostDollars: vi.fn(() => undefined),
  extractOpenRouterGenerationIds: vi.fn(() => []),
}));

vi.mock('@pagespace/lib/billing/credit-gate', () => ({
  canConsumeAI: vi.fn().mockResolvedValue({ allowed: true, reason: 'unlimited' }),
}));

vi.mock('ai', async (importOriginal) => {
  const actual = await importOriginal<typeof import('ai')>();
  return {
    ...actual,
    streamText: vi.fn().mockImplementation(() => ({
      totalUsage: Promise.resolve({ inputTokens: 10, outputTokens: 5 }),
      steps: Promise.resolve([]),
      toUIMessageStream: async function* () {
        yield { type: 'start' };
        yield { type: 'text-delta', id: 'text-1', delta: 'Hello' };
        yield { type: 'finish' };
      },
    })),
  };
});

// --- imports after mocks ---
import { POST } from '../route';
import { authenticateRequestWithOptions } from '@/lib/auth';
import { db } from '@pagespace/db/db';
import { canPrincipalViewPage, canPrincipalEditPage } from '@/lib/auth';
import { chatMessageRepository } from '@/lib/repositories/chat-message-repository';
import { extractToolResults } from '@/lib/ai/core/message-utils';
import { canConsumeAI } from '@pagespace/lib/billing/credit-gate';
import { conversationRepository } from '@/lib/repositories/conversation-repository';

const mcpAuth = {
  userId: 'user-1',
  tokenType: 'mcp' as const,
  tokenId: 'token-1',
  allowedDriveIds: [],
  role: 'user' as const,
  tokenVersion: 1,
  adminRoleVersion: 0,
};

const agentPage = {
  id: 'page-123',
  type: 'AI_CHAT',
  title: 'Test Agent',
  driveId: 'drive-abc',
  systemPrompt: null,
  aiProvider: 'openai',
  aiModel: 'openai/gpt-5.3-chat',
  includeDrivePrompt: false,
};

const makeRequest = (body: unknown, authHeader = 'Bearer mcp_test123') =>
  new Request('http://localhost/api/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: authHeader },
    body: JSON.stringify(body),
  });

describe('POST /api/v1/chat/completions — back-fill tool results', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(authenticateRequestWithOptions).mockResolvedValue(mcpAuth);
    vi.mocked(canPrincipalViewPage).mockResolvedValue(true);
    vi.mocked(canPrincipalEditPage).mockResolvedValue(true);
    vi.mocked(db.select).mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue([agentPage]),
      }),
    } as unknown as ReturnType<typeof db.select>);
    vi.mocked(chatMessageRepository.getMessagesForPage).mockResolvedValue([]);
    vi.mocked(canConsumeAI).mockResolvedValue({ allowed: true, reason: 'unlimited' });
  });

  test('back-fills tool results matched by tool_call_id against DB rows', async () => {
    const fakeResults = [{ toolCallId: 'tc-1', toolName: 'Read', output: 'file contents', state: 'output-available' as const }];
    vi.mocked(extractToolResults).mockReturnValue(fakeResults);

    vi.mocked(chatMessageRepository.getMessagesByConversationId).mockResolvedValueOnce([{
      id: 'db-row-server-id',
      pageId: 'page-123',
      conversationId: 'conv-abc',
      userId: 'user-1',
      role: 'assistant',
      content: '',
      messageType: 'standard' as const,
      isActive: true,
      createdAt: new Date(),
      editedAt: null,
      toolCalls: JSON.stringify([{ toolCallId: 'tc-1', toolName: 'Read', input: {} }]),
      toolResults: null,
      status: 'complete' as const,
    }]);

    vi.mocked(conversationRepository.getConversation).mockResolvedValueOnce({
      id: 'conv-abc',
      userId: 'user-1',
      isActive: true,
      title: null,
      contextId: null,
      createdAt: new Date(),
      updatedAt: new Date(),
      isShared: false,
      type: 'page',
      lastMessageAt: null,
    });

    const fullHistory = [
      { role: 'user', id: 'u-0', parts: [{ type: 'text', text: 'What is in foo.ts?' }] },
      { role: 'assistant', id: 'asst-prior', parts: [
        { type: 'tool-Read', toolCallId: 'tc-1', toolName: 'Read', input: { path: 'foo.ts' }, state: 'output-available', output: 'file contents' },
      ]},
      { role: 'user', id: 'u-1', parts: [{ type: 'text', text: 'Summarise it' }] },
    ];

    const response = await POST(makeRequest({
      model: 'ps-agent://page-123',
      messages: fullHistory,
      conversation_id: 'conv-abc',
      client_manages_history: true,
    }));
    await response.text();
    await new Promise(r => setTimeout(r, 0));

    const backFillCalls = vi.mocked(chatMessageRepository.updateMessageToolResults).mock.calls;
    assert({
      given: 'client_manages_history=true with a prior assistant message carrying output-available tool parts',
      should: 'back-fill using the DB row ID matched via tool_call_id, not the UIMessage id',
      actual: {
        called: backFillCalls.length,
        messageId: backFillCalls[0]?.[0],
        conversationId: backFillCalls[0]?.[1],
        resultsCount: (backFillCalls[0]?.[2] as unknown[])?.length,
      },
      expected: { called: 1, messageId: 'db-row-server-id', conversationId: 'conv-abc', resultsCount: 1 },
    });
  });

  test('back-fills using DB row ID when messages lack explicit IDs (pi/OpenAI format)', async () => {
    // pagespace-cli sends OpenAI-format messages with no `id` field.
    // normalizeMessages assigns createId() = 'test-id-123' — a random ID that
    // will never match the server-assigned DB row ID.
    // The fix must correlate via tool_call_id against DB rows, not via msg.id.
    const fakeResults = [{ toolCallId: 'tc-1', toolName: 'Read', output: 'file contents', state: 'output-available' as const }];
    vi.mocked(extractToolResults).mockReturnValue(fakeResults);

    vi.mocked(chatMessageRepository.getMessagesByConversationId).mockResolvedValueOnce([{
      id: 'db-row-server-id',
      pageId: 'page-123',
      conversationId: 'conv-abc',
      userId: 'user-1',
      role: 'assistant',
      content: '',
      messageType: 'standard' as const,
      isActive: true,
      createdAt: new Date(),
      editedAt: null,
      toolCalls: JSON.stringify([{ toolCallId: 'tc-1', toolName: 'Read', input: {} }]),
      toolResults: null,
      status: 'complete' as const,
    }]);

    vi.mocked(conversationRepository.getConversation).mockResolvedValueOnce({
      id: 'conv-abc',
      userId: 'user-1',
      isActive: true,
      title: null,
      contextId: null,
      createdAt: new Date(),
      updatedAt: new Date(),
      isShared: false,
      type: 'page',
      lastMessageAt: null,
    });

    // OpenAI-format messages with no `id` fields, just like pagespace-cli sends
    const fullHistory = [
      { role: 'user', content: 'What is in foo.ts?' },
      { role: 'assistant', content: null, tool_calls: [{ id: 'tc-1', type: 'function', function: { name: 'Read', arguments: '{}' } }] },
      { role: 'tool', tool_call_id: 'tc-1', content: 'file contents' },
      { role: 'user', content: 'Summarise it' },
    ];

    const response = await POST(makeRequest({
      model: 'ps-agent://page-123',
      messages: fullHistory,
      conversation_id: 'conv-abc',
      client_manages_history: true,
    }));
    await response.text();
    await new Promise(r => setTimeout(r, 0));

    const backFillCalls = vi.mocked(chatMessageRepository.updateMessageToolResults).mock.calls;
    assert({
      given: 'client_manages_history=true with OpenAI-format messages that have no id fields',
      should: 'back-fill using the server-assigned DB row ID, not the random UIMessage id',
      actual: {
        called: backFillCalls.length > 0,
        messageId: backFillCalls[0]?.[0],
      },
      expected: { called: true, messageId: 'db-row-server-id' },
    });
  });

  test('does not call updateMessageToolResults when no prior messages have tool results', async () => {
    vi.mocked(extractToolResults).mockReturnValue([]);
    vi.mocked(conversationRepository.getConversation).mockResolvedValueOnce({
      id: 'conv-abc',
      userId: 'user-1',
      isActive: true,
      title: null,
      contextId: null,
      createdAt: new Date(),
      updatedAt: new Date(),
      isShared: false,
      type: 'page',
      lastMessageAt: null,
    });

    const fullHistory = [
      { role: 'user', id: 'u-0', parts: [{ type: 'text', text: 'Hello' }] },
      { role: 'assistant', id: 'a-0', parts: [{ type: 'text', text: 'Hi' }] },
      { role: 'user', id: 'u-1', parts: [{ type: 'text', text: 'Continue' }] },
    ];

    const response = await POST(makeRequest({
      model: 'ps-agent://page-123',
      messages: fullHistory,
      conversation_id: 'conv-abc',
      client_manages_history: true,
    }));
    await response.text();

    assert({
      given: 'client_manages_history=true but no prior assistant messages have output-available tool parts',
      should: 'not call updateMessageToolResults at all',
      actual: vi.mocked(chatMessageRepository.updateMessageToolResults).mock.calls.length,
      expected: 0,
    });
  });
});
