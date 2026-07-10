/**
 * Contract tests for GET/POST/DELETE /api/machines/branches
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const {
  mockAuthenticateRequest,
  mockIsAuthError,
  mockCanAccessMachine,
  mockCanViewMachine,
  mockBuildMachineBranchesDeps,
  mockGetMachineHostForBranches,
  mockResolveMachineActorContext,
  mockCreateDbMachineBranchStore,
  mockSpawnBranch,
  mockKillBranch,
  mockListBranches,
} = vi.hoisted(() => ({
  mockAuthenticateRequest: vi.fn(),
  mockIsAuthError: vi.fn((result: unknown) => result != null && typeof result === 'object' && 'error' in result),
  mockCanAccessMachine: vi.fn(),
  mockCanViewMachine: vi.fn(),
  mockBuildMachineBranchesDeps: vi.fn(),
  mockGetMachineHostForBranches: vi.fn(),
  mockResolveMachineActorContext: vi.fn(),
  mockCreateDbMachineBranchStore: vi.fn(),
  mockSpawnBranch: vi.fn(),
  mockKillBranch: vi.fn(),
  mockListBranches: vi.fn(),
}));

vi.mock('@/lib/auth/request-auth', () => ({
  authenticateRequestWithOptions: (...args: unknown[]) => mockAuthenticateRequest(...args),
}));
vi.mock('@/lib/auth/auth-core', () => ({
  isAuthError: (result: unknown) => mockIsAuthError(result),
}));

vi.mock('@/lib/machines/machine-branches-runtime', () => ({
  buildMachineBranchesDeps: (...args: unknown[]) => mockBuildMachineBranchesDeps(...args),
  canAccessMachine: (...args: unknown[]) => mockCanAccessMachine(...args),
  canViewMachine: (...args: unknown[]) => mockCanViewMachine(...args),
  getMachineHostForBranches: (...args: unknown[]) => mockGetMachineHostForBranches(...args),
  resolveMachineActorContext: (...args: unknown[]) => mockResolveMachineActorContext(...args),
}));

vi.mock('@pagespace/lib/services/machines/machine-branches-store', () => ({
  createDbMachineBranchStore: (...args: unknown[]) => mockCreateDbMachineBranchStore(...args),
}));

vi.mock('@pagespace/lib/services/machines/machine-branches', () => ({
  spawnBranch: (...args: unknown[]) => mockSpawnBranch(...args),
  killBranch: (...args: unknown[]) => mockKillBranch(...args),
  listBranches: (...args: unknown[]) => mockListBranches(...args),
}));

import { GET, POST, DELETE } from '../route';

const AUTH_OK = { userId: 'user-1' };
const AUTH_DENIED = { error: new Response(null, { status: 401 }) };

const FAKE_DEPS = { store: {} } as never;
const FAKE_STORE = {} as never;
const FAKE_HOST = {} as never;

beforeEach(() => {
  vi.clearAllMocks();
  mockAuthenticateRequest.mockResolvedValue(AUTH_OK);
  mockBuildMachineBranchesDeps.mockReturnValue(FAKE_DEPS);
  mockCreateDbMachineBranchStore.mockResolvedValue(FAKE_STORE);
  mockGetMachineHostForBranches.mockResolvedValue(FAKE_HOST);
  mockResolveMachineActorContext.mockResolvedValue({ userId: 'user-1', tenantId: 'user-1', actorEmail: 'u1@example.com', tier: 'pro' });
});

describe('GET /api/machines/branches', () => {
  it('given no auth, returns the auth error', async () => {
    mockAuthenticateRequest.mockResolvedValue(AUTH_DENIED);
    const res = await GET(new Request('https://x.test/api/machines/branches?terminalId=term-1&projectName=repo'));
    expect(res.status).toBe(401);
  });

  it('given view access to the machine, lists its branches', async () => {
    mockCanViewMachine.mockResolvedValue(true);
    mockListBranches.mockResolvedValue([{ branchName: 'main', createdAt: new Date('2026-01-01') }]);
    const res = await GET(new Request('https://x.test/api/machines/branches?terminalId=term-1&projectName=repo'));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.branches).toHaveLength(1);
    expect(mockCanViewMachine).toHaveBeenCalledWith('user-1', 'term-1');
    expect(mockListBranches).toHaveBeenCalledWith(
      expect.objectContaining({ terminalId: 'term-1', projectName: 'repo' }),
    );
  });

  it('given no terminalId, returns 400', async () => {
    const res = await GET(new Request('https://x.test/api/machines/branches?projectName=repo'));
    expect(res.status).toBe(400);
  });

  it('given no projectName, returns 400', async () => {
    const res = await GET(new Request('https://x.test/api/machines/branches?terminalId=term-1'));
    expect(res.status).toBe(400);
  });

  it('given no view access, returns 403 without listing', async () => {
    mockCanViewMachine.mockResolvedValue(false);
    const res = await GET(new Request('https://x.test/api/machines/branches?terminalId=term-1&projectName=repo'));
    expect(res.status).toBe(403);
    expect(mockListBranches).not.toHaveBeenCalled();
  });
});

describe('POST /api/machines/branches', () => {
  function req(body: unknown) {
    return new Request('https://x.test/api/machines/branches', {
      method: 'POST',
      body: JSON.stringify(body),
      headers: { 'content-type': 'application/json' },
    });
  }

  it('given no edit access to the machine, returns 403 without spawning', async () => {
    mockCanAccessMachine.mockResolvedValue(false);
    const res = await POST(req({ terminalId: 't1', projectName: 'repo', branchName: 'main' }));
    expect(res.status).toBe(403);
    expect(mockSpawnBranch).not.toHaveBeenCalled();
  });

  it('given a fresh spawn, returns 201', async () => {
    mockCanAccessMachine.mockResolvedValue(true);
    mockSpawnBranch.mockResolvedValue({ ok: true, sandboxId: 'sbx-1', resumed: false });
    const res = await POST(req({ terminalId: 't1', projectName: 'repo', branchName: 'main' }));
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.branch).toMatchObject({ branchName: 'main', resumed: false });
    expect(mockSpawnBranch).toHaveBeenCalledWith(
      expect.objectContaining({ terminalId: 't1', projectName: 'repo', branchName: 'main' }),
    );
  });

  it('given a resumed spawn, returns 200', async () => {
    mockCanAccessMachine.mockResolvedValue(true);
    mockSpawnBranch.mockResolvedValue({ ok: true, sandboxId: 'sbx-1', resumed: true });
    const res = await POST(req({ terminalId: 't1', projectName: 'repo', branchName: 'main' }));
    expect(res.status).toBe(200);
  });

  it('given no such project, returns 404', async () => {
    mockCanAccessMachine.mockResolvedValue(true);
    mockSpawnBranch.mockResolvedValue({ ok: false, reason: 'project_not_found' });
    const res = await POST(req({ terminalId: 't1', projectName: 'nope', branchName: 'main' }));
    expect(res.status).toBe(404);
  });

  it('given a clone failure, returns 502', async () => {
    mockCanAccessMachine.mockResolvedValue(true);
    mockSpawnBranch.mockResolvedValue({ ok: false, reason: 'clone_failed', detail: 'fatal: repository not found' });
    const res = await POST(req({ terminalId: 't1', projectName: 'repo', branchName: 'main' }));
    expect(res.status).toBe(502);
  });

  it('given a missing branchName, returns 400 without checking access', async () => {
    const res = await POST(req({ terminalId: 't1', projectName: 'repo' }));
    expect(res.status).toBe(400);
    expect(mockCanAccessMachine).not.toHaveBeenCalled();
  });

  it('given no terminalId, returns 400', async () => {
    const res = await POST(req({ projectName: 'repo', branchName: 'main' }));
    expect(res.status).toBe(400);
  });
});

describe('DELETE /api/machines/branches', () => {
  it('given no edit access, returns 403 without killing', async () => {
    mockCanAccessMachine.mockResolvedValue(false);
    const res = await DELETE(
      new Request('https://x.test/api/machines/branches?terminalId=t1&projectName=repo&branchName=main', { method: 'DELETE' }),
    );
    expect(res.status).toBe(403);
    expect(mockKillBranch).not.toHaveBeenCalled();
  });

  it('given the branch does not exist, returns 404', async () => {
    mockCanAccessMachine.mockResolvedValue(true);
    mockKillBranch.mockResolvedValue({ ok: false, reason: 'not_found' });
    const res = await DELETE(
      new Request('https://x.test/api/machines/branches?terminalId=t1&projectName=repo&branchName=main', { method: 'DELETE' }),
    );
    expect(res.status).toBe(404);
  });

  it('given a successful kill, returns 200', async () => {
    mockCanAccessMachine.mockResolvedValue(true);
    mockKillBranch.mockResolvedValue({ ok: true });
    const res = await DELETE(
      new Request('https://x.test/api/machines/branches?terminalId=t1&projectName=repo&branchName=main', { method: 'DELETE' }),
    );
    expect(res.status).toBe(200);
    expect(mockKillBranch).toHaveBeenCalledWith(
      expect.objectContaining({ terminalId: 't1', projectName: 'repo', branchName: 'main' }),
    );
  });

  it('given no branchName, returns 400', async () => {
    const res = await DELETE(new Request('https://x.test/api/machines/branches?terminalId=t1&projectName=repo', { method: 'DELETE' }));
    expect(res.status).toBe(400);
  });

  it('given no terminalId, returns 400', async () => {
    const res = await DELETE(new Request('https://x.test/api/machines/branches?projectName=repo&branchName=main', { method: 'DELETE' }));
    expect(res.status).toBe(400);
  });
});
