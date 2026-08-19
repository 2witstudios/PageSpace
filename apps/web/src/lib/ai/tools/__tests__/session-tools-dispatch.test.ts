import { describe, it, expect, vi, beforeEach } from 'vitest';
import { verifyBroadcastSignature } from '@pagespace/lib/auth/broadcast-auth';
import { agentDispatchPayloadSchema } from '@pagespace/lib/auth/agent-dispatch-payload';
import { dispatchThroughChatPipeline } from '../session-tools-runtime';

// The dispatch SIGNS an internal hop rather than replaying the caller's browser
// credential — everything else the runtime module wires (db listings, sandbox
// provisioning, shells) is out of scope here and mocked away so the credential
// seam is the only thing under test. The sibling caller-session resolution seam
// is covered in session-tools-runtime.test.ts.
//
// This suite replaced the credential-REPLAY suite (issue #2333), whose subject —
// forwarded cookies, minted CSRF tokens, Bearer pass-through — no longer exists.
// The property it guarded (a dispatched turn is admitted as the calling user,
// and only as them) is now guarded by the signature and by `actingUserId`.
vi.mock('@pagespace/db/db', () => ({ db: {} }));
vi.mock('@pagespace/lib/permissions/permissions', () => ({ canUserViewPage: vi.fn(), getDriveIdsForUser: vi.fn() }));
vi.mock('@pagespace/lib/services/agent-workspaces/workspace-status', () => ({ deriveSandboxStatus: vi.fn() }));
vi.mock('@pagespace/lib/logging/logger-config', () => {
  const silent = { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() };
  return { loggers: { ai: silent, auth: silent } };
});
vi.mock('@/lib/agent-workspaces/agent-workspaces-runtime', () => ({
  checkAccessForSubject: vi.fn(),
  checkSessionAccess: vi.fn(),
  createConversationInSession: vi.fn(),
  endSession: vi.fn(),
  ensureDriveSessionForConversation: vi.fn(),
  ensureGlobalSandboxSession: vi.fn(),
  findSessionForConversation: vi.fn(),
  listSessions: vi.fn(),
  listSessionConversationsBulk: vi.fn(),
  provisionSessionSandbox: vi.fn(),
  spawnSession: vi.fn(),
  getAgentSessionStore: vi.fn(),
}));
vi.mock('@/lib/agent-workspaces/create-conversation-in-workspace', () => ({
  ConversationUnavailableError: class ConversationUnavailableError extends Error {},
  AgentNotInSessionDriveError: class AgentNotInSessionDriveError extends Error {},
  SessionFullError: class SessionFullError extends Error {},
}));
vi.mock('@/lib/repositories/conversation-repository', () => ({ conversationRepository: {} }));
vi.mock('@/lib/agent-workspaces/workspace-shells-runtime', () => ({
  getSessionShellStore: vi.fn(),
  killShellById: vi.fn(),
  listShells: vi.fn(),
  spawnShell: vi.fn(),
}));
vi.mock('@/lib/ai/core/abort-conversation-streams', () => ({ abortConversationStreams: vi.fn() }));
vi.mock('../shell-io', () => ({ createShellIo: vi.fn(() => ({})), realtimeShellIoTransport: {} }));

function fetchAdmitted(): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn(async () => ({
    ok: true,
    status: 200,
    body: null,
    text: async () => '',
  }));
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

function sentCall(fetchMock: ReturnType<typeof vi.fn>, index = 0) {
  const [url, init] = fetchMock.mock.calls[index] as [
    string,
    { headers: Record<string, string>; body: string },
  ];
  return { url, headers: init.headers, body: init.body };
}

/** The payload as it was SIGNED — parsed from the exact bytes that went on the wire. */
function sentPayload(fetchMock: ReturnType<typeof vi.fn>, index = 0) {
  return agentDispatchPayloadSchema.parse(JSON.parse(sentCall(fetchMock, index).body));
}

const DISPATCH_INPUT = {
  conversationId: 'worker-conversation-1',
  agentPageId: 'agent-page-1',
  input: 'hello',
  userId: 'user-1',
  depth: 1,
  wait: false,
  scope: { allowedDriveIds: [] as string[] },
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.unstubAllGlobals();
  vi.stubEnv('WEB_APP_URL', 'http://localhost:3000');
  vi.stubEnv('REALTIME_BROADCAST_SECRET', 'test-broadcast-secret-at-least-32-chars');
});

describe('dispatchThroughChatPipeline', () => {
  it('dispatches with NO ambient request at all', async () => {
    // The whole point. `next/headers` is not mocked here and there is no request
    // scope in a vitest process, so if anything in the dispatch still reached for
    // one this would throw or refuse. The voice bridge, cron, and the workflow
    // executor are all in exactly this position in production.
    const fetchMock = fetchAdmitted();

    const outcome = await dispatchThroughChatPipeline(DISPATCH_INPUT);

    expect(outcome).toEqual({ ok: true, waited: false });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('signs the body it actually sends, and names the acting user in it', async () => {
    const fetchMock = fetchAdmitted();

    await dispatchThroughChatPipeline(DISPATCH_INPUT);

    const { headers, body } = sentCall(fetchMock);
    // Verified over the RAW bytes: the HMAC covers the serialization, so a test
    // that re-serialized the object could pass while production failed.
    expect(verifyBroadcastSignature(headers['x-broadcast-signature'], body)).toBe(true);
    expect(sentPayload(fetchMock).actingUserId).toBe('user-1');
  });

  it('targets the internal dispatch route, never the public chat URL', async () => {
    // The public URL's auth matrix is a policy about untrusted clients naming an
    // arbitrary conversation id. Sending a signed dispatch there would re-import
    // that policy — notably the MCP refusal that blocks global workers.
    const fetchMock = fetchAdmitted();

    await dispatchThroughChatPipeline(DISPATCH_INPUT);

    expect(sentCall(fetchMock).url).toBe('http://localhost:3000/api/internal/agent-dispatch');
  });

  it('carries the caller\'s drive ceiling across the hop', async () => {
    // SECURITY. The dispatched worker runs in a fresh request that knows nothing
    // about the token that started the chain. Anything not carried is not merely
    // lost — it re-reads as full access downstream (`getAllowedDriveIds`), so a
    // drive-scoped MCP token's worker would come out the far side UNSCOPED.
    const fetchMock = fetchAdmitted();

    await dispatchThroughChatPipeline({
      ...DISPATCH_INPUT,
      scope: { allowedDriveIds: ['drive-a', 'drive-b'], mcpTokenId: 'mcp-token-1' },
    });

    const payload = sentPayload(fetchMock);
    expect(payload.allowedDriveIds).toEqual(['drive-a', 'drive-b']);
    expect(payload.originatingMcpTokenId).toBe('mcp-token-1');
  });

  it('signs the depth rather than leaving it on a forgeable header', async () => {
    // The depth is the termination condition of a recursive system. On the public
    // routes the header is deliberately untrusted-but-safe; on this hop it is
    // signed, so a forged header cannot reset a chain's cap mid-flight.
    const fetchMock = fetchAdmitted();

    await dispatchThroughChatPipeline({ ...DISPATCH_INPUT, depth: 2 });

    expect(sentPayload(fetchMock).depth).toBe(2);
    expect(sentCall(fetchMock).headers['x-agent-dispatch-depth']).toBeUndefined();
  });

  it('targets ONE internal path whether or not the worker has an agent page', async () => {
    // The acceptance signal for the chat route consolidation (epic
    // "Agent-Session Single Source of Truth", Phase 5): dispatch names the
    // pipeline once and lets it pick the page-agent or global-assistant strategy
    // from the CONVERSATION. The page worker carries `chatId`; the global worker
    // carries none and the entry resolves its conversation.
    const fetchMock = fetchAdmitted();

    await dispatchThroughChatPipeline(DISPATCH_INPUT);
    await dispatchThroughChatPipeline({ ...DISPATCH_INPUT, agentPageId: null });

    expect(sentCall(fetchMock, 0).url).toBe(sentCall(fetchMock, 1).url);
    expect(sentPayload(fetchMock, 0).chatId).toBe('agent-page-1');
    expect(sentPayload(fetchMock, 1).chatId).toBeNull();
    expect(sentPayload(fetchMock, 1).conversationId).toBe('worker-conversation-1');
  });

  it('refuses when the app\'s own URL is not configured', async () => {
    vi.stubEnv('WEB_APP_URL', '');
    vi.stubEnv('NEXT_PUBLIC_APP_URL', '');
    const fetchMock = fetchAdmitted();

    const outcome = await dispatchThroughChatPipeline(DISPATCH_INPUT);

    expect(outcome).toEqual({
      ok: false,
      reason: 'failed',
      detail: 'the app\'s own URL is not configured (set WEB_APP_URL or NEXT_PUBLIC_APP_URL)',
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('surfaces the route\'s error body verbatim on a non-ok answer', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: false,
      status: 401,
      json: async () => ({ error: 'Authentication failed' }),
    }));
    vi.stubGlobal('fetch', fetchMock);

    const outcome = await dispatchThroughChatPipeline(DISPATCH_INPUT);

    expect(outcome).toEqual({ ok: false, reason: 'failed', detail: 'Authentication failed' });
  });

  it('reports a FIXED message when the hop cannot be reached', async () => {
    // Never the raw fetch/network error (issue #2262 finding 3) — DNS, connection
    // refused and TLS are internal details, not something to hand a model.
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('ECONNREFUSED 127.0.0.1:3000'); }));

    const outcome = await dispatchThroughChatPipeline(DISPATCH_INPUT);

    expect(outcome).toEqual({
      ok: false,
      reason: 'failed',
      detail: 'could not reach the chat pipeline to dispatch this turn',
    });
  });
});
