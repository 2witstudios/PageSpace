import { describe, it, expect, vi, beforeEach } from 'vitest';
import { headers } from 'next/headers';
import { validateCSRFToken } from '@pagespace/lib/auth/csrf-utils';
import { sessionService } from '@pagespace/lib/auth/session-service';
import { dispatchThroughChatPipeline } from '../session-tools-runtime';

// The dispatch replays/mints CREDENTIALS for an internal HTTP hop — everything
// else the runtime module wires (db listings, sandbox provisioning, shells) is
// out of scope here and mocked away so the credential seam is the only thing
// under test (issue #2333). The sibling caller-session resolution seam is
// covered in session-tools-runtime.test.ts.
vi.mock('next/headers', () => ({ headers: vi.fn() }));
vi.mock('@pagespace/db/db', () => ({ db: {} }));
vi.mock('@pagespace/lib/permissions/permissions', () => ({ canUserViewPage: vi.fn() }));
vi.mock('@pagespace/lib/services/agent-sessions/session-status', () => ({ deriveSandboxStatus: vi.fn() }));
vi.mock('@pagespace/lib/logging/logger-config', () => {
  const silent = { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() };
  return { loggers: { ai: silent, auth: silent } };
});
vi.mock('@pagespace/lib/auth/session-service', () => ({
  sessionService: { validateSession: vi.fn() },
}));
vi.mock('@/lib/agent-sessions/agent-sessions-runtime', () => ({
  createConversationInSession: vi.fn(),
  ensureGlobalSandboxSession: vi.fn(),
  findSessionForConversation: vi.fn(),
  provisionSessionSandbox: vi.fn(),
  getAgentSessionStore: vi.fn(),
}));
vi.mock('@/lib/agent-sessions/create-conversation-in-session', () => ({
  ConversationUnavailableError: class ConversationUnavailableError extends Error {},
  AgentNotInSessionDriveError: class AgentNotInSessionDriveError extends Error {},
  SessionFullError: class SessionFullError extends Error {},
}));
vi.mock('@/lib/repositories/conversation-repository', () => ({ conversationRepository: {} }));
vi.mock('@/lib/agent-sessions/session-shells-runtime', () => ({
  getSessionShellStore: vi.fn(),
  killShellById: vi.fn(),
  listShells: vi.fn(),
  spawnShell: vi.fn(),
}));
vi.mock('@/lib/ai/core/abort-conversation-streams', () => ({ abortConversationStreams: vi.fn() }));
vi.mock('../shell-io', () => ({ createShellIo: vi.fn(() => ({})), realtimeShellIoTransport: {} }));

const headersMock = vi.mocked(headers);
const validateSessionMock = vi.mocked(sessionService.validateSession);

const AUTH_SESSION_ID = 'auth-session-row-1';
const SESSION_COOKIE = 'session=opaque-session-token';
const BEARER = 'Bearer ps_sess_desktop-token';
/** A syntactically token-shaped browser CSRF header — NOT freshly minted. */
const STALE_BROWSER_CSRF = 'deadbeef.1700000000.feedface';

function incomingHeaders(entries: Record<string, string>): void {
  headersMock.mockResolvedValue(new Headers(entries));
}

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

function sentHeaders(fetchMock: ReturnType<typeof vi.fn>): Record<string, string> {
  const [, init] = fetchMock.mock.calls[0] as [string, { headers: Record<string, string> }];
  return init.headers;
}

const DISPATCH_INPUT = {
  sessionId: 'worker-conversation-1',
  agentPageId: 'agent-page-1',
  input: 'hello',
  userId: 'user-1',
  depth: 1,
  wait: false,
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.unstubAllGlobals();
  vi.stubEnv('WEB_APP_URL', 'http://localhost:3000');
  vi.stubEnv('CSRF_SECRET', 'test-csrf-secret');
  // Default: the forwarded cookie resolves to a live browser session.
  validateSessionMock.mockResolvedValue({
    sessionId: AUTH_SESSION_ID,
    userId: 'user-1',
  } as never);
});

describe('dispatchThroughChatPipeline credentials (issue #2333)', () => {
  it('forwards the caller\'s Bearer authorization on the internal POST', async () => {
    // Desktop/mobile/MCP callers authenticate with Authorization, carry a
    // cookie anyway (credentials: 'include'), and have NO CSRF token. Without
    // the authorization header the hop degrades to cookie-only session auth
    // and 403s "CSRF token required".
    incomingHeaders({ cookie: SESSION_COOKIE, authorization: BEARER });
    const fetchMock = fetchAdmitted();

    const outcome = await dispatchThroughChatPipeline(DISPATCH_INPUT);

    expect(outcome).toEqual({ ok: true, waited: false });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(sentHeaders(fetchMock)['authorization']).toBe(BEARER);
    // Bearer hops are CSRF-immune at the route — no minting, no session lookup.
    expect(validateSessionMock).not.toHaveBeenCalled();
    expect(sentHeaders(fetchMock)['x-csrf-token']).toBeUndefined();
  });

  it('dispatches with Bearer authorization alone — no cookie required', async () => {
    incomingHeaders({ authorization: BEARER });
    const fetchMock = fetchAdmitted();

    const outcome = await dispatchThroughChatPipeline(DISPATCH_INPUT);

    expect(outcome).toEqual({ ok: true, waited: false });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(sentHeaders(fetchMock)['authorization']).toBe(BEARER);
  });

  it('mints a fresh CSRF token bound to the caller\'s cookie session instead of replaying the browser\'s', async () => {
    // The browser's own token expires after 1h — an agent turn can outlive it.
    // The hop must mint its own token from the server-validated session id
    // (the same binding validateCSRF checks), not replay the stale one.
    incomingHeaders({ cookie: SESSION_COOKIE, 'x-csrf-token': STALE_BROWSER_CSRF });
    const fetchMock = fetchAdmitted();

    const outcome = await dispatchThroughChatPipeline(DISPATCH_INPUT);

    expect(outcome).toEqual({ ok: true, waited: false });
    expect(validateSessionMock).toHaveBeenCalledWith('opaque-session-token', { expectedType: 'user' });
    const sent = sentHeaders(fetchMock)['x-csrf-token'];
    expect(sent).not.toBe(STALE_BROWSER_CSRF);
    expect(validateCSRFToken(sent, AUTH_SESSION_ID)).toBe(true);
  });

  it('mints even when the browser sent no CSRF token at all', async () => {
    // The exact issue-#2333 shape: a session-cookie caller whose own request
    // never carried x-csrf-token (e.g. the route admitted it via Bearer or a
    // CSRF-exempt path). Cookie-only replay is guaranteed to 403.
    incomingHeaders({ cookie: SESSION_COOKIE });
    const fetchMock = fetchAdmitted();

    const outcome = await dispatchThroughChatPipeline(DISPATCH_INPUT);

    expect(outcome).toEqual({ ok: true, waited: false });
    expect(validateCSRFToken(sentHeaders(fetchMock)['x-csrf-token'], AUTH_SESSION_ID)).toBe(true);
  });

  it('falls back to the forwarded browser token when the cookie session does not validate', async () => {
    // Revoked/expired cookie session: minting is impossible; forwarding what
    // the caller sent lets the route answer with its own honest auth error.
    validateSessionMock.mockResolvedValue(null as never);
    incomingHeaders({ cookie: SESSION_COOKIE, 'x-csrf-token': STALE_BROWSER_CSRF });
    const fetchMock = fetchAdmitted();

    await dispatchThroughChatPipeline(DISPATCH_INPUT);

    expect(sentHeaders(fetchMock)['x-csrf-token']).toBe(STALE_BROWSER_CSRF);
  });

  it('refuses with a fixed message when the request carries neither cookie nor authorization', async () => {
    incomingHeaders({});
    const fetchMock = fetchAdmitted();

    const outcome = await dispatchThroughChatPipeline(DISPATCH_INPUT);

    expect(outcome).toEqual({
      ok: false,
      reason: 'failed',
      detail: 'the calling request carries no session credentials to dispatch with',
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('surfaces the chat route\'s error body verbatim on a non-ok answer', async () => {
    incomingHeaders({ cookie: SESSION_COOKIE });
    const fetchMock = vi.fn(async () => ({
      ok: false,
      status: 403,
      json: async () => ({ error: 'CSRF token required' }),
    }));
    vi.stubGlobal('fetch', fetchMock);

    const outcome = await dispatchThroughChatPipeline(DISPATCH_INPUT);

    expect(outcome).toEqual({ ok: false, reason: 'failed', detail: 'CSRF token required' });
  });
});
