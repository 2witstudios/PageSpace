/**
 * Contract tests for GET/POST/DELETE /api/machines/projects
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const {
  mockAuthenticateRequest,
  mockIsAuthError,
  mockCanAccessMachine,
  mockCanViewMachine,
  mockBuildMachineProjectsDeps,
  mockResolveMachineActorContext,
  mockAddProject,
  mockListProjects,
  mockRemoveProject,
} = vi.hoisted(() => ({
  mockAuthenticateRequest: vi.fn(),
  mockIsAuthError: vi.fn((result: unknown) => result != null && typeof result === 'object' && 'error' in result),
  mockCanAccessMachine: vi.fn(),
  mockCanViewMachine: vi.fn(),
  mockBuildMachineProjectsDeps: vi.fn(),
  mockResolveMachineActorContext: vi.fn(),
  mockAddProject: vi.fn(),
  mockListProjects: vi.fn(),
  mockRemoveProject: vi.fn(),
}));

vi.mock('@/lib/auth', () => ({
  authenticateRequestWithOptions: (...args: unknown[]) => mockAuthenticateRequest(...args),
  isAuthError: (result: unknown) => mockIsAuthError(result),
}));

vi.mock('@/lib/machines/machine-projects-runtime', () => ({
  buildMachineProjectsDeps: (...args: unknown[]) => mockBuildMachineProjectsDeps(...args),
  canAccessMachine: (...args: unknown[]) => mockCanAccessMachine(...args),
  canViewMachine: (...args: unknown[]) => mockCanViewMachine(...args),
  resolveMachineActorContext: (...args: unknown[]) => mockResolveMachineActorContext(...args),
}));

vi.mock('@pagespace/lib/services/machines/machine-projects', () => ({
  addProject: (...args: unknown[]) => mockAddProject(...args),
  listProjects: (...args: unknown[]) => mockListProjects(...args),
  removeProject: (...args: unknown[]) => mockRemoveProject(...args),
}));

import { GET, POST, DELETE } from '../route';

const AUTH_OK = { userId: 'user-1' };
const AUTH_DENIED = { error: new Response(null, { status: 401 }) };

const FAKE_DEPS = { store: {} } as never;

beforeEach(() => {
  vi.clearAllMocks();
  mockAuthenticateRequest.mockResolvedValue(AUTH_OK);
  mockBuildMachineProjectsDeps.mockReturnValue(FAKE_DEPS);
  mockResolveMachineActorContext.mockResolvedValue({ userId: 'user-1', tenantId: 'user-1', actorEmail: 'u1@example.com', tier: 'pro' });
});

describe('GET /api/machines/projects', () => {
  it('given no auth, returns the auth error', async () => {
    mockAuthenticateRequest.mockResolvedValue(AUTH_DENIED);
    const res = await GET(new Request('https://x.test/api/machines/projects?kind=own'));
    expect(res.status).toBe(401);
  });

  it('given kind=own, lists the caller\'s own machine without an access check on another resource', async () => {
    mockCanViewMachine.mockResolvedValue(true);
    mockListProjects.mockResolvedValue([
      { name: 'repo-a', repoUrl: 'https://github.com/o/a.git', path: '/workspace/projects/repo-a', createdAt: new Date('2026-01-01') },
    ]);
    const res = await GET(new Request('https://x.test/api/machines/projects?kind=own'));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.projects).toHaveLength(1);
    expect(mockCanViewMachine).toHaveBeenCalledWith('user-1', { kind: 'own', ownerId: 'user-1' });
  });

  it('given kind=existing without terminalId, returns 400', async () => {
    const res = await GET(new Request('https://x.test/api/machines/projects?kind=existing'));
    expect(res.status).toBe(400);
  });

  it('given kind=existing and no view access, returns 403 without listing', async () => {
    mockCanViewMachine.mockResolvedValue(false);
    const res = await GET(new Request('https://x.test/api/machines/projects?kind=existing&terminalId=term-1'));
    expect(res.status).toBe(403);
    expect(mockListProjects).not.toHaveBeenCalled();
  });

  it('given an invalid kind, returns 400', async () => {
    const res = await GET(new Request('https://x.test/api/machines/projects?kind=bogus'));
    expect(res.status).toBe(400);
  });
});

describe('POST /api/machines/projects', () => {
  function req(body: unknown) {
    return new Request('https://x.test/api/machines/projects', {
      method: 'POST',
      body: JSON.stringify(body),
      headers: { 'content-type': 'application/json' },
    });
  }

  it('given no edit access on an existing machine, returns 403 without cloning', async () => {
    mockCanAccessMachine.mockResolvedValue(false);
    const res = await POST(req({ kind: 'existing', terminalId: 't1', name: 'repo', repoUrl: 'https://github.com/o/r.git' }));
    expect(res.status).toBe(403);
    expect(mockAddProject).not.toHaveBeenCalled();
  });

  it('given a successful clone, returns 201 with the project', async () => {
    mockCanAccessMachine.mockResolvedValue(true);
    mockAddProject.mockResolvedValue({
      ok: true,
      project: { name: 'repo', repoUrl: 'https://github.com/o/r.git', path: '/workspace/projects/repo' },
    });
    const res = await POST(req({ kind: 'own', name: 'repo', repoUrl: 'https://github.com/o/r.git' }));
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.project.name).toBe('repo');
  });

  it('given a duplicate name, returns 409', async () => {
    mockCanAccessMachine.mockResolvedValue(true);
    mockAddProject.mockResolvedValue({ ok: false, reason: 'duplicate_name' });
    const res = await POST(req({ kind: 'own', name: 'repo', repoUrl: 'https://github.com/o/r.git' }));
    expect(res.status).toBe(409);
  });

  it('given a clone failure, returns 502', async () => {
    mockCanAccessMachine.mockResolvedValue(true);
    mockAddProject.mockResolvedValue({ ok: false, reason: 'clone_failed', detail: 'fatal: repository not found' });
    const res = await POST(req({ kind: 'own', name: 'repo', repoUrl: 'https://github.com/o/r.git' }));
    expect(res.status).toBe(502);
  });

  it('given a missing name/repoUrl, returns 400 without checking access', async () => {
    const res = await POST(req({ kind: 'own', name: 'repo' }));
    expect(res.status).toBe(400);
    expect(mockCanAccessMachine).not.toHaveBeenCalled();
  });
});

describe('DELETE /api/machines/projects', () => {
  it('given no edit access, returns 403 without removing', async () => {
    mockCanAccessMachine.mockResolvedValue(false);
    const res = await DELETE(new Request('https://x.test/api/machines/projects?kind=own&name=repo', { method: 'DELETE' }));
    expect(res.status).toBe(403);
    expect(mockRemoveProject).not.toHaveBeenCalled();
  });

  it('given the project does not exist, returns 404', async () => {
    mockCanAccessMachine.mockResolvedValue(true);
    mockRemoveProject.mockResolvedValue({ ok: false, reason: 'not_found' });
    const res = await DELETE(new Request('https://x.test/api/machines/projects?kind=own&name=repo', { method: 'DELETE' }));
    expect(res.status).toBe(404);
  });

  it('given a successful removal, returns 200', async () => {
    mockCanAccessMachine.mockResolvedValue(true);
    mockRemoveProject.mockResolvedValue({ ok: true });
    const res = await DELETE(new Request('https://x.test/api/machines/projects?kind=own&name=repo', { method: 'DELETE' }));
    expect(res.status).toBe(200);
  });

  it('given no name, returns 400', async () => {
    const res = await DELETE(new Request('https://x.test/api/machines/projects?kind=own', { method: 'DELETE' }));
    expect(res.status).toBe(400);
  });
});
