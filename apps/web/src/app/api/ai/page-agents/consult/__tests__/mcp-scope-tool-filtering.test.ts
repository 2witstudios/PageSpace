import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { MCPAuthResult, SessionAuthResult } from '@/lib/auth';

// ============================================================================
// Account-level-only tool listing for POST /api/ai/page-agents/consult
//
// Verifies that create_drive (account-level-only, cannot be used by a
// drive-scoped MCP token) is excluded from availableTools for a scoped MCP
// token, while session/unscoped auth still sees it. Spies on the REAL
// filterToolsForMcpScope (via importOriginal) rather than stubbing it away.
// ============================================================================

vi.mock('@/lib/auth', () => ({
  authenticateRequestWithOptions: vi.fn(),
  isAuthError: vi.fn((r: unknown) => r != null && typeof r === 'object' && 'error' in r),
  isMCPAuthResult: vi.fn((r: { tokenType?: string }) => r?.tokenType === 'mcp'),
  checkMCPPageScope: vi.fn().mockResolvedValue(null),
  getAllowedDriveIds: vi.fn((auth: { allowedDriveIds?: string[] }) => auth.allowedDriveIds ?? []),
  canPrincipalViewPage: vi.fn(async (auth: { userId: string }, pageId: string) => {
    const { canUserViewPage } = await import('@pagespace/lib/permissions/permissions');
    return canUserViewPage(auth.userId, pageId);
  }),
}));

vi.mock('@pagespace/lib/permissions/permissions', () => ({
  canUserViewPage: vi.fn().mockResolvedValue(true),
}));

vi.mock('@pagespace/lib/logging/logger-config', () => ({
  loggers: {
    api: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn(), trace: vi.fn() },
    ai: { child: vi.fn(() => ({ info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn(), trace: vi.fn() })) },
  },
}));

vi.mock('@/lib/ai/core/model-capabilities', () => ({
  supportsTemperature: vi.fn().mockResolvedValue(true),
}));

vi.mock('@pagespace/lib/audit/audit-log', () => ({ auditRequest: vi.fn() }));

// enabledTools includes create_drive so filtering behavior is observable.
const agentPage = { id: 'agent-1', type: 'AI_CHAT', title: 'Helper', driveId: 'drive-1', aiProvider: 'openai', aiModel: 'openai/gpt-5.3-chat', systemPrompt: 'You help.', enabledTools: ['create_drive', 'list_pages'], subscriptionTier: 'pro', role: 'user' };

vi.mock('@pagespace/db/db', () => {
  type QueryBuilder = {
    from: () => QueryBuilder;
    where: () => QueryBuilder;
    orderBy: () => QueryBuilder;
    limit: () => QueryBuilder;
    then: (resolve: (v: unknown[]) => unknown) => unknown;
  };
  const builder: QueryBuilder = {
    from: vi.fn(() => builder),
    where: vi.fn(() => builder),
    orderBy: vi.fn(() => builder),
    limit: vi.fn(() => builder),
    then: (resolve: (v: unknown[]) => unknown) => resolve([agentPage]),
  };
  return { db: { select: vi.fn(() => builder) } };
});
vi.mock('@pagespace/db/operators', () => ({ eq: vi.fn(), desc: vi.fn(), and: vi.fn() }));
vi.mock('@/lib/ai/core/message-utils', () => ({ saveMessageToDatabase: vi.fn().mockResolvedValue(undefined) }));
vi.mock('@pagespace/db/schema/core', () => ({ pages: { id: 'id' }, drives: { id: 'id' }, chatMessages: { pageId: 'pageId', createdAt: 'createdAt' } }));
vi.mock('@pagespace/db/schema/auth', () => ({ users: { id: 'id', subscriptionTier: 'subscriptionTier' } }));

vi.mock('@pagespace/lib/billing/credit-gate', () => ({
  canConsumeAI: vi.fn().mockResolvedValue({ allowed: true, reason: 'unlimited' }),
}));

vi.mock('@pagespace/lib/monitoring/ai-monitoring', () => ({
  AIMonitoring: { trackUsage: vi.fn(), trackToolUsage: vi.fn() },
}));

vi.mock('@/lib/ai/core/provider-factory', () => ({
  createAIProvider: vi.fn().mockResolvedValue({ model: {}, provider: 'openai', modelName: 'openai/gpt-5.3-chat' }),
  isProviderError: vi.fn().mockReturnValue(false),
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
    filterToolsForMcpScope: vi.fn(actual.filterToolsForMcpScope),
  };
});
vi.mock('@/lib/ai/core/timestamp-utils', () => ({
  buildTimestampSystemPrompt: vi.fn().mockReturnValue(''),
}));
vi.mock('@/lib/ai/core/personalization-utils', () => ({
  getUserTimezone: vi.fn().mockResolvedValue('UTC'),
}));
vi.mock('@/lib/ai/core/ai-providers-config', () => ({
  DEFAULT_PROVIDER: 'openai',
  DEFAULT_MODEL: 'openai/gpt-5.3-chat',
  ADMIN_ONLY_PROVIDERS: new Set<string>(['glm']),
  resolveProviderModel: vi.fn((sp: string, sm: string) => ({
    provider: sp && sm ? sp : 'openai',
    model: sm || 'openai/gpt-5.3-chat',
  })),
}));

vi.mock('@/lib/ai/core/tool-utils', () => ({ mergeToolSets: vi.fn((a: Record<string, unknown>, b: Record<string, unknown>) => ({ ...a, ...b })) }));
vi.mock('@/lib/ai/tools/finish-tool', () => ({ finishTool: {}, FINISH_TOOL_NAME: 'finish' }));
vi.mock('@/lib/ai/core/integration-tool-resolver', () => ({
  resolvePageAgentIntegrationTools: vi.fn().mockResolvedValue({}),
}));

vi.mock('ai', () => ({
  generateText: vi.fn().mockResolvedValue({
    text: 'answer',
    steps: [{ text: 'answer', content: [] }],
    totalUsage: { inputTokens: 5, outputTokens: 3, totalTokens: 8 },
  }),
  convertToModelMessages: vi.fn().mockReturnValue([]),
  stepCountIs: vi.fn(),
  hasToolCall: vi.fn(() => () => false),
}));

import { POST } from '../route';
import { authenticateRequestWithOptions } from '@/lib/auth';
import { filterToolsForMcpScope } from '@/lib/ai/core/tool-filtering';

const mockWebAuth = (): SessionAuthResult => ({
  userId: 'user-1',
  tokenVersion: 0,
  tokenType: 'session',
  sessionId: 'sess-1',
  role: 'user',
  adminRoleVersion: 0,
});

const mockMCPAuth = (allowedDriveIds: string[]): MCPAuthResult => ({
  userId: 'user-1',
  tokenVersion: 0,
  tokenType: 'mcp',
  tokenId: 'mcp-token-1',
  role: 'user',
  adminRoleVersion: 0,
  allowedDriveIds,
});

const makeRequest = () =>
  new Request('https://example.com/api/ai/page-agents/consult', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ agentId: 'agent-1', question: 'What is up?' }),
  });

describe('POST /api/ai/page-agents/consult - account-level-only tool listing', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    agentPage.aiProvider = 'openai';
    agentPage.aiModel = 'openai/gpt-5.3-chat';
    agentPage.role = 'user';
  });

  it('excludes create_drive from availableTools for a drive-scoped MCP token', async () => {
    vi.mocked(authenticateRequestWithOptions).mockResolvedValue(mockMCPAuth(['drive-1']));

    await POST(makeRequest());

    expect(filterToolsForMcpScope).toHaveBeenCalledWith(expect.anything(), true);
    const filtered = vi.mocked(filterToolsForMcpScope).mock.results[0]?.value as Record<string, unknown>;
    expect(filtered).not.toHaveProperty('create_drive');
    expect(filtered).toHaveProperty('list_pages');
  });

  it('includes create_drive in availableTools for session (unscoped) auth', async () => {
    vi.mocked(authenticateRequestWithOptions).mockResolvedValue(mockWebAuth());

    await POST(makeRequest());

    expect(filterToolsForMcpScope).toHaveBeenCalledWith(expect.anything(), false);
    const filtered = vi.mocked(filterToolsForMcpScope).mock.results[0]?.value as Record<string, unknown>;
    expect(filtered).toHaveProperty('create_drive');
    expect(filtered).toHaveProperty('list_pages');
  });
});
