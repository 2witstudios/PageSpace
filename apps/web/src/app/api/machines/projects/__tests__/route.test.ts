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
    const res = await GET(new Request('https://x.test/api/machines/projects?machineId=term-1'));
    expect(res.status).toBe(401);
  });

  it('given view access to the machine, lists its projects', async () => {
    mockCanViewMachine.mockResolvedValue(true);
    mockListProjects.mockResolvedValue([
      { name: 'repo-a', repoUrl: 'https://github.com/o/a.git', path: '/workspace/projects/repo-a', createdAt: new Date('2026-01-01') },
    ]);
    const res = await GET(new Request('https://x.test/api/machines/projects?machineId=term-1'));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.projects).toHaveLength(1);
    expect(mockCanViewMachine).toHaveBeenCalledWith('user-1', 'term-1');
    expect(mockListProjects).toHaveBeenCalledWith(expect.objectContaining({ machineId: 'term-1' }));
  });

  it('given no machineId, returns 400', async () => {
    const res = await GET(new Request('https://x.test/api/machines/projects'));
    expect(res.status).toBe(400);
  });

  it('given no view access, returns 403 without listing', async () => {
    mockCanViewMachine.mockResolvedValue(false);
    const res = await GET(new Request('https://x.test/api/machines/projects?machineId=term-1'));
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
    const res = await POST(req({ machineId: 't1', name: 'repo', repoUrl: 'https://github.com/o/r.git' }));
    expect(res.status).toBe(403);
    expect(mockAddProject).not.toHaveBeenCalled();
  });

  it('given a successful clone, returns 201 with the project', async () => {
    mockCanAccessMachine.mockResolvedValue(true);
    mockAddProject.mockResolvedValue({
      ok: true,
      project: { name: 'repo', repoUrl: 'https://github.com/o/r.git', path: '/workspace/projects/repo' },
    });
    const res = await POST(req({ machineId: 't1', name: 'repo', repoUrl: 'https://github.com/o/r.git' }));
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.project.name).toBe('repo');
    expect(mockAddProject).toHaveBeenCalledWith(expect.objectContaining({ machineId: 't1', name: 'repo' }));
  });

  it('given free text, echoes the NORMALIZED name the service persisted — not the raw request text', async () => {
    mockCanAccessMachine.mockResolvedValue(true);
    mockAddProject.mockResolvedValue({
      ok: true,
      project: {
        name: 'my-cool-feature',
        repoUrl: 'https://github.com/o/r.git',
        path: '/workspace/projects/my-cool-feature',
      },
    });

    const res = await POST(req({ machineId: 't1', name: 'My Cool Feature', repoUrl: 'https://github.com/o/r.git' }));

    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.project.name).toBe('my-cool-feature');
    // The raw text goes to the service, which is the authority on normalization.
    expect(mockAddProject).toHaveBeenCalledWith(expect.objectContaining({ name: 'My Cool Feature' }));
  });

  it.each(['', '   ', '..', '.', '//'])(
    'given the nameless name %j, returns 400 rather than cloning into a directory called "project"',
    async (name) => {
      const res = await POST(req({ machineId: 't1', name, repoUrl: 'https://github.com/o/r.git' }));
      expect(res.status).toBe(400);
      expect(mockAddProject).not.toHaveBeenCalled();
    },
  );

  it('given a duplicate name, returns 409', async () => {
    mockCanAccessMachine.mockResolvedValue(true);
    mockAddProject.mockResolvedValue({ ok: false, reason: 'duplicate_name' });
    const res = await POST(req({ machineId: 't1', name: 'repo', repoUrl: 'https://github.com/o/r.git' }));
    expect(res.status).toBe(409);
  });

  it('given a clone failure, returns 502', async () => {
    mockCanAccessMachine.mockResolvedValue(true);
    mockAddProject.mockResolvedValue({ ok: false, reason: 'clone_failed', detail: 'fatal: repository not found' });
    const res = await POST(req({ machineId: 't1', name: 'repo', repoUrl: 'https://github.com/o/r.git' }));
    expect(res.status).toBe(502);
  });

  it('given a missing name/repoUrl, returns 400 without checking access', async () => {
    const res = await POST(req({ machineId: 't1', name: 'repo' }));
    expect(res.status).toBe(400);
    expect(mockCanAccessMachine).not.toHaveBeenCalled();
  });

  it('given no machineId, returns 400', async () => {
    const res = await POST(req({ name: 'repo', repoUrl: 'https://github.com/o/r.git' }));
    expect(res.status).toBe(400);
  });
});

describe('DELETE /api/machines/projects', () => {
  it('given no edit access, returns 403 without removing', async () => {
    mockCanAccessMachine.mockResolvedValue(false);
    const res = await DELETE(new Request('https://x.test/api/machines/projects?machineId=t1&name=repo', { method: 'DELETE' }));
    expect(res.status).toBe(403);
    expect(mockRemoveProject).not.toHaveBeenCalled();
  });

  it('given the project does not exist, returns 404', async () => {
    mockCanAccessMachine.mockResolvedValue(true);
    mockRemoveProject.mockResolvedValue({ ok: false, reason: 'not_found' });
    const res = await DELETE(new Request('https://x.test/api/machines/projects?machineId=t1&name=repo', { method: 'DELETE' }));
    expect(res.status).toBe(404);
  });

  it('given a successful removal, returns 200', async () => {
    mockCanAccessMachine.mockResolvedValue(true);
    mockRemoveProject.mockResolvedValue({ ok: true });
    const res = await DELETE(new Request('https://x.test/api/machines/projects?machineId=t1&name=repo', { method: 'DELETE' }));
    expect(res.status).toBe(200);
    expect(mockRemoveProject).toHaveBeenCalledWith(expect.objectContaining({ machineId: 't1', name: 'repo' }));
  });

  it('given no name, returns 400', async () => {
    const res = await DELETE(new Request('https://x.test/api/machines/projects?machineId=t1', { method: 'DELETE' }));
    expect(res.status).toBe(400);
  });

  it.each(['%20%20%20', '..', '.', '%2F%2F', '%09'])(
    'given the nameless name %s, returns 400 rather than rm -rf-ing the project called "project"',
    async (encoded) => {
      // `removeProject` normalizes its lookup key, and EVERY nameless string —
      // whitespace, `.`, `..`, `//` — normalizes to the FALLBACK. Without this
      // guard the request would resolve to a real project literally named
      // `project` and delete its checkout. "Nameless" is broader than "blank".
      const res = await DELETE(
        new Request(`https://x.test/api/machines/projects?machineId=t1&name=${encoded}`, { method: 'DELETE' }),
      );
      expect(res.status).toBe(400);
      expect(mockRemoveProject).not.toHaveBeenCalled();
    },
  );

  it('given no machineId, returns 400', async () => {
    const res = await DELETE(new Request('https://x.test/api/machines/projects?name=repo', { method: 'DELETE' }));
    expect(res.status).toBe(400);
  });
});
