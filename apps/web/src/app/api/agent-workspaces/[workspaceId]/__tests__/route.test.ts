// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from 'vitest';

const {
  mockAuthenticateRequest,
  mockAuditRequest,
  mockCheckSessionAccess,
  mockCheckSessionEndAccess,
  mockCountOpenConversationsForSession,
  mockEndSession,
  mockFindSessionRecord,
  mockProvisionSessionSandbox,
  mockResolveSandboxToolEligibility,
} = vi.hoisted(() => ({
  mockAuthenticateRequest: vi.fn(),
  mockAuditRequest: vi.fn(),
  mockCheckSessionAccess: vi.fn(),
  mockCheckSessionEndAccess: vi.fn(),
  mockCountOpenConversationsForSession: vi.fn(),
  mockEndSession: vi.fn(),
  mockFindSessionRecord: vi.fn(),
  mockProvisionSessionSandbox: vi.fn(),
  mockResolveSandboxToolEligibility: vi.fn(),
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
vi.mock('@/lib/agent-workspaces/agent-workspaces-runtime', () => ({
  checkSessionAccess: (...args: unknown[]) => mockCheckSessionAccess(...args),
  checkSessionEndAccess: (...args: unknown[]) => mockCheckSessionEndAccess(...args),
  countOpenConversationsForSession: (...args: unknown[]) => mockCountOpenConversationsForSession(...args),
  endSession: (...args: unknown[]) => mockEndSession(...args),
  findSessionRecord: (...args: unknown[]) => mockFindSessionRecord(...args),
  provisionSessionSandbox: (...args: unknown[]) => mockProvisionSessionSandbox(...args),
  toAgentSessionDTO: (row: { id: string }) => ({ workspaceId: row.id, dto: true }),
}));
vi.mock('@pagespace/lib/services/agent-workspaces/agent-workspace-tenant', () => ({
  canRunCodeForSession: (...args: unknown[]) => mockResolveSandboxToolEligibility(...args),
}));

import { GET, POST, DELETE } from '../route';

const AUTH_USER = { userId: 'user-1', role: 'admin' };
const SESSION_ID = 'ses-1';
const ROW = { id: SESSION_ID, ownerId: 'user-1', driveId: 'drive-1' };

const params = { params: Promise.resolve({ workspaceId: SESSION_ID }) };
const get = () => GET(new Request(`http://localhost/api/agent-workspaces/${SESSION_ID}`), params);
const post = () => POST(new Request(`http://localhost/api/agent-workspaces/${SESSION_ID}`, { method: 'POST' }), params);
const del = () => DELETE(new Request(`http://localhost/api/agent-workspaces/${SESSION_ID}`, { method: 'DELETE' }), params);

beforeEach(() => {
  vi.clearAllMocks();
  mockAuthenticateRequest.mockResolvedValue(AUTH_USER);
  mockCheckSessionAccess.mockResolvedValue({ allowed: true });
  mockCheckSessionEndAccess.mockResolvedValue({ allowed: true });
  mockFindSessionRecord.mockResolvedValue(ROW);
  mockProvisionSessionSandbox.mockResolvedValue({ ok: true, sandboxId: 'sb-1', resumed: false });
  mockCountOpenConversationsForSession.mockResolvedValue(1);
  mockEndSession.mockResolvedValue({ ok: true, spriteTornDown: true });
  mockResolveSandboxToolEligibility.mockResolvedValue(true);
});

describe('GET /api/agent-workspaces/[workspaceId]', () => {
  it("given an accessible session, should return its DTO plus the REQUESTER's sandbox capability verdict", async () => {
    const response = await get();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      session: { workspaceId: SESSION_ID, dto: true },
      sandboxEligible: true,
      canEndSession: true,
    });
    // The full centralized canRunCode verdict for THIS requester against the
    // session's own coordinates (review #2326): payer tier alone enabled
    // Shell controls for viewer-role members that every enforcement point
    // then 403'd.
    expect(mockResolveSandboxToolEligibility).toHaveBeenCalledWith({
      userId: AUTH_USER.userId,
      driveId: ROW.driveId,
      ownerId: ROW.ownerId,
    });
  });

  it('given a requester who may not run code here (free payer, viewer role, or kill switch off), should report sandboxEligible: false', async () => {
    mockResolveSandboxToolEligibility.mockResolvedValue(false);
    const response = await get();
    expect(await response.json()).toEqual({
      session: { workspaceId: SESSION_ID, dto: true },
      sandboxEligible: false,
      canEndSession: true,
    });
  });

  /**
   * `canEndSession` — the second capability the client cannot compute.
   *
   * Ending is gated by `checkSessionEndAccess`, which is STRICTER than the
   * `checkSessionAccess` that let the caller reach this row at all (owner
   * always; otherwise drive owner/admin AND real code-execution capability).
   * The pane grid asks for it so closing the last pane does not offer an
   * end-session confirm to someone the DELETE below would refuse.
   */
  it('reports canEndSession: false for a member who may reach the session but not end it', async () => {
    mockCheckSessionEndAccess.mockResolvedValue({ allowed: false, reason: 'delete_authority_required' });

    const response = await get();

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      session: { workspaceId: SESSION_ID, dto: true },
      sandboxEligible: true,
      canEndSession: false,
    });
    // The SAME check the DELETE is gated by, asked about the same session — not
    // a second rule that could drift from it.
    expect(mockCheckSessionEndAccess).toHaveBeenCalledWith(AUTH_USER.userId, SESSION_ID);
  });

  it('given a never-provisioned session (no row), should answer { session: null } with 200 — NOT 404', async () => {
    mockCheckSessionAccess.mockResolvedValue({ allowed: false, reason: 'session_not_found' });
    const response = await get();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ session: null });
  });

  it('given a denial, should answer { session: null } — SAME as not-found, but still audit it (review #2261/5)', async () => {
    mockCheckSessionAccess.mockResolvedValue({ allowed: false, reason: 'page_access_denied' });
    const response = await get();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ session: null });
    expect(mockAuditRequest).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ eventType: 'authz.access.denied' }),
    );
  });
});

describe('POST /api/agent-workspaces/[workspaceId]', () => {
  it('should (re-)provision an EXISTING session and return the DTO — spawn lives on the collection route', async () => {
    const response = await post();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ session: { workspaceId: SESSION_ID, dto: true } });
    expect(mockProvisionSessionSandbox).toHaveBeenCalledWith(ROW, 'user-1');
  });

  it('given no such session, should 404 and never provision — this route mints nothing', async () => {
    mockCheckSessionAccess.mockResolvedValue({ allowed: false, reason: 'session_not_found' });
    const response = await post();
    expect(response.status).toBe(404);
    expect(mockProvisionSessionSandbox).not.toHaveBeenCalled();
  });

  it('given an access denial, should 404 (SAME as not-found, review #2261/5) BEFORE provisioning anything', async () => {
    mockCheckSessionAccess.mockResolvedValue({ allowed: false, reason: 'drive_access_denied' });
    const response = await post();
    expect(response.status).toBe(404);
    expect(mockProvisionSessionSandbox).not.toHaveBeenCalled();
  });

  it('given a PLAN-LIMIT refusal, should 429 with the human sentence — not the provisioner\'s diagnostic enum', async () => {
    // `detail: 'concurrency_limit'` is the REAL shape `checkAgentSessionConcurrency`
    // returns — a diagnostic enum, not a sentence. It must reach the audit row
    // and never the response body (PR #2253's live P1).
    mockProvisionSessionSandbox.mockResolvedValue({
      ok: false,
      reason: 'denied',
      denial: 'session_limit_reached',
      detail: 'concurrency_limit',
    });
    const response = await post();
    expect(response.status).toBe(429);
    const body = await response.json();
    expect(body.error).not.toContain('concurrency_limit');
    expect(mockAuditRequest).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        details: expect.objectContaining({ reasonCode: 'concurrency_limit' }),
      }),
    );
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

describe('DELETE /api/agent-workspaces/[workspaceId]', () => {
  it('should end the session (row retained) and report the teardown', async () => {
    const response = await del();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, spriteTornDown: true, hadOtherOpenConversations: false });
    expect(mockEndSession).toHaveBeenCalledWith(SESSION_ID);
  });

  it('reports hadOtherOpenConversations: true — informational only, still ends the session', async () => {
    // Ending is unconditional by design (the sidebar's own "End session" is
    // reachable regardless of open-conversation count) — this field never
    // blocks teardown, it only lets a caller whose confirm was based on a
    // stale "this looks empty" premise warn the user after the fact (caught
    // in review: a conversation minted elsewhere can commit between an
    // earlier `last_conversation` 409 and this confirm).
    mockCountOpenConversationsForSession.mockResolvedValue(3);
    const response = await del();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, spriteTornDown: true, hadOtherOpenConversations: true });
    expect(mockEndSession).toHaveBeenCalledWith(SESSION_ID);
  });

  it('still ends the session even if the informational count read itself fails', async () => {
    mockCountOpenConversationsForSession.mockRejectedValue(new Error('db blip'));
    const response = await del();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, spriteTornDown: true, hadOtherOpenConversations: false });
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

  it('given a denial, should 404 (SAME as not-found, review #2261/5) and never touch the session', async () => {
    mockCheckSessionEndAccess.mockResolvedValue({ allowed: false, reason: 'not_shared' });
    const response = await del();
    expect(response.status).toBe(404);
    expect(mockEndSession).not.toHaveBeenCalled();
  });

  it('given a teardown failure, should 502 so the caller can retry', async () => {
    mockEndSession.mockResolvedValue({ ok: false, reason: 'teardown_failed', detail: 'kill failed' });
    const response = await del();
    expect(response.status).toBe(502);
  });
});
