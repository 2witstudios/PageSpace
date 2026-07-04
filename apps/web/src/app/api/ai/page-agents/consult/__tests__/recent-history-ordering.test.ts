import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { SessionAuthResult } from '@/lib/auth';

// ============================================================================
// "Recent history" for POST /api/ai/page-agents/consult (#1769)
//
// The route's no-conversationId fallback loads context from the agent's most
// recent chat_messages rows. `orderBy(chatMessages.createdAt).limit(10)` sorts
// ASCENDING then takes the first 10 — the agent's FIRST 10 messages EVER, not
// the most recent. Fix: order DESC + limit, then reverse back to chronological
// order before handing the history to the model.
// ============================================================================

vi.mock('@/lib/auth', () => ({
  authenticateRequestWithOptions: vi.fn(),
  isAuthError: vi.fn((r: unknown) => r != null && typeof r === 'object' && 'error' in r),
  isMCPAuthResult: vi.fn(() => false),
  isScopedMCPAuth: vi.fn(() => false),
  checkMCPPageScope: vi.fn().mockResolvedValue(null),
  getAllowedDriveIds: vi.fn(() => []),
  canPrincipalViewPage: vi.fn().mockResolvedValue(true),
  isScopedMCPAuth: vi.fn(() => false),
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

// 15 messages, oldest (msg-1) to newest (msg-15).
const ALL_MESSAGES = Array.from({ length: 15 }, (_, i) => ({
  id: `msg-${i + 1}`,
  role: (i % 2 === 0 ? 'user' : 'assistant') as 'user' | 'assistant',
  content: `content-${i + 1}`,
  createdAt: new Date(2024, 0, i + 1),
}));

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

vi.mock('@pagespace/db/db', () => {
  function makeBuilder() {
    let table: { __table?: string } | undefined;
    let orderDesc = false;
    let limitN: number | undefined;
    const builder = {
      from: vi.fn((t: { __table?: string }) => {
        table = t;
        return builder;
      }),
      where: vi.fn(() => builder),
      orderBy: vi.fn((arg: { __desc?: boolean }) => {
        orderDesc = !!arg?.__desc;
        return builder;
      }),
      limit: vi.fn((n: number) => {
        limitN = n;
        return builder;
      }),
      then: (resolve: (v: unknown[]) => unknown, reject?: (e: unknown) => unknown) => {
        try {
          if (table?.__table === 'pages') return resolve([AGENT_ROW]);
          if (table?.__table === 'users') return resolve([GATE_USER_ROW]);
          if (table?.__table === 'drives') return resolve([DRIVE_ROW]);
          if (table?.__table === 'chatMessages') {
            let rows = [...ALL_MESSAGES];
            if (orderDesc) rows = rows.slice().reverse();
            if (limitN !== undefined) rows = rows.slice(0, limitN);
            return resolve(rows);
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
vi.mock('@/lib/ai/core/message-utils', () => ({
  saveMessageToDatabase: vi.fn().mockResolvedValue(undefined),
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

const makeRequest = () =>
  new Request('https://example.com/api/ai/page-agents/consult', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ agentId: 'agent-1', question: 'What is up?' }),
  });

describe('POST /api/ai/page-agents/consult — recent history ordering', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(authenticateRequestWithOptions).mockResolvedValue(mockAuth());
    convertToModelMessages.mockClear();
  });

  it('uses the MOST RECENT 10 messages, in chronological order — not the first 10', async () => {
    const response = await POST(makeRequest());
    expect(response.status).toBe(200);

    expect(convertToModelMessages).toHaveBeenCalledTimes(1);
    const modelMessages = convertToModelMessages.mock.calls[0][0] as Array<{ content: string }>;

    // Last entry is always the new consultation question, not history.
    const historyContents = modelMessages.slice(0, -1).map(m => m.content);

    // Most recent 10 of 15 messages (msg-6..msg-15), oldest-first within that window.
    expect(historyContents).toEqual([
      'content-6', 'content-7', 'content-8', 'content-9', 'content-10',
      'content-11', 'content-12', 'content-13', 'content-14', 'content-15',
    ]);
  });
});
