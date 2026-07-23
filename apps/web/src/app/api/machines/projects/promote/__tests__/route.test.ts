/**
 * Contract tests for POST /api/machines/projects/promote
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const {
  mockAuthenticateRequest,
  mockIsAuthError,
  mockCanAccessMachine,
  mockBuildPromoteProjectDeps,
  mockResolveMachineActorContext,
  mockPromoteProject,
} = vi.hoisted(() => ({
  mockAuthenticateRequest: vi.fn(),
  mockIsAuthError: vi.fn((result: unknown) => result != null && typeof result === 'object' && 'error' in result),
  mockCanAccessMachine: vi.fn(),
  mockBuildPromoteProjectDeps: vi.fn(),
  mockResolveMachineActorContext: vi.fn(),
  mockPromoteProject: vi.fn(),
}));

vi.mock('@/lib/auth', () => ({
  authenticateRequestWithOptions: (...args: unknown[]) => mockAuthenticateRequest(...args),
  isAuthError: (result: unknown) => mockIsAuthError(result),
}));

vi.mock('@/lib/machines/machine-projects-runtime', () => ({
  buildPromoteProjectDeps: (...args: unknown[]) => mockBuildPromoteProjectDeps(...args),
  canAccessMachine: (...args: unknown[]) => mockCanAccessMachine(...args),
  resolveMachineActorContext: (...args: unknown[]) => mockResolveMachineActorContext(...args),
}));

vi.mock('@pagespace/lib/services/machines/machine-project-promotion', () => ({
  promoteProject: (...args: unknown[]) => mockPromoteProject(...args),
}));

import { POST } from '../route';

const AUTH_OK = { userId: 'user-1' };
const AUTH_DENIED = { error: new Response(null, { status: 401 }) };

function post(body: unknown) {
  return new Request('https://x.test/api/machines/projects/promote', {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockAuthenticateRequest.mockResolvedValue(AUTH_OK);
  mockBuildPromoteProjectDeps.mockReturnValue({} as never);
  mockResolveMachineActorContext.mockResolvedValue({ userId: 'user-1', tenantId: 'user-1', actorEmail: 'u1@example.com', tier: 'pro' });
  mockCanAccessMachine.mockResolvedValue(true);
});

describe('POST /api/machines/projects/promote', () => {
  it('given no auth, returns the auth error', async () => {
    mockAuthenticateRequest.mockResolvedValue(AUTH_DENIED);
    expect((await POST(post({ machineId: 'm-1', name: 'repo' }))).status).toBe(401);
  });

  it('given no EDIT access to the machine, denies with 403 and never promotes', async () => {
    mockCanAccessMachine.mockResolvedValue(false);
    const res = await POST(post({ machineId: 'm-1', name: 'repo' }));
    expect(res.status).toBe(403);
    expect(mockPromoteProject).not.toHaveBeenCalled();
  });

  it('given a nameless name, returns 400 without promoting', async () => {
    const res = await POST(post({ machineId: 'm-1', name: '   ' }));
    expect(res.status).toBe(400);
    expect(mockPromoteProject).not.toHaveBeenCalled();
  });

  it('given a successful promotion, returns the new sandboxId and promoted:true', async () => {
    mockPromoteProject.mockResolvedValue({ ok: true, sandboxId: 'sbx-p1', sessionKey: 'pgs-prj-x', promoted: true, resumed: false });
    const res = await POST(post({ machineId: 'm-1', name: 'repo' }));
    expect(res.status).toBe(200);
    // Exactly these three fields: the `sessionKey` is a server-held HMAC Sprite
    // name and is deliberately NOT echoed to a client.
    expect(await res.json()).toEqual({ sandboxId: 'sbx-p1', promoted: true, resumed: false });
  });

  it('given a DIRTY checkout, returns 409 with the actionable detail', async () => {
    mockPromoteProject.mockResolvedValue({ ok: false, reason: 'dirty_checkout', detail: 'commit or discard: M src/index.ts' });
    const res = await POST(post({ machineId: 'm-1', name: 'repo' }));
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'commit or discard: M src/index.ts', reason: 'dirty_checkout' });
  });

  it('given an unknown project, returns 404', async () => {
    mockPromoteProject.mockResolvedValue({ ok: false, reason: 'project_not_found' });
    expect((await POST(post({ machineId: 'm-1', name: 'repo' }))).status).toBe(404);
  });

  it('given the kill switch off, returns 503', async () => {
    mockPromoteProject.mockResolvedValue({ ok: false, reason: 'kill_switch_off' });
    expect((await POST(post({ machineId: 'm-1', name: 'repo' }))).status).toBe(503);
  });
});
