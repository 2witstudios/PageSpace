import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { SessionAuthResult } from '@/lib/auth';

// ============================================================================
// Ephemeral vs internal ask_agent for POST /api/ai/page-agents/consult (#1769)
//
// Today the route persists nothing and never returns/accepts a conversationId,
// unlike the internal ask_agent tool which supports continuing a conversation.
// Fix: the route must persist the question + answer and return a
// conversationId; passing that conversationId back in must continue the SAME
// conversation (scoped history), not the page-wide "recent" fallback.
// ============================================================================

vi.mock('@/lib/auth', () => ({
  authenticateRequestWithOptions: vi.fn(),
  isAuthError: vi.fn((r: unknown) => r != null && typeof r === 'object' && 'error' in r),
  isMCPAuthResult: vi.fn(() => false),
  checkMCPPageScope: vi.fn().mockResolvedValue(null),
  getAllowedDriveIds: vi.fn(() => []),
  canPrincipalViewPage: vi.fn().mockResolvedValue(true),
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

const AGENT_ROW = {
  __table: 'pages',
  id: 'agent-1',
  type: 'AI_CHAT',
  title: 'Helper',
  driveId: 'drive-1',
  aiProvider: 'openai',
  aiModel: 'openai/gpt-5.3-chat',
  systemPrompt: 'You help.',
  enabledTools: [],
};
const GATE_USER_ROW = { subscriptionTier: 'pro', role: 'user' };
const DRIVE_ROW = { id: 'drive-1', name: 'Drive', slug: 'drive' };

// Two distinct conversations already stored for this agent, so a page-wide
// (unscoped) query would incorrectly blend them together.
const CONVERSATION_A_MESSAGES = [
  { id: 'a-1', role: 'user' as const, content: 'conv-a question 1', createdAt: new Date(2024, 0, 1), conversationId: 'conv-a', isActive: true },
  { id: 'a-2', role: 'assistant' as const, content: 'conv-a answer 1', createdAt: new Date(2024, 0, 2), conversationId: 'conv-a', isActive: true },
];
const CONVERSATION_B_MESSAGES = [
  { id: 'b-1', role: 'user' as const, content: 'conv-b question 1', createdAt: new Date(2024, 0, 3), conversationId: 'conv-b', isActive: true },
  { id: 'b-2', role: 'assistant' as const, content: 'conv-b answer 1', createdAt: new Date(2024, 0, 4), conversationId: 'conv-b', isActive: true },
];
const ALL_MESSAGES = [...CONVERSATION_A_MESSAGES, ...CONVERSATION_B_MESSAGES];

vi.mock('@pagespace/db/operators', () => ({
  eq: vi.fn((field: unknown, value: unknown) => ({ __eq: true, field, value })),
  desc: vi.fn((field: unknown) => ({ __desc: true, field })),
  and: vi.fn((...conds: unknown[]) => ({ __and: true, conds })),
}));

vi.mock('@pagespace/db/schema/core', () => ({
  pages: { __table: 'pages', id: 'id' },
  drives: { __table: 'drives', id: 'id' },
  chatMessages: {
    __table: 'chatMessages',
    pageId: 'pageId',
    createdAt: 'createdAt',
    conversationId: 'conversationId',
    isActive: 'isActive',
  },
}));
vi.mock('@pagespace/db/schema/auth', () => ({
  users: { __table: 'users', id: 'id', subscriptionTier: 'subscriptionTier' },
}));

function findEqValue(conds: unknown[], fieldName: string): unknown {
  for (const c of conds) {
    const cond = c as { __eq?: boolean; field?: unknown; value?: unknown; __and?: boolean; conds?: unknown[] };
    if (cond?.__eq && cond.field === fieldName) return cond.value;
    if (cond?.__and && Array.isArray(cond.conds)) {
      const nested = findEqValue(cond.conds, fieldName);
      if (nested !== undefined) return nested;
    }
  }
  return undefined;
}

vi.mock('@pagespace/db/db', () => {
  function makeBuilder() {
    let table: { __table?: string } | undefined;
    const whereArgs: unknown[] = [];
    const builder = {
      from: vi.fn((t: { __table?: string }) => {
        table = t;
        return builder;
      }),
      where: vi.fn((arg: unknown) => {
        whereArgs.push(arg);
        return builder;
      }),
      orderBy: vi.fn(() => builder),
      limit: vi.fn(() => builder),
      then: (resolve: (v: unknown[]) => unknown, reject?: (e: unknown) => unknown) => {
        try {
          if (table?.__table === 'pages') return resolve([AGENT_ROW]);
          if (table?.__table === 'users') return resolve([GATE_USER_ROW]);
          if (table?.__table === 'drives') return resolve([DRIVE_ROW]);
          if (table?.__table === 'chatMessages') {
            const requestedConversationId = findEqValue(whereArgs, 'conversationId');
            if (requestedConversationId !== undefined) {
              return resolve(ALL_MESSAGES.filter(m => m.conversationId === requestedConversationId));
            }
            // No conversationId filter present: page-wide fallback (used when
            // the caller doesn't pass conversationId at all).
            return resolve(ALL_MESSAGES);
          }
          return resolve([]);
        } catch (e) {
          return reject?.(e);
        }
      },
    };
    return builder;
  }
  return { db: { select: vi.fn(() => makeBuilder()) } };
});

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
vi.mock('@/lib/ai/core/ai-tools', () => ({ pageSpaceTools: {} }));
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

const saveMessageToDatabase = vi.fn().mockResolvedValue(undefined);
vi.mock('@/lib/ai/core/message-utils', () => ({
  saveMessageToDatabase: (...args: unknown[]) => saveMessageToDatabase(...args),
}));

const convertToModelMessages = vi.fn().mockImplementation((msgs: unknown) => msgs);

vi.mock('ai', () => ({
  generateText: vi.fn().mockResolvedValue({
    text: 'answer',
    steps: [{ text: 'answer', content: [] }],
    totalUsage: { inputTokens: 5, outputTokens: 3, totalTokens: 8 },
  }),
  convertToModelMessages: (...args: unknown[]) => convertToModelMessages(...args),
  stepCountIs: vi.fn(),
  hasToolCall: vi.fn(() => () => false),
}));

import { POST } from '../route';
import { authenticateRequestWithOptions } from '@/lib/auth';

const mockAuth = (): SessionAuthResult => ({
  userId: 'user-1',
  tokenVersion: 0,
  tokenType: 'session',
  sessionId: 'sess-1',
  role: 'user',
  adminRoleVersion: 0,
});

const makeRequest = (body: Record<string, unknown>) =>
  new Request('https://example.com/api/ai/page-agents/consult', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

describe('POST /api/ai/page-agents/consult — conversation continuity', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(authenticateRequestWithOptions).mockResolvedValue(mockAuth());
    convertToModelMessages.mockClear();
    saveMessageToDatabase.mockClear();
  });

  it('returns a conversationId when none was provided, and persists both turns', async () => {
    const response = await POST(makeRequest({ agentId: 'agent-1', question: 'New question' }));
    expect(response.status).toBe(200);
    const body = await response.json();

    expect(typeof body.conversationId).toBe('string');
    expect(body.conversationId.length).toBeGreaterThan(0);

    // Persists the user's question and the assistant's answer.
    expect(saveMessageToDatabase).toHaveBeenCalledWith(
      expect.objectContaining({ role: 'user', content: 'New question', conversationId: body.conversationId }),
    );
    expect(saveMessageToDatabase).toHaveBeenCalledWith(
      expect.objectContaining({ role: 'assistant', content: 'answer', conversationId: body.conversationId }),
    );
  });

  it('scopes history to the given conversationId instead of blending all page history', async () => {
    const response = await POST(makeRequest({ agentId: 'agent-1', question: 'Follow-up', conversationId: 'conv-a' }));
    expect(response.status).toBe(200);
    const body = await response.json();

    // Continuing conv-a must echo the SAME conversationId back.
    expect(body.conversationId).toBe('conv-a');

    expect(convertToModelMessages).toHaveBeenCalledTimes(1);
    const modelMessages = convertToModelMessages.mock.calls[0][0] as Array<{ content: string }>;
    const historyContents = modelMessages.slice(0, -1).map(m => m.content);

    // Only conv-a's two messages — conv-b content must NOT leak in.
    expect(historyContents).toEqual(['conv-a question 1', 'conv-a answer 1']);
    expect(historyContents.some(c => c.startsWith('conv-b'))).toBe(false);
  });
});
