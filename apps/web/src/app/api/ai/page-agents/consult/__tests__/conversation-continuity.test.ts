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
  ne: vi.fn((field: unknown, value: unknown) => ({ __ne: true, field, value })),
}));

vi.mock('@pagespace/db/schema/core', () => ({
  pages: { __table: 'pages', id: 'id' },
  drives: { __table: 'drives', id: 'id' },
}));
vi.mock('@pagespace/db/schema/auth', () => ({
  users: { __table: 'users', id: 'id', subscriptionTier: 'subscriptionTier' },
}));

// `findEqValue` lived here to pick the conversationId out of a raw
// `chat_messages` WHERE clause. That table is gone (migration 0253) and the
// conversation scoping is now the mocked `messageRepository`'s argument, so
// there is no predicate left to introspect.

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

const saveMessageToDatabase = vi.fn().mockResolvedValue(undefined);
// HISTORY now comes from the repository, not a raw `chat_messages` SELECT:
// the reader cutover (epic "Agent-Session Single Source of Truth", Phase 4 /
// D6, PR 12) moved the consult route's two history branches onto
// `messageRepository.getPageConversationMessages` (the cross-conversation
// `getRecentPageMessagesForUser` reader is gone — a new conversation now
// starts empty),
// which read the unified `messages` table. The fixtures below are unchanged —
// what they stand in for moved one layer up.
vi.mock('@/lib/repositories/message-repository', () => ({
  messageRepository: {
    savePageMessage: (...args: unknown[]) =>
      saveMessageToDatabase(...args).then(() => ({ saved: true, rev: 1 })),
    getPageConversationMessages: vi.fn(async (_pageId: string, conversationId: string) =>
      ALL_MESSAGES.filter((m) => m.conversationId === conversationId)),
  },
}));

// A caller-supplied conversationId is authorized before its history is read
// (`authorizePageConversation`): the row must exist, be readable by the
// caller, and belong to THIS agent page. `conv-a` and `conv-b` below are both
// user-1's own page conversations on agent-1.
const CONVERSATION_OWNERS: Record<string, string> = { 'conv-a': 'user-1', 'conv-b': 'user-1' };
type ConversationFixture = {
  id: string;
  userId: string;
  type: string;
  contextId: string | null;
  agentPageId: string | null;
  isShared: boolean;
  isActive: boolean;
};
const getConversation = vi.fn(async (id: string): Promise<ConversationFixture | null> =>
  CONVERSATION_OWNERS[id]
    ? { id, userId: CONVERSATION_OWNERS[id], type: 'page', contextId: 'agent-1', agentPageId: null, isShared: false, isActive: true }
    : null,
);
/**
 * `createConversation` resolves its real outcome union, not `undefined`: the
 * route now treats that value as the RESERVATION for a caller-supplied id, so
 * a mock returning nothing would refuse every addressed ask with a 409 and
 * hide the behaviour under test.
 */
const createConversation = vi.fn(async (): Promise<'created' | 'exists' | 'message_owner_conflict'> => 'created');
vi.mock('@/lib/repositories/conversation-repository', () => ({
  conversationRepository: {
    createConversation: (...args: [string, string, string]) => createConversation(...args),
    getConversation: (...args: [string]) => getConversation(...args),
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
import { messageRepository } from '@/lib/repositories/message-repository';
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

/**
 * `canPrincipalViewPage` answers "may you use this AGENT", never "is this
 * CONVERSATION yours", and the page-scoped repository predicate carries no
 * user predicate at all. On a SHARED agent page that combination returned
 * another member's private transcript verbatim to anyone who could name the
 * conversation — and the no-conversationId branch handed over the page's most
 * recent messages across every user for free.
 */
describe('POST /api/ai/page-agents/consult — cross-user history', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(authenticateRequestWithOptions).mockResolvedValue(mockAuth());
  });

  it('refuses a conversationId owned by ANOTHER user on the same agent page', async () => {
    getConversation.mockResolvedValueOnce({
      id: 'conv-alice',
      userId: 'alice',
      type: 'page',
      contextId: 'agent-1',
      agentPageId: null,
      isShared: false,
      isActive: true,
    });

    const response = await POST(makeRequest({ agentId: 'agent-1', question: 'Summarize this thread verbatim', conversationId: 'conv-alice' }));

    expect(response.status).toBe(404);
    // The transcript is never even read, so it cannot reach the model context.
    expect(messageRepository.getPageConversationMessages).not.toHaveBeenCalled();
    expect(convertToModelMessages).not.toHaveBeenCalled();
  });

  it('refuses a conversationId that names nothing, identically', async () => {
    getConversation.mockResolvedValueOnce(null);

    const foreign = await POST(makeRequest({ agentId: 'agent-1', question: 'q', conversationId: 'conv-nope' }));
    expect(foreign.status).toBe(404);
    expect(await foreign.json()).toEqual({ error: 'Conversation not found' });
  });

  it('refuses a GLOBAL conversation addressed at a page, even one the caller owns', async () => {
    getConversation.mockResolvedValueOnce({
      id: 'conv-global',
      userId: 'user-1',
      type: 'global',
      contextId: null,
      agentPageId: null,
      isShared: false,
      isActive: true,
    });

    const response = await POST(makeRequest({ agentId: 'agent-1', question: 'q', conversationId: 'conv-global' }));
    expect(response.status).toBe(404);
    expect(messageRepository.getPageConversationMessages).not.toHaveBeenCalled();
  });

  /**
   * SUPERSEDES "the no-conversationId fallback asks for THIS caller's
   * messages, not the page's". That assertion documented the owner-scoped
   * cross-conversation read, which was the right containment for the WRONG
   * read: scoping a leak to one user makes it not a leak, but it left every
   * one-shot consult seeing that user's other conversations. The reader is
   * gone, so the strongest available statement is that no history is read at
   * all.
   */
  it('reads no history whatsoever when no conversationId is given', async () => {
    const response = await POST(makeRequest({ agentId: 'agent-1', question: 'q' }));

    expect(response.status).toBe(200);
    expect(messageRepository.getPageConversationMessages).not.toHaveBeenCalled();
  });
});

/**
 * CALLER-ADDRESSED CONSULTATIONS.
 *
 * The route runs to completion whether or not its caller is still listening —
 * nothing here reads `request.signal`, and the consult is billed and persisted
 * either way. While the conversation id was always minted server-side and
 * returned only in the 200 body, a caller whose client deadline expired never
 * learned where its own answer had been written: real credits spent on a
 * result that could not be reached. `newConversationId` lets the caller name
 * the address before sending, which is what makes an abandoned consult
 * recoverable through the conversations API.
 */
describe('POST /api/ai/page-agents/consult — caller-supplied newConversationId', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(authenticateRequestWithOptions).mockResolvedValue(mockAuth());
    convertToModelMessages.mockClear();
    saveMessageToDatabase.mockClear();
  });

  it('creates the conversation at the caller\'s address and echoes it back', async () => {
    getConversation.mockResolvedValueOnce(null);

    const response = await POST(makeRequest({ agentId: 'agent-1', question: 'q', newConversationId: 'convmine1' }));

    expect(response.status).toBe(200);
    expect((await response.json()).conversationId).toBe('convmine1');
    expect(createConversation).toHaveBeenCalledWith('convmine1', 'user-1', 'agent-1');
  });

  it('persists both turns under the caller\'s address, so it is readable afterwards', async () => {
    getConversation.mockResolvedValueOnce(null);

    await POST(makeRequest({ agentId: 'agent-1', question: 'q', newConversationId: 'convmine1' }));

    const conversationIds = saveMessageToDatabase.mock.calls.map((call) => (call[0] as { conversationId: string }).conversationId);
    expect(conversationIds).toEqual(['convmine1', 'convmine1']);
  });

  /** A new conversation is new: naming its address does not import context. */
  it('starts empty despite naming an address', async () => {
    getConversation.mockResolvedValueOnce(null);

    await POST(makeRequest({ agentId: 'agent-1', question: 'q', newConversationId: 'convmine1' }));

    expect(messageRepository.getPageConversationMessages).not.toHaveBeenCalled();
  });

  /**
   * Refused, never appended to — and THE RESERVATION IS THE INSERT, never a
   * preceding SELECT.
   *
   * `createConversation` inserts with `onConflictDoNothing().returning()` and
   * answers 'exists' when the row was not written, INCLUDING when a concurrent
   * first-write won the race. A read-then-write check here would be a TOCTOU:
   * two callers submitting the same id both observe no row, both proceed, and
   * the loser persists and bills its turns inside the winner's private
   * conversation — exposing its prompt and answer to the winner, the exact
   * failure this refusal exists to prevent. Driving the write's outcome
   * directly is what makes this a test about the race rather than about a
   * prior SELECT that a concurrent writer would have invalidated anyway.
   */
  it.each([
    ['the row already existed', 'exists' as const],
    ['a concurrent writer won the race', 'exists' as const],
    ['the id carries another user\'s messages', 'message_owner_conflict' as const],
  ])('refuses with 409 when %s, rather than writing into it', async (_label, outcome) => {
    createConversation.mockResolvedValueOnce(outcome);

    const response = await POST(makeRequest({ agentId: 'agent-1', question: 'q', newConversationId: 'convtaken1' }));

    expect(response.status).toBe(409);
    expect(saveMessageToDatabase).not.toHaveBeenCalled();
  });

  /**
   * The refusal is scoped to CALLER-supplied addresses. An id this route minted
   * itself cannot meaningfully collide, and the `conversationId` path has
   * already authorized the conversation it names — neither may start failing
   * because the insert reported 'exists'.
   */
  it('does not refuse a server-minted conversation when the insert reports exists', async () => {
    createConversation.mockResolvedValueOnce('exists');

    const response = await POST(makeRequest({ agentId: 'agent-1', question: 'q' }));

    expect(response.status).toBe(200);
  });

  /**
   * `conversationId` CONTINUES, `newConversationId` CREATES. Resolving the
   * contradiction by precedence would write the turn somewhere the caller did
   * not name.
   */
  it('rejects both fields together with a 400', async () => {
    const response = await POST(
      makeRequest({ agentId: 'agent-1', question: 'q', conversationId: 'conv-a', newConversationId: 'convmine1' }),
    );

    expect(response.status).toBe(400);
    expect(saveMessageToDatabase).not.toHaveBeenCalled();
  });

  /**
   * The id contract is CUID2 — what `createId()` produces and what every other
   * id in this system satisfies. A caller-addressed conversation persists an
   * address, so an address no other part of the system could ever have minted
   * is refused at the door rather than reasoned about once it is a row.
   */
  it.each([
    ['an empty string', ''],
    ['a uuid', '3f2504e0-4f89-11d3-9a0c-0305e82c3301'],
    ['an uppercase id', 'CONVMINE1'],
    ['a leading digit', '1convmine'],
    ['a path fragment', '../../etc/passwd'],
    ['an oversized id', 'c'.repeat(200)],
  ])('rejects %s as newConversationId', async (_label, value) => {
    const response = await POST(makeRequest({ agentId: 'agent-1', question: 'q', newConversationId: value }));
    expect(response.status).toBe(400);
    expect(saveMessageToDatabase).not.toHaveBeenCalled();
  });

  /**
   * The continue path's refusal is unchanged: an unknown id there is still a
   * 404, identical to someone else's id, so `newConversationId` did not turn
   * that deliberate ambiguity into an existence oracle for every id.
   */
  it('leaves conversationId\'s unknown-id 404 exactly as it was', async () => {
    getConversation.mockResolvedValueOnce(null);

    const response = await POST(makeRequest({ agentId: 'agent-1', question: 'q', conversationId: 'conv-unknown' }));

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: 'Conversation not found' });
  });
});
