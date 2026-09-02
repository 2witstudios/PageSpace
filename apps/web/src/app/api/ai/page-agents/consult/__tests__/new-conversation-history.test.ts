import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { SessionAuthResult } from '@/lib/auth';

// ============================================================================
// New-conversation history for POST /api/ai/page-agents/consult
//
// SUPERSEDES the "recent history ordering" behaviour this file used to assert
// (#1769). That fix was correct about ordering and wrong about scope: the
// no-conversationId path wrote to a BRAND-NEW conversation while reading the
// caller's 10 most recent messages across ALL their conversations on the
// agent. Writes were conversation-scoped, reads were page-scoped, so
// consecutive one-shot consults silently saw each other — an agent would
// recognise a question it had never been asked in that conversation — and it
// diverged from the internal `ask_agent` tool, which loads history only when
// given a conversationId. The ordering question is now moot: there is no
// window to order, because a new conversation starts empty.
//
// The fixture below deliberately leaves 15 messages in the database. A test
// that proved emptiness against an empty database would pass just as happily
// if the route resumed reading across conversations tomorrow.
// ============================================================================

vi.mock('@/lib/auth', () => ({
  authenticateRequestWithOptions: vi.fn(),
  isAuthError: vi.fn((r: unknown) => r != null && typeof r === 'object' && 'error' in r),
  isMCPAuthResult: vi.fn(() => false),
  isScopedMCPAuth: vi.fn(() => false),
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
  aiModel: 'openai/gpt-5.4-nano',
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
  ne: vi.fn((field: unknown, value: unknown) => ({ __ne: true, field, value })),
}));

vi.mock('@pagespace/db/schema/core', () => ({
  pages: { __table: 'pages', id: 'id' },
  drives: { __table: 'drives', id: 'id' },
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
      // Ordering and limiting are no longer observed here: history comes from
      // the mocked `messageRepository`, which is where the DESC-then-reverse
      // contract now lives and is asserted. These stay only to keep the
      // builder chainable for the remaining lookups (pages/users/drives).
      orderBy: vi.fn(() => builder),
      limit: vi.fn(() => builder),
      then: (resolve: (v: unknown[]) => unknown, reject?: (e: unknown) => unknown) => {
        try {
          if (table?.__table === 'pages') return resolve([AGENT_ROW]);
          if (table?.__table === 'users') return resolve([GATE_USER_ROW]);
          if (table?.__table === 'drives') return resolve([DRIVE_ROW]);
          // The `chatMessages` branch that used to live here is gone: that
          // table was DROPPED by migration 0253, and history now comes from
          // the mocked `messageRepository` above, so nothing could reach it.
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
  // A pure-telemetry call site: the route hands the tracking promise to a NAMED
  // discard rather than leaving it to float, so the mocked module must provide it.
  discardUsageOutcome: (tracking: Promise<unknown>) => {
    void Promise.resolve(tracking).then(
      () => undefined,
      () => undefined,
    );
  },
}));

vi.mock('@/lib/ai/core/provider-factory', () => ({
  createAIProvider: vi.fn().mockResolvedValue({ model: {}, provider: 'openai', modelName: 'openai/gpt-5.4-nano' }),
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
  DEFAULT_MODEL: 'openai/gpt-5.4-nano',
  ADMIN_ONLY_PROVIDERS: new Set<string>(['glm']),
  resolveProviderModel: vi.fn((sp: string, sm: string) => ({
    provider: sp && sm ? sp : 'openai',
    model: sm || 'openai/gpt-5.4-nano',
  })),
}));

vi.mock('@/lib/ai/core/tool-utils', () => ({ mergeToolSets: vi.fn((a: Record<string, unknown>, b: Record<string, unknown>) => ({ ...a, ...b })) }));
vi.mock('@/lib/ai/tools/finish-tool', () => ({ finishTool: {}, FINISH_TOOL_NAME: 'finish' }));
vi.mock('@/lib/ai/core/integration-tool-resolver', () => ({
  resolvePageAgentIntegrationTools: vi.fn().mockResolvedValue({}),
}));
// HISTORY now comes from the repository, not a raw `chat_messages` SELECT: the
// reader cutover (epic "Agent-Session Single Source of Truth", Phase 4 / D6,
// PR 12) moved the consult route's two history branches onto
// `messageRepository.getPageConversationMessages` (the cross-conversation
// `getRecentPageMessagesForUser` reader is gone — a new conversation now
// starts empty),
// which read the unified `messages` table.
/**
 * The route reserves the conversation by INSERTING it, and no longer swallows a
 * rejection from that write: a repository failure is a 500, not a 409 claiming
 * the id is taken. These specs previously loaded the real repository against a
 * mocked `db` and relied on the discarded `.catch()` to hide the resulting
 * failure — so they need the seam mocked explicitly now that failures are
 * honest. 'created' is the ordinary outcome for the ids they use.
 */
vi.mock('@/lib/repositories/conversation-repository', () => ({
  conversationRepository: {
    createConversation: vi.fn(async () => 'created' as const),
    getConversation: vi.fn(async () => null),
  },
}));

vi.mock('@/lib/repositories/message-repository', () => ({
  messageRepository: {
    savePageMessage: vi.fn().mockResolvedValue({ saved: true, rev: 1 }),
    // Returns the full 15-message fixture: if the route ever reads a
    // conversation it was not given, the emptiness assertions below fail on
    // content rather than passing against an empty stub.
    getPageConversationMessages: vi.fn(async () => ALL_MESSAGES),
  },
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
import { messageRepository } from '@/lib/repositories/message-repository';

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

describe('POST /api/ai/page-agents/consult — a new conversation starts empty', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(authenticateRequestWithOptions).mockResolvedValue(mockAuth());
    convertToModelMessages.mockClear();
  });

  it('sends the model the question ALONE — no messages from the caller\'s other conversations', async () => {
    const response = await POST(makeRequest());
    expect(response.status).toBe(200);

    expect(convertToModelMessages).toHaveBeenCalledTimes(1);
    const modelMessages = convertToModelMessages.mock.calls[0][0] as Array<{ content: string }>;

    // Asserted by VALUE, not just by length: 15 messages exist on this agent
    // for this caller, and none of their content may appear.
    expect(modelMessages.map(m => m.content)).toEqual(['What is up?']);
    for (const message of ALL_MESSAGES) {
      expect(JSON.stringify(modelMessages)).not.toContain(message.content);
    }
  });

  it('reads no conversation at all when none was named', async () => {
    const response = await POST(makeRequest());
    expect(response.status).toBe(200);
    expect(messageRepository.getPageConversationMessages).not.toHaveBeenCalled();
  });
});
