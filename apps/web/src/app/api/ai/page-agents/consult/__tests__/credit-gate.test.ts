import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { SessionAuthResult } from '@/lib/auth';

// ============================================================================
// Prepaid credit-gate enforcement for POST /api/ai/page-agents/consult
//
// The gate is consulted after the view-permission check and before the model
// is invoked: an out-of-credits user gets a 402 and generateText never runs.
// ============================================================================

vi.mock('@/lib/auth', () => ({
  authenticateRequestWithOptions: vi.fn(),
  isAuthError: vi.fn((r: unknown) => r != null && typeof r === 'object' && 'error' in r),
  checkMCPPageScope: vi.fn().mockResolvedValue(null),
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

const agentPage = { id: 'agent-1', type: 'AI_CHAT', title: 'Helper', driveId: 'drive-1', aiProvider: 'openai', aiModel: 'openai/gpt-5.3-chat', systemPrompt: 'You help.', enabledTools: [] };

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
vi.mock('@pagespace/db/operators', () => ({ eq: vi.fn() }));
vi.mock('@pagespace/db/schema/core', () => ({ pages: { id: 'id' }, drives: { id: 'id' }, chatMessages: { pageId: 'pageId', createdAt: 'createdAt' } }));
vi.mock('@pagespace/db/schema/auth', () => ({ users: { id: 'id', subscriptionTier: 'subscriptionTier' } }));

// The credit gate under test. Default: allowed. Individual tests override.
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
vi.mock('@/lib/ai/core/ai-tools', () => ({
  pageSpaceTools: {},
}));
vi.mock('@/lib/ai/core/timestamp-utils', () => ({
  buildTimestampSystemPrompt: vi.fn().mockReturnValue(''),
}));
vi.mock('@/lib/ai/core/personalization-utils', () => ({
  getUserTimezone: vi.fn().mockResolvedValue('UTC'),
}));
vi.mock('@/lib/ai/core/ai-providers-config', () => ({
  DEFAULT_PROVIDER: 'openai',
  DEFAULT_MODEL: 'openai/gpt-5.3-chat',
}));

vi.mock('@/lib/ai/core/tool-utils', () => ({ mergeToolSets: vi.fn((a: Record<string, unknown>, b: Record<string, unknown>) => ({ ...a, ...b })) }));
vi.mock('@/lib/ai/tools/finish-tool', () => ({ finishTool: {}, FINISH_TOOL_NAME: 'finish' }));

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
import { canConsumeAI } from '@pagespace/lib/billing/credit-gate';
import { createAIProvider } from '@/lib/ai/core/provider-factory';
import { generateText } from 'ai';

const mockAuth = (): SessionAuthResult => ({
  userId: 'user-1',
  tokenVersion: 0,
  tokenType: 'session',
  sessionId: 'sess-1',
  role: 'user',
  adminRoleVersion: 0,
});

const makeRequest = () =>
  new Request('https://example.com/api/ai/page-agents/consult', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ agentId: 'agent-1', question: 'What is up?' }),
  });

describe('POST /api/ai/page-agents/consult — prepaid credit gate', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(authenticateRequestWithOptions).mockResolvedValue(mockAuth());
    vi.mocked(canConsumeAI).mockResolvedValue({ allowed: true, reason: 'unlimited' });
  });

  it('returns 402 out_of_credits and never configures a provider or invokes the model', async () => {
    vi.mocked(canConsumeAI).mockResolvedValue({ allowed: false, reason: 'out_of_credits' });

    const response = await POST(makeRequest());

    expect(response.status).toBe(402);
    const body = await response.json();
    expect(body.error).toBe('out_of_credits');
    expect(createAIProvider).not.toHaveBeenCalled();
    expect(generateText).not.toHaveBeenCalled();
  });

  it('does not block with a 402 when the gate allows', async () => {
    vi.mocked(canConsumeAI).mockResolvedValue({ allowed: true, reason: 'ok' });

    const response = await POST(makeRequest());

    expect(canConsumeAI).toHaveBeenCalled();
    expect(response.status).not.toBe(402);
  });
});
