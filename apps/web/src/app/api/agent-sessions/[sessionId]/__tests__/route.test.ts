// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from 'vitest';

const {
  mockAuthenticateRequest,
  mockAuditRequest,
  mockCheckSessionAccess,
  mockCheckSessionEndAccess,
  mockEndSession,
  mockFindSessionRecord,
  mockProvisionSessionSandbox,
} = vi.hoisted(() => ({
  mockAuthenticateRequest: vi.fn(),
  mockAuditRequest: vi.fn(),
  mockCheckSessionAccess: vi.fn(),
  mockCheckSessionEndAccess: vi.fn(),
  mockEndSession: vi.fn(),
  mockFindSessionRecord: vi.fn(),
  mockProvisionSessionSandbox: vi.fn(),
}));

vi.mock('@/lib/auth', () => ({
  authenticateRequestWithOptions: (...args: unknown[]) => mockAuthenticateRequest(...args),
  isAuthError: (result: unknown) => result != null && typeof result === 'object' && 'error' in result,
}));
vi.mock('@pagespace/lib/audit/audit-log', () => ({
  auditRequest: (...args: unknown[]) => mockAuditRequest(...args),
}));
vi.mock('@pagespace/lib/logging/logger-config', () => ({
  loggers: { api: { error: vi.fn(), warn: vi.fn() } },
}));
vi.mock('@/lib/agent-sessions/agent-sessions-runtime', () => ({
  checkSessionAccess: (...args: unknown[]) => mockCheckSessionAccess(...args),
  checkSessionEndAccess: (...args: unknown[]) => mockCheckSessionEndAccess(...args),
  endSession: (...args: unknown[]) => mockEndSession(...args),
  findSessionRecord: (...args: unknown[]) => mockFindSessionRecord(...args),
  provisionSessionSandbox: (...args: unknown[]) => mockProvisionSessionSandbox(...args),
  toAgentSessionDTO: (row: { id: string }) => ({ sessionId: row.id, dto: true }),
}));

import { GET, POST, DELETE } from '../route';

const AUTH_USER = { userId: 'user-1', role: 'admin' };
const SESSION_ID = 'ses-1';
const ROW = { id: SESSION_ID, ownerId: 'user-1', driveId: 'drive-1' };

const params = { params: Promise.resolve({ sessionId: SESSION_ID }) };
const get = () => GET(new Request(`http://localhost/api/agent-sessions/${SESSION_ID}`), params);
const post = () => POST(new Request(`http://localhost/api/agent-sessions/${SESSION_ID}`, { method: 'POST' }), params);
const del = () => DELETE(new Request(`http://localhost/api/agent-sessions/${SESSION_ID}`, { method: 'DELETE' }), params);

beforeEach(() => {
  vi.clearAllMocks();
  mockAuthenticateRequest.mockResolvedValue(AUTH_USER);
  mockCheckSessionAccess.mockResolvedValue({ allowed: true });
  mockCheckSessionEndAccess.mockResolvedValue({ allowed: true });
  mockFindSessionRecord.mockResolvedValue(ROW);
  mockProvisionSessionSandbox.mockResolvedValue({ ok: true, sandboxId: 'sb-1', resumed: false });
  mockEndSession.mockResolvedValue({ ok: true, spriteTornDown: true });
});

describe('GET /api/agent-sessions/[sessionId]', () => {
  it('given an accessible session, should return its DTO', async () => {
    const response = await get();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ session: { sessionId: SESSION_ID, dto: true } });
  });

  it('given a never-provisioned session (no row), should answer { session: null } with 200 — NOT 404', async () => {
    mockCheckSessionAccess.mockResolvedValue({ allowed: false, reason: 'session_not_found' });
    const response = await get();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ session: null });
  });

  it('given a denial, should 403 and audit it', async () => {
    mockCheckSessionAccess.mockResolvedValue({ allowed: false, reason: 'page_access_denied' });
    const response = await get();
    expect(response.status).toBe(403);
    expect(mockAuditRequest).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ eventType: 'authz.access.denied' }),
    );
  });
});

describe('POST /api/agent-sessions/[sessionId]', () => {
  it('should (re-)provision an EXISTING session and return the DTO — spawn lives on the collection route', async () => {
    const response = await post();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ session: { sessionId: SESSION_ID, dto: true } });
    expect(mockProvisionSessionSandbox).toHaveBeenCalledWith(ROW, 'user-1');
  });

  it('given no such session, should 404 and never provision — this route mints nothing', async () => {
    mockCheckSessionAccess.mockResolvedValue({ allowed: false, reason: 'session_not_found' });
    const response = await post();
    expect(response.status).toBe(404);
    expect(mockProvisionSessionSandbox).not.toHaveBeenCalled();
  });

  it('given an access denial, should 403 BEFORE provisioning anything', async () => {
    mockCheckSessionAccess.mockResolvedValue({ allowed: false, reason: 'drive_access_denied' });
    const response = await post();
    expect(response.status).toBe(403);
    expect(mockProvisionSessionSandbox).not.toHaveBeenCalled();
  });

  it('given a PLAN-LIMIT refusal, should 429 — not the 403 an authorization failure gets', async () => {
    mockProvisionSessionSandbox.mockResolvedValue({ ok: false, reason: 'denied', denial: 'session_limit_reached' });
    const response = await post();
    expect(response.status).toBe(429);
  });

  it('given a provisioning denial, should 403 with the audit trail', async () => {
    mockProvisionSessionSandbox.mockResolvedValue({ ok: false, reason: 'denied', denial: 'not_authorized' });
    const response = await post();
    expect(response.status).toBe(403);
  });

  it('given a provisioning failure, should 502 with the reason token', async () => {
    mockProvisionSessionSandbox.mockResolvedValue({ ok: false, reason: 'provision_failed', detail: 'boom' });
    const response = await post();
    expect(response.status).toBe(502);
    expect((await response.json()).reason).toBe('provision_failed');
  });
});

describe('DELETE /api/agent-sessions/[sessionId]', () => {
  it('should end the session (row retained) and report the teardown', async () => {
    const response = await del();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, spriteTornDown: true });
    expect(mockEndSession).toHaveBeenCalledWith(SESSION_ID);
  });

  it('should gate on the END access check — the one WITHOUT the capability gate', async () => {
    await del();
    expect(mockCheckSessionEndAccess).toHaveBeenCalledWith('user-1', SESSION_ID);
    expect(mockCheckSessionAccess).not.toHaveBeenCalled();
  });

  it('given no such session, should 404', async () => {
    mockCheckSessionEndAccess.mockResolvedValue({ allowed: false, reason: 'session_not_found' });
    const response = await del();
    expect(response.status).toBe(404);
    expect(mockEndSession).not.toHaveBeenCalled();
  });

  it('given a denial, should 403 and never touch the session', async () => {
    mockCheckSessionEndAccess.mockResolvedValue({ allowed: false, reason: 'not_shared' });
    const response = await del();
    expect(response.status).toBe(403);
    expect(mockEndSession).not.toHaveBeenCalled();
  });

  it('given a teardown failure, should 502 so the caller can retry', async () => {
    mockEndSession.mockResolvedValue({ ok: false, reason: 'teardown_failed', detail: 'kill failed' });
    const response = await del();
    expect(response.status).toBe(502);
  });
});
