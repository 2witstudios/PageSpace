// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from 'vitest';

const {
  mockAuthenticateRequest,
  mockAuditRequest,
  mockCheckSessionAccess,
  mockCheckAccessForSubject,
  mockEnsureSession,
  mockFindSessionConversation,
  mockProvisionSessionSandbox,
  mockListShells,
  mockSpawnShell,
} = vi.hoisted(() => ({
  mockAuthenticateRequest: vi.fn(),
  mockAuditRequest: vi.fn(),
  mockCheckSessionAccess: vi.fn(),
  mockCheckAccessForSubject: vi.fn(),
  mockEnsureSession: vi.fn(),
  mockFindSessionConversation: vi.fn(),
  mockProvisionSessionSandbox: vi.fn(),
  mockListShells: vi.fn(),
  mockSpawnShell: vi.fn(),
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
  checkAccessForSubject: (...args: unknown[]) => mockCheckAccessForSubject(...args),
  ensureSession: (...args: unknown[]) => mockEnsureSession(...args),
  findSessionConversation: (...args: unknown[]) => mockFindSessionConversation(...args),
  provisionSessionSandbox: (...args: unknown[]) => mockProvisionSessionSandbox(...args),
}));
vi.mock('@/lib/agent-sessions/session-shells-runtime', () => ({
  listShells: (...args: unknown[]) => mockListShells(...args),
  spawnShell: (...args: unknown[]) => mockSpawnShell(...args),
}));

import { GET, POST } from '../route';

const AUTH_USER = { userId: 'user-1', role: 'admin' };
const SESSION_ID = 'conv-1';
const ROW = { conversationId: SESSION_ID, ownerId: 'user-1', agentPageId: 'page-1' };
const CONVERSATION = { userId: 'user-1', type: 'page', contextId: 'page-1', isShared: false };
const SHELL = {
  shellId: 'shell-row-1',
  sessionId: SESSION_ID,
  ownerId: 'user-1',
  name: 'shell-1',
  agentType: 'shell',
  command: null,
  createdAt: '2026-07-28T00:00:00.000Z',
};

const params = { params: Promise.resolve({ sessionId: SESSION_ID }) };
const get = () => GET(new Request(`http://localhost/api/agent-sessions/${SESSION_ID}/shells`), params);
const post = (body?: unknown) =>
  POST(
    new Request(`http://localhost/api/agent-sessions/${SESSION_ID}/shells`, {
      method: 'POST',
      ...(body !== undefined
        ? { body: JSON.stringify(body), headers: { 'content-type': 'application/json' } }
        : {}),
    }),
    params,
  );

beforeEach(() => {
  vi.clearAllMocks();
  mockAuthenticateRequest.mockResolvedValue(AUTH_USER);
  mockCheckSessionAccess.mockResolvedValue({ allowed: true });
  mockCheckAccessForSubject.mockResolvedValue({ allowed: true });
  mockFindSessionConversation.mockResolvedValue(CONVERSATION);
  mockEnsureSession.mockResolvedValue({ ok: true, session: ROW });
  mockProvisionSessionSandbox.mockResolvedValue({ ok: true, sandboxId: 'sb-1', resumed: true });
  mockListShells.mockResolvedValue([SHELL]);
  mockSpawnShell.mockResolvedValue({ ok: true, shell: SHELL });
});

describe('GET /api/agent-sessions/[sessionId]/shells', () => {
  it('given an accessible session, should list its shells', async () => {
    const response = await get();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ shells: [SHELL] });
  });

  it('given a session with no row yet, should answer an EMPTY list, not an error', async () => {
    mockCheckSessionAccess.mockResolvedValue({ allowed: false, reason: 'session_not_found' });
    const response = await get();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ shells: [] });
    expect(mockListShells).not.toHaveBeenCalled();
  });

  it('given a denial, should 403 and audit', async () => {
    mockCheckSessionAccess.mockResolvedValue({ allowed: false, reason: 'code_execution_denied' });
    const response = await get();
    expect(response.status).toBe(403);
    expect(mockListShells).not.toHaveBeenCalled();
    expect(mockAuditRequest).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ eventType: 'authz.access.denied' }),
    );
  });
});

describe('POST /api/agent-sessions/[sessionId]/shells', () => {
  it('given a cold session, should ensure + provision the sandbox BEFORE spawning', async () => {
    const order: string[] = [];
    mockProvisionSessionSandbox.mockImplementation(async () => {
      order.push('provision');
      return { ok: true, sandboxId: 'sb-1', resumed: false };
    });
    mockSpawnShell.mockImplementation(async () => {
      order.push('spawn');
      return { ok: true, shell: SHELL };
    });

    const response = await post({});
    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({ shell: SHELL });
    expect(order).toEqual(['provision', 'spawn']);
    expect(mockSpawnShell).toHaveBeenCalledWith({ sessionId: SESSION_ID, ownerId: 'user-1', name: undefined });
  });

  it('given a requested name, should pass it through for the pure planner to validate', async () => {
    await post({ name: 'build' });
    expect(mockSpawnShell).toHaveBeenCalledWith({ sessionId: SESSION_ID, ownerId: 'user-1', name: 'build' });
  });

  it('given no body at all, should still spawn with an auto-label', async () => {
    const response = await post();
    expect(response.status).toBe(201);
    expect(mockSpawnShell).toHaveBeenCalledWith({ sessionId: SESSION_ID, ownerId: 'user-1', name: undefined });
  });

  it('given a non-string name, should 400 before touching anything', async () => {
    const response = await post({ name: 42 });
    expect(response.status).toBe(400);
    expect(mockProvisionSessionSandbox).not.toHaveBeenCalled();
    expect(mockSpawnShell).not.toHaveBeenCalled();
  });

  it('given a missing conversation, should 404 and never provision', async () => {
    mockFindSessionConversation.mockResolvedValue(null);
    const response = await post({});
    expect(response.status).toBe(404);
    expect(mockProvisionSessionSandbox).not.toHaveBeenCalled();
  });

  it('given an access denial, should 403 and never provision or spawn', async () => {
    mockCheckAccessForSubject.mockResolvedValue({ allowed: false, reason: 'not_shared' });
    const response = await post({});
    expect(response.status).toBe(403);
    expect(mockEnsureSession).not.toHaveBeenCalled();
    expect(mockProvisionSessionSandbox).not.toHaveBeenCalled();
    expect(mockSpawnShell).not.toHaveBeenCalled();
  });

  it('given a taken name, should 409 with the reason token', async () => {
    mockSpawnShell.mockResolvedValue({ ok: false, reason: 'name_taken' });
    const response = await post({ name: 'build' });
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual(expect.objectContaining({ reason: 'name_taken' }));
  });

  it('given an invalid name, should 400 with the reason token', async () => {
    mockSpawnShell.mockResolvedValue({ ok: false, reason: 'invalid_name' });
    const response = await post({ name: '-bad' });
    expect(response.status).toBe(400);
  });

  it('given a provisioning failure, should 502 and never spawn a row pointing at nothing', async () => {
    mockProvisionSessionSandbox.mockResolvedValue({ ok: false, reason: 'provision_failed' });
    const response = await post({});
    expect(response.status).toBe(502);
    expect(mockSpawnShell).not.toHaveBeenCalled();
  });
});
