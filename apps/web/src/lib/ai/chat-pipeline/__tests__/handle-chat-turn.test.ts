import { describe, it, expect, beforeEach, vi } from 'vitest';

// ============================================================================
// The shared chat-pipeline entry — epic "Agent-Session Single Source of Truth",
// Phase 5 (chat route consolidation).
//
// One handler now stands behind BOTH public chat URLs and picks the page-agent
// or global-assistant strategy from the CONVERSATION rather than from the URL.
// This suite pins the decision itself — the two strategies are exercised in
// full by the existing route suites, which pass unchanged, so what is worth
// asserting here is only what is new:
//
//   * the global URL always runs the global strategy (unchanged);
//   * `/api/ai/chat` with a `chatId` always runs the page strategy, with NO
//     extra conversation read (unchanged);
//   * `/api/ai/chat` with no `chatId` but a conversation that resolves to a
//     global-assistant thread runs the GLOBAL strategy — the widening that lets
//     server dispatch stop branching on `agentPageId`;
//   * that widening is not a door for MCP tokens, which have never been able to
//     drive the global assistant;
//   * everything else with no `chatId` still falls through to the page
//     strategy's own "chatId is required" 400.
// ============================================================================

const runPageChatTurn = vi.fn(async (_ctx: unknown) => new Response('page', { status: 200 }));
const runGlobalChatTurn = vi.fn(async (_ctx: unknown) => new Response('global', { status: 200 }));
const getConversation = vi.fn(async (_id: string): Promise<unknown> => null);
const authenticateRequestWithOptions = vi.fn(async (_req: Request, _opts: unknown): Promise<unknown> => null);

vi.mock('../page-chat-turn', () => ({ runPageChatTurn: (ctx: unknown) => runPageChatTurn(ctx) }));
vi.mock('../global-chat-turn', () => ({ runGlobalChatTurn: (ctx: unknown) => runGlobalChatTurn(ctx) }));
vi.mock('@/lib/repositories/conversation-repository', () => ({
  conversationRepository: { getConversation: (id: string) => getConversation(id) },
}));
vi.mock('@/lib/auth', () => ({
  authenticateRequestWithOptions: (req: Request, opts: unknown) => authenticateRequestWithOptions(req, opts),
  isAuthError: (r: unknown) => !!r && typeof r === 'object' && 'error' in (r as object),
  isMCPAuthResult: (r: unknown) =>
    !!r && typeof r === 'object' && !('error' in (r as object)) &&
    (r as { tokenType?: string }).tokenType === 'mcp',
}));
vi.mock('@pagespace/lib/audit/audit-log', () => ({ auditRequest: vi.fn() }));
vi.mock('@pagespace/lib/monitoring/ai-monitoring', () => ({
  AIMonitoring: { trackUsage: vi.fn().mockResolvedValue(undefined) },
}));
vi.mock('@pagespace/lib/logging/logger-config', () => {
  const silent = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), trace: vi.fn() };
  return { loggers: { ai: silent, api: silent } };
});

const SESSION_AUTH = { userId: 'user-1', role: 'user', tokenType: 'session' };
const MCP_AUTH = { userId: 'user-1', role: 'user', tokenType: 'mcp', tokenId: 't1', allowedDriveIds: [] };

function post(body: unknown, headers: Record<string, string> = {}): Request {
  return new Request('http://localhost/api/ai/chat', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-browser-session-id': 'browser-abc123', ...headers },
    body: JSON.stringify(body),
  });
}

async function handle(...args: Parameters<typeof import('../handle-chat-turn').handleChatTurn>) {
  const { handleChatTurn } = await import('../handle-chat-turn');
  return handleChatTurn(...args);
}

beforeEach(() => {
  vi.clearAllMocks();
  authenticateRequestWithOptions.mockResolvedValue(SESSION_AUTH);
  getConversation.mockResolvedValue(null);
});

describe('handleChatTurn — one entry, conversation-keyed strategy', () => {
  it('runs the global strategy for every turn on the global URL, and passes the [id] segment through', async () => {
    const res = await handle(post({ messages: [] }), {
      surface: 'global-messages',
      urlConversationId: 'conv-from-url',
    });

    expect(await res.text()).toBe('global');
    expect(runPageChatTurn).not.toHaveBeenCalled();
    expect(runGlobalChatTurn.mock.calls[0][0]).toMatchObject({
      urlConversationId: 'conv-from-url',
      browserSessionId: 'browser-abc123',
    });
    // The global surface never consults the conversation to choose a strategy.
    expect(getConversation).not.toHaveBeenCalled();
  });

  it('runs the page strategy for a chatId turn, without a conversation lookup', async () => {
    const res = await handle(post({ messages: [], chatId: 'page-1', conversationId: 'conv-1' }), {
      surface: 'page-chat',
    });

    expect(await res.text()).toBe('page');
    expect(runGlobalChatTurn).not.toHaveBeenCalled();
    // No extra read on the hot path — the page strategy does its own, once.
    expect(getConversation).not.toHaveBeenCalled();
  });

  it('runs the GLOBAL strategy on /api/ai/chat when the conversation is a global thread', async () => {
    getConversation.mockResolvedValue({ id: 'conv-1', type: 'global', userId: 'user-1' });

    const res = await handle(post({ messages: [], conversationId: 'conv-1' }), { surface: 'page-chat' });

    expect(await res.text()).toBe('global');
    expect(getConversation).toHaveBeenCalledWith('conv-1');
    // No URL segment on this surface: the body id is the only source.
    expect(runGlobalChatTurn.mock.calls[0][0]).toMatchObject({ urlConversationId: undefined });
  });

  it('refuses an MCP token that reaches for a global conversation through /api/ai/chat', async () => {
    getConversation.mockResolvedValue({ id: 'conv-1', type: 'global', userId: 'user-1' });
    authenticateRequestWithOptions
      .mockResolvedValueOnce(MCP_AUTH) // the page surface admits MCP...
      .mockResolvedValueOnce({ error: new Response('nope', { status: 401 }) }); // ...the global strategy does not

    const res = await handle(post({ messages: [], conversationId: 'conv-1' }), { surface: 'page-chat' });

    expect(res.status).toBe(401);
    expect(runGlobalChatTurn).not.toHaveBeenCalled();
    expect(runPageChatTurn).not.toHaveBeenCalled();
    // The refusal is the session-only options answering, not a bespoke error.
    expect(authenticateRequestWithOptions.mock.calls[1][1]).toEqual({
      allow: ['session'],
      requireCSRF: true,
    });
  });

  it.each([
    ['a page conversation', { id: 'c', type: 'page', contextId: 'page-1' }],
    ['an API client thread', { id: 'c', type: 'client', agentPageId: 'page-1' }],
    ['no row at all', null],
  ])('leaves a chatId-less turn on the page strategy for %s', async (_label, row) => {
    getConversation.mockResolvedValue(row);

    const res = await handle(post({ messages: [], conversationId: 'conv-1' }), { surface: 'page-chat' });

    expect(await res.text()).toBe('page');
    expect(runGlobalChatTurn).not.toHaveBeenCalled();
  });

  /**
   * SELECTION IS OWNER-SCOPED, so the two branches refuse identically (review
   * finding — MINOR 3).
   *
   * Access was never at stake: `resolveOrCreateConversation` re-enforces owner
   * + type + isActive on its own. What WAS at stake is that someone else's
   * global conversation reached the global strategy and came back
   * `404 "Conversation not found"`, while every other id fell through to
   * `400 "chatId is required"` — so an authenticated caller could tell "this id
   * is an existing global conversation" from everything else. Nothing beyond
   * existence leaked, and cuid2 ids are not enumerable, but this codebase
   * refuses uniformly across "forbidden" and "does not exist" everywhere else
   * it decides anything, and the row is already in hand.
   *
   * Fails on the pre-fix code: it routed to `global`.
   */
  it('leaves ANOTHER user\'s global conversation on the page strategy, so it cannot be distinguished from an unknown id', async () => {
    getConversation.mockResolvedValue({ id: 'conv-1', type: 'global', userId: 'someone-else' });

    const res = await handle(post({ messages: [], conversationId: 'conv-1' }), { surface: 'page-chat' });

    // The same answer an id that names nothing gets — see the `null` case above.
    expect(await res.text()).toBe('page');
    expect(runGlobalChatTurn).not.toHaveBeenCalled();
  });

  it('falls through to the page strategy when the strategy lookup itself fails — never fails open', async () => {
    getConversation.mockRejectedValue(new Error('connection reset'));

    const res = await handle(post({ messages: [], conversationId: 'conv-1' }), { surface: 'page-chat' });

    expect(await res.text()).toBe('page');
    expect(runGlobalChatTurn).not.toHaveBeenCalled();
  });

  it('rejects a missing browser-session header before authenticating, on both surfaces', async () => {
    for (const surface of ['page-chat', 'global-messages'] as const) {
      const req = new Request('http://localhost/api/ai/chat', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      });
      const res = await handle(req, { surface });
      expect(res.status).toBe(400);
      expect(authenticateRequestWithOptions).not.toHaveBeenCalled();
    }
  });

  it('authenticates each surface with the options that surface has always used', async () => {
    await handle(post({ messages: [], chatId: 'page-1' }), { surface: 'page-chat' });
    expect(authenticateRequestWithOptions.mock.calls[0][1]).toEqual({
      allow: ['session', 'mcp'],
      requireCSRF: true,
    });

    vi.clearAllMocks();
    authenticateRequestWithOptions.mockResolvedValue(SESSION_AUTH);
    await handle(post({ messages: [] }), { surface: 'global-messages', urlConversationId: 'c' });
    expect(authenticateRequestWithOptions.mock.calls[0][1]).toEqual({
      allow: ['session'],
      requireCSRF: true,
    });
  });

  it('rejects an oversized body before parsing, on both surfaces', async () => {
    for (const surface of ['page-chat', 'global-messages'] as const) {
      const req = new Request('http://localhost/api/ai/chat', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-browser-session-id': 'browser-abc123',
          'content-length': String(26 * 1024 * 1024),
        },
        body: '{}',
      });
      const res = await handle(req, { surface });
      expect(res.status).toBe(413);
      expect(runPageChatTurn).not.toHaveBeenCalled();
      expect(runGlobalChatTurn).not.toHaveBeenCalled();
    }
  });

  it('answers an unparseable body with the 500 both routes have always answered', async () => {
    const req = new Request('http://localhost/api/ai/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-browser-session-id': 'browser-abc123' },
      body: 'not json at all',
    });

    const res = await handle(req, { surface: 'page-chat' });

    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'Failed to process chat request. Please try again.' });
  });
});
