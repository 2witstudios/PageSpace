/**
 * The browser door's session chain (Agent Signup Phase 3): createSession →
 * validateSession → generateCSRFToken → appendSessionCookie → optional device
 * token, recording the agent-secret ceremony.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({
  createSession: vi.fn(),
  validateSession: vi.fn(),
  csrf: vi.fn(),
  deviceToken: vi.fn(),
  appendCookie: vi.fn(),
  recordAuth: vi.fn(),
}));

vi.mock('@pagespace/lib/auth/session-service', () => ({
  sessionService: { createSession: mocks.createSession, validateSession: mocks.validateSession },
}));
vi.mock('@pagespace/lib/auth/csrf-utils', () => ({ generateCSRFToken: mocks.csrf }));
vi.mock('@pagespace/lib/auth/constants', () => ({ SESSION_DURATION_MS: 1000 }));
vi.mock('@pagespace/lib/logging/logger-config', () => ({ loggers: { auth: { error: vi.fn(), warn: vi.fn(), info: vi.fn() } } }));
vi.mock('@/lib/auth', () => ({ createDeviceToken: mocks.deviceToken }));
vi.mock('@pagespace/lib/services/agent-identities', () => ({ recordAgentAuthentication: mocks.recordAuth }));
vi.mock('@/lib/auth/cookie-config', () => ({
  appendSessionCookie: (headers: Headers, token: string) => {
    mocks.appendCookie(token);
    headers.append('Set-Cookie', `session=${token}`);
  },
}));

import { startAgentBrowserSession, agentRedirectUrl } from '../browser-session';

const request = () => new Request('http://web.local/api/auth/agent/signin', { headers: { 'user-agent': 'AgentBrowser/1' } });

describe('startAgentBrowserSession', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.createSession.mockResolvedValue('ps_sess_token');
    mocks.validateSession.mockResolvedValue({ sessionId: 'sess-1', userId: 'agent-1' });
    mocks.csrf.mockReturnValue('csrf-1');
    mocks.deviceToken.mockResolvedValue('ps_dev_token');
    mocks.recordAuth.mockResolvedValue(undefined);
  });

  // Security review: a browser-door agent that only ever used its session was
  // never stamped, so the 30-day lifecycle sweep erased an agent in active use.
  it('should stamp the agent as authenticated (lastAuthAt) — a session IS an authentication', async () => {
    const result = await startAgentBrowserSession({ request: request(), userId: 'agent-1', tokenVersion: 3, clientIP: '203.0.113.9' });
    expect(result.ok).toBe(true);
    expect(mocks.recordAuth).toHaveBeenCalledWith({ userId: 'agent-1', now: expect.any(Date) });
  });

  it('given the stamp fails, should still hand over the session (the next sign-in or refresh stamps again)', async () => {
    mocks.recordAuth.mockRejectedValue(new Error('store down'));
    const result = await startAgentBrowserSession({ request: request(), userId: 'agent-1', tokenVersion: 3, clientIP: '203.0.113.9' });
    expect(result.ok).toBe(true);
  });

  it('given the session could not be validated, should not stamp anything', async () => {
    mocks.validateSession.mockResolvedValue(null);
    await startAgentBrowserSession({ request: request(), userId: 'agent-1', tokenVersion: 3, clientIP: '203.0.113.9' });
    expect(mocks.recordAuth).not.toHaveBeenCalled();
  });

  it('given an agent, should create a full user session recording the one-factor agent-secret ceremony', async () => {
    await startAgentBrowserSession({ request: request(), userId: 'agent-1', tokenVersion: 3, clientIP: '203.0.113.9', deviceId: 'dev-1' });
    expect(mocks.createSession).toHaveBeenCalledWith({
      authentication: { authenticatedAtMs: expect.any(Number), assurance: 'single_factor' },
      userId: 'agent-1',
      type: 'user',
      scopes: ['*'],
      expiresInMs: 1000,
      deviceId: 'dev-1',
      createdByIp: '203.0.113.9',
    });
  });

  it('should bind the CSRF token to the validated session id and set the session and csrf cookies', async () => {
    const result = await startAgentBrowserSession({ request: request(), userId: 'agent-1', tokenVersion: 3, clientIP: '203.0.113.9' });
    expect(mocks.csrf).toHaveBeenCalledWith('sess-1');
    expect(mocks.appendCookie).toHaveBeenCalledWith('ps_sess_token');
    if (!result.ok) throw new Error('expected ok');
    expect(result.csrfToken).toBe('csrf-1');
    const cookies = result.headers.get('set-cookie') ?? '';
    expect(cookies).toContain('session=ps_sess_token');
    expect(cookies).toContain('csrf_token=csrf-1');
    expect(result.headers.get('Cache-Control')).toBe('no-store');
  });

  it('given a deviceId, should mint a web device token carrying the agent tokenVersion', async () => {
    const result = await startAgentBrowserSession({ request: request(), userId: 'agent-1', tokenVersion: 3, clientIP: 'unknown', deviceId: 'dev-1', deviceName: 'Chrome' });
    expect(mocks.deviceToken).toHaveBeenCalledWith(expect.objectContaining({ userId: 'agent-1', deviceId: 'dev-1', tokenVersion: 3, platform: 'web', deviceName: 'Chrome', ipAddress: undefined }));
    expect(result.ok && result.deviceToken).toBe('ps_dev_token');
  });

  it('given no deviceId, should mint no device token', async () => {
    const result = await startAgentBrowserSession({ request: request(), userId: 'agent-1', tokenVersion: 3, clientIP: 'unknown' });
    expect(mocks.deviceToken).not.toHaveBeenCalled();
    expect(result.ok && result.deviceToken).toBeNull();
  });

  it('given the device token fails, should still return the session', async () => {
    mocks.deviceToken.mockRejectedValue(new Error('db'));
    const result = await startAgentBrowserSession({ request: request(), userId: 'agent-1', tokenVersion: 3, clientIP: 'unknown', deviceId: 'dev-1' });
    expect(result.ok).toBe(true);
  });

  it('given the new session does not validate, should fail closed with no cookie', async () => {
    mocks.validateSession.mockResolvedValue(null);
    const result = await startAgentBrowserSession({ request: request(), userId: 'agent-1', tokenVersion: 3, clientIP: 'unknown' });
    expect(result).toEqual({ ok: false });
    expect(mocks.appendCookie).not.toHaveBeenCalled();
  });
});

describe('agentRedirectUrl', () => {
  it.each([
    [undefined, '/dashboard'],
    ['/dashboard/drive-1', '/dashboard/drive-1'],
    ['/activate?user_code=ABCD-EFGH', '/activate?user_code=ABCD-EFGH'],
    ['https://evil.example/dashboard', '/dashboard'],
    ['//evil.example', '/dashboard'],
    ['/settings/../../admin', '/dashboard'],
  ])('given next=%s, should redirect to %s', (next, expected) => {
    expect(agentRedirectUrl(next)).toBe(expected);
  });
});
