import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { SessionAuthResult } from '@/lib/auth';

// ============================================================================
// Step-cap drift for POST /api/ai/page-agents/consult (#1769)
//
// The consult route enables tools including ask_agent (via pageSpaceTools),
// so a single external/MCP-triggered consult call could run up to 100 tool
// steps. The internal ask_agent tool — the reference implementation the SDK
// targets — caps sub-agent runs at 20 steps (agent-communication-tools.ts).
// Fix: align the consult route's tool-enabled stopWhen budget to 20.
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

// enabledTools includes ask_agent so the route takes the tool-enabled
// generateText branch (the one whose stopWhen budget is under test).
const AGENT_ROW = {
  __table: 'pages',
  id: 'agent-1',
  type: 'AI_CHAT',
  title: 'Helper',
  driveId: 'drive-1',
  aiProvider: 'openai',
  aiModel: 'openai/gpt-5.4-nano',
  systemPrompt: 'You help.',
  enabledTools: ['ask_agent'],
};
const GATE_USER_ROW = { subscriptionTier: 'pro', role: 'user' };
const DRIVE_ROW = { id: 'drive-1', name: 'Drive', slug: 'drive' };

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
      orderBy: vi.fn(() => builder),
      limit: vi.fn(() => builder),
      then: (resolve: (v: unknown[]) => unknown) => {
        if (table?.__table === 'pages') return resolve([AGENT_ROW]);
        if (table?.__table === 'users') return resolve([GATE_USER_ROW]);
        if (table?.__table === 'drives') return resolve([DRIVE_ROW]);
        return resolve([]);
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
vi.mock('@/lib/ai/core/ai-tools', () => ({
  pageSpaceTools: { ask_agent: { description: 'ask_agent' } },
}));
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
    // These suites assert other things, so an empty history is the honest
    // stand-in for the two readers the cutover introduced.
    getPageConversationMessages: vi.fn().mockResolvedValue([]),
  },
}));

const stepCountIs = vi.fn().mockImplementation((n: number) => ({ __stepCountIs: n }));

vi.mock('ai', () => ({
  generateText: vi.fn().mockResolvedValue({
    text: 'answer',
    steps: [{ text: 'answer', content: [] }],
    totalUsage: { inputTokens: 5, outputTokens: 3, totalTokens: 8 },
  }),
  convertToModelMessages: vi.fn().mockReturnValue([]),
  stepCountIs: (...args: [number]) => stepCountIs(...args),
  hasToolCall: vi.fn(() => () => false),
}));

import { generateText } from 'ai';
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

describe('POST /api/ai/page-agents/consult — step-cap parity with internal ask_agent', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(authenticateRequestWithOptions).mockResolvedValue(mockAuth());
    stepCountIs.mockClear();
  });

  it('caps the tool-enabled run at 20 steps, matching internal ask_agent — not 100', async () => {
    const response = await POST(makeRequest());
    expect(response.status).toBe(200);

    expect(generateText).toHaveBeenCalledTimes(1);
    const callArgs = vi.mocked(generateText).mock.calls[0][0] as { stopWhen: unknown[] };

    const stepCap = (callArgs.stopWhen as Array<{ __stepCountIs?: number }>).find(s => s?.__stepCountIs !== undefined);
    expect(stepCap?.__stepCountIs).toBe(20);
  });
});
