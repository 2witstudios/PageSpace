// @vitest-environment node
// See route.test.ts header comment for why this file forces the node env.
//
// Verifies that create_drive (account-level-only, cannot be used by a
// drive-scoped MCP token) is excluded from the tool list built for a scoped
// MCP token, while an unscoped token (empty allowedDriveIds) still sees it.
// Spies on the REAL filterToolsForMcpScope (via importOriginal) so we assert
// on its actual isScoped argument and return value.
import { describe, test, beforeEach, vi, expect } from 'vitest';

vi.mock('@/lib/auth', () => ({
  authenticateRequestWithOptions: vi.fn(),
  isAuthError: vi.fn((r: unknown) => r != null && typeof r === 'object' && 'error' in r),
  isMCPAuthResult: vi.fn((r: unknown) => (r as { tokenType?: string })?.tokenType === 'mcp'),
  checkMCPPageScope: vi.fn().mockResolvedValue(null),
  getAllowedDriveIds: vi.fn((auth: { allowedDriveIds?: string[] }) => auth.allowedDriveIds ?? []),
  isScopedMCPAuth: vi.fn((auth: { allowedDriveIds?: string[] }) => (auth.allowedDriveIds ?? []).length > 0),
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
// pageSpaceTools includes create_drive so filtering behavior is observable.
vi.mock('@/lib/ai/core/ai-tools', () => ({
  pageSpaceTools: {
    create_drive: { description: 'create_drive' },
    list_pages: { description: 'list_pages' },
  },
}));
vi.mock('@/lib/ai/core/tool-filtering', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/ai/core/tool-filtering')>();
  return {
    ...actual,
    filterToolsForReadOnly: vi.fn((tools: unknown) => tools),
    filterToolsForMcpScope: vi.fn(actual.filterToolsForMcpScope),
  };
});
vi.mock('@/lib/ai/core/model-capabilities', () => ({
  getModelCapabilities: vi.fn().mockResolvedValue({}),
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

vi.mock('@pagespace/lib/billing/credit-consume', () => ({
  releaseHold: vi.fn().mockResolvedValue(undefined),
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
        yield { type: 'finish' };
      },
    })),
  };
});

// --- imports after mocks ---
import { POST } from '../route';
import { authenticateRequestWithOptions, canPrincipalViewPage, canPrincipalEditPage } from '@/lib/auth';
import { db } from '@pagespace/db/db';
import { chatMessageRepository } from '@/lib/repositories/chat-message-repository';
import { canConsumeAI } from '@pagespace/lib/billing/credit-gate';
import { filterToolsForMcpScope } from '@/lib/ai/core/tool-filtering';

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

const validBody = {
  model: 'ps-agent://page-123',
  messages: [{ role: 'user', id: 'msg-1', content: 'Hello', parts: [{ type: 'text', text: 'Hello' }] }],
};

const makeRequest = (body: unknown, authHeader = 'Bearer mcp_test123') =>
  new Request('http://localhost/api/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: authHeader },
    body: JSON.stringify(body),
  });

describe('POST /api/v1/chat/completions - account-level-only tool listing', () => {
  beforeEach(() => {
    vi.clearAllMocks();
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

  test('excludes create_drive from the tool list for a drive-scoped MCP token', async () => {
    vi.mocked(authenticateRequestWithOptions).mockResolvedValue({
      userId: 'user-1',
      tokenType: 'mcp' as const,
      tokenId: 'token-1',
      allowedDriveIds: ['drive-abc'],
      role: 'user' as const,
      tokenVersion: 1,
      adminRoleVersion: 0,
    });

    await POST(makeRequest(validBody));

    expect(filterToolsForMcpScope).toHaveBeenCalledWith(expect.anything(), true);
    const filtered = vi.mocked(filterToolsForMcpScope).mock.results[0]?.value as Record<string, unknown>;
    expect(filtered).not.toHaveProperty('create_drive');
    expect(filtered).toHaveProperty('list_pages');
  });

  test('includes create_drive in the tool list for an unscoped MCP token', async () => {
    vi.mocked(authenticateRequestWithOptions).mockResolvedValue({
      userId: 'user-1',
      tokenType: 'mcp' as const,
      tokenId: 'token-1',
      allowedDriveIds: [],
      role: 'user' as const,
      tokenVersion: 1,
      adminRoleVersion: 0,
    });

    await POST(makeRequest(validBody));

    expect(filterToolsForMcpScope).toHaveBeenCalledWith(expect.anything(), false);
    const filtered = vi.mocked(filterToolsForMcpScope).mock.results[0]?.value as Record<string, unknown>;
    expect(filtered).toHaveProperty('create_drive');
    expect(filtered).toHaveProperty('list_pages');
  });
});
