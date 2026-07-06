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
    const res = await GET(new Request('https://x.test/api/machines/projects?terminalId=term-1'));
    expect(res.status).toBe(401);
  });

  it('given view access to the machine, lists its projects', async () => {
    mockCanViewMachine.mockResolvedValue(true);
    mockListProjects.mockResolvedValue([
      { name: 'repo-a', repoUrl: 'https://github.com/o/a.git', path: '/workspace/projects/repo-a', createdAt: new Date('2026-01-01') },
    ]);
    const res = await GET(new Request('https://x.test/api/machines/projects?terminalId=term-1'));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.projects).toHaveLength(1);
    expect(mockCanViewMachine).toHaveBeenCalledWith('user-1', 'term-1');
    expect(mockListProjects).toHaveBeenCalledWith(expect.objectContaining({ terminalId: 'term-1' }));
  });

  it('given no terminalId, returns 400', async () => {
    const res = await GET(new Request('https://x.test/api/machines/projects'));
    expect(res.status).toBe(400);
  });

  it('given no view access, returns 403 without listing', async () => {
    mockCanViewMachine.mockResolvedValue(false);
    const res = await GET(new Request('https://x.test/api/machines/projects?terminalId=term-1'));
    expect(res.status).toBe(403);
    expect(mockListProjects).not.toHaveBeenCalled();
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

  it('given no edit access to the machine, returns 403 without cloning', async () => {
    mockCanAccessMachine.mockResolvedValue(false);
    const res = await POST(req({ terminalId: 't1', name: 'repo', repoUrl: 'https://github.com/o/r.git' }));
    expect(res.status).toBe(403);
    expect(mockAddProject).not.toHaveBeenCalled();
  });

  it('given a successful clone, returns 201 with the project', async () => {
    mockCanAccessMachine.mockResolvedValue(true);
    mockAddProject.mockResolvedValue({
      ok: true,
      project: { name: 'repo', repoUrl: 'https://github.com/o/r.git', path: '/workspace/projects/repo' },
    });
    const res = await POST(req({ terminalId: 't1', name: 'repo', repoUrl: 'https://github.com/o/r.git' }));
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.project.name).toBe('repo');
    expect(mockAddProject).toHaveBeenCalledWith(expect.objectContaining({ terminalId: 't1', name: 'repo' }));
  });

  it('given a duplicate name, returns 409', async () => {
    mockCanAccessMachine.mockResolvedValue(true);
    mockAddProject.mockResolvedValue({ ok: false, reason: 'duplicate_name' });
    const res = await POST(req({ terminalId: 't1', name: 'repo', repoUrl: 'https://github.com/o/r.git' }));
    expect(res.status).toBe(409);
  });

  it('given a clone failure, returns 502', async () => {
    mockCanAccessMachine.mockResolvedValue(true);
    mockAddProject.mockResolvedValue({ ok: false, reason: 'clone_failed', detail: 'fatal: repository not found' });
    const res = await POST(req({ terminalId: 't1', name: 'repo', repoUrl: 'https://github.com/o/r.git' }));
    expect(res.status).toBe(502);
  });

  it('given a missing name/repoUrl, returns 400 without checking access', async () => {
    const res = await POST(req({ terminalId: 't1', name: 'repo' }));
    expect(res.status).toBe(400);
    expect(mockCanAccessMachine).not.toHaveBeenCalled();
  });

  it('given no terminalId, returns 400', async () => {
    const res = await POST(req({ name: 'repo', repoUrl: 'https://github.com/o/r.git' }));
    expect(res.status).toBe(400);
  });
});

describe('DELETE /api/machines/projects', () => {
  it('given no edit access, returns 403 without removing', async () => {
    mockCanAccessMachine.mockResolvedValue(false);
    const res = await DELETE(new Request('https://x.test/api/machines/projects?terminalId=t1&name=repo', { method: 'DELETE' }));
    expect(res.status).toBe(403);
    expect(mockRemoveProject).not.toHaveBeenCalled();
  });

  it('given the project does not exist, returns 404', async () => {
    mockCanAccessMachine.mockResolvedValue(true);
    mockRemoveProject.mockResolvedValue({ ok: false, reason: 'not_found' });
    const res = await DELETE(new Request('https://x.test/api/machines/projects?terminalId=t1&name=repo', { method: 'DELETE' }));
    expect(res.status).toBe(404);
  });

  it('given a successful removal, returns 200', async () => {
    mockCanAccessMachine.mockResolvedValue(true);
    mockRemoveProject.mockResolvedValue({ ok: true });
    const res = await DELETE(new Request('https://x.test/api/machines/projects?terminalId=t1&name=repo', { method: 'DELETE' }));
    expect(res.status).toBe(200);
    expect(mockRemoveProject).toHaveBeenCalledWith(expect.objectContaining({ terminalId: 't1', name: 'repo' }));
  });

  it('given no name, returns 400', async () => {
    const res = await DELETE(new Request('https://x.test/api/machines/projects?terminalId=t1', { method: 'DELETE' }));
    expect(res.status).toBe(400);
  });

  it('given no terminalId, returns 400', async () => {
    const res = await DELETE(new Request('https://x.test/api/machines/projects?name=repo', { method: 'DELETE' }));
    expect(res.status).toBe(400);
  });
});
