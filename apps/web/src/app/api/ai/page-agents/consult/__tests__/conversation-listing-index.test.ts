import { describe, it, expect, beforeEach, vi } from 'vitest';
// ============================================================================
// #1837 finding #1 (hard failure) — consult-created conversations invisible
// to GET .../conversations.
//
// The route persists turns via saveMessageToDatabase (chat_messages rows) but
// never wrote a `conversations` row. list_conversations' listing query
// (conversation-repository.ts:listConversations) LEFT JOINs against
// `conversations` and filters on `conv."userId" = ${userId} OR conv."isShared"`.
// With no matching row, that predicate is NULL (never true), so the
// conversation silently drops out of every listing even though
// read_conversation (which queries chat_messages directly) renders it fine.
// Fix: eagerly create the conversations row, mirroring
// apps/web/src/app/api/ai/chat/route.ts's existing pattern.
// ============================================================================

vi.mock('@/lib/auth/request-auth', () => ({
  authenticateRequestWithOptions: vi.fn(),
  checkMCPPageScope: vi.fn().mockResolvedValue(null),
}));
vi.mock('@/lib/auth/auth-core', () => ({
  isAuthError: vi.fn((r: unknown) => r != null && typeof r === 'object' && 'error' in r),
  isMCPAuthResult: vi.fn(() => false),
  getAllowedDriveIds: vi.fn(() => []),
}));
vi.mock('@/lib/auth/principal-permissions', () => ({
  isScopedMCPAuth: vi.fn(() => false),
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
    const builder = {
      from: vi.fn((t: { __table?: string }) => {
        table = t;
        return builder;
      }),
      where: vi.fn(() => builder),
      orderBy: vi.fn(() => builder),
      limit: vi.fn(() => builder),
      then: (resolve: (v: unknown[]) => unknown, reject?: (e: unknown) => unknown) => {
        try {
          if (table?.__table === 'pages') return resolve([AGENT_ROW]);
          if (table?.__table === 'users') return resolve([GATE_USER_ROW]);
          if (table?.__table === 'drives') return resolve([DRIVE_ROW]);
          if (table?.__table === 'chatMessages') return resolve([]);
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

const createConversation = vi.fn().mockResolvedValue(undefined);
vi.mock('@/lib/repositories/conversation-repository', () => ({
  conversationRepository: {
    createConversation: (...args: unknown[]) => createConversation(...args),
  },
}));

vi.mock('ai', () => ({
  generateText: vi.fn().mockResolvedValue({
    text: 'answer',
    steps: [{ text: 'answer', content: [] }],
    totalUsage: { inputTokens: 5, outputTokens: 3, totalTokens: 8 },
  }),
  convertToModelMessages: vi.fn().mockImplementation((msgs: unknown) => msgs),
  stepCountIs: vi.fn(),
  hasToolCall: vi.fn(() => () => false),
}));

import { POST } from '../route';
import type { SessionAuthResult } from '@/lib/auth/auth-types';
import { authenticateRequestWithOptions } from '@/lib/auth/request-auth';

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

describe('POST /api/ai/page-agents/consult — conversation listing index', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(authenticateRequestWithOptions).mockResolvedValue(mockAuth());
  });

  it('creates a conversations row so the conversation is listable', async () => {
    const response = await POST(makeRequest({ agentId: 'agent-1', question: 'New question' }));
    expect(response.status).toBe(200);
    const body = await response.json();

    expect(createConversation).toHaveBeenCalledWith(body.conversationId, 'user-1', 'agent-1');
  });

  it('creates the row for a continued conversation too (idempotent upsert)', async () => {
    const response = await POST(makeRequest({ agentId: 'agent-1', question: 'Follow-up', conversationId: 'conv-a' }));
    expect(response.status).toBe(200);

    expect(createConversation).toHaveBeenCalledWith('conv-a', 'user-1', 'agent-1');
  });

  // The ownership-conflict guard (a supplied conversationId must not let a
  // different caller claim someone else's conversation — Codex P2 on #1846)
  // now lives inside conversationRepository.createConversation itself, so
  // every caller gets it "for free" without a call-site check. That
  // behavior is unit-tested directly against the repository in
  // apps/web/src/lib/repositories/__tests__/conversation-repository.test.ts;
  // this route always calls createConversation unconditionally (mocked
  // above), so there's nothing conflict-specific to assert here.
});
