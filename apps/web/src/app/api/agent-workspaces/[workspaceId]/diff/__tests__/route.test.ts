// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from 'vitest';

const {
  mockAuthenticateRequest,
  mockAuditRequest,
  mockCheckSessionAccess,
  mockResolveHandle,
  mockListDiffFiles,
  mockReadDiffPair,
} = vi.hoisted(() => ({
  mockAuthenticateRequest: vi.fn(),
  mockAuditRequest: vi.fn(),
  mockCheckSessionAccess: vi.fn(),
  mockResolveHandle: vi.fn(),
  mockListDiffFiles: vi.fn(),
  mockReadDiffPair: vi.fn(),
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
vi.mock('@pagespace/lib/services/sandbox/machine-diff', () => ({
  listMachineDiffFiles: (...args: unknown[]) => mockListDiffFiles(...args),
  readMachineDiffPair: (...args: unknown[]) => mockReadDiffPair(...args),
}));
vi.mock('@/lib/agent-workspaces/agent-sessions-runtime', () => ({
  checkSessionAccess: (...args: unknown[]) => mockCheckSessionAccess(...args),
}));
vi.mock('@/lib/agent-workspaces/session-sandbox-runtime', () => ({
  resolveSessionSandboxHandle: (...args: unknown[]) => mockResolveHandle(...args),
  resolveSessionActorContext: vi.fn(async () => ({ userId: 'user-1', tenantId: 'user-1', actorEmail: 'a@b.c', tier: 'free' })),
  buildSessionReadActorCtx: vi.fn((scopeKey: string) => ({ conversationId: scopeKey })),
  buildSessionGitDepsForHandle: vi.fn(() => ({ deps: true })),
}));

import { GET } from '../route';

const AUTH_USER = { userId: 'user-1', role: 'admin' };
const SESSION_ID = 'conv-1';
const HANDLE = { sandboxId: 'sb-1' };
const params = { params: Promise.resolve({ workspaceId: SESSION_ID }) };
const get = (query: string) =>
  GET(new Request(`http://localhost/api/agent-workspaces/${SESSION_ID}/diff${query}`), params);

beforeEach(() => {
  vi.clearAllMocks();
  mockAuthenticateRequest.mockResolvedValue(AUTH_USER);
  mockCheckSessionAccess.mockResolvedValue({ allowed: true });
  mockResolveHandle.mockResolvedValue({ ok: true, handle: HANDLE });
  mockListDiffFiles.mockResolvedValue({ ok: true, notApplicable: false, files: [], truncated: false, mergeBase: 'sha' });
  mockReadDiffPair.mockResolvedValue({ ok: true, notApplicable: false, original: 'a', modified: 'b' });
});

describe('GET /api/agent-workspaces/[workspaceId]/diff', () => {
  it('should list changed files for a repo the CALLER names, cwd confined under the sandbox root', async () => {
    const response = await get('?repoPath=my-clone&branchName=feature&scope=uncommitted');
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      notApplicable: false,
      scope: 'uncommitted',
      files: [],
      truncated: false,
      mergeBase: 'sha',
    });
    expect(mockListDiffFiles).toHaveBeenCalledWith(
      expect.objectContaining({ cwd: '/workspace/my-clone', branchName: 'feature' }),
    );
  });

  it('given a main-branch committed scope, should answer notApplicable WITHOUT resolving the sandbox', async () => {
    const response = await get('?repoPath=my-clone&branchName=main&scope=committed');
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ notApplicable: true });
    expect(mockResolveHandle).not.toHaveBeenCalled();
  });

  it('given a repoPath escape, should 400', async () => {
    const response = await get('?repoPath=../..&branchName=feature&scope=uncommitted');
    expect(response.status).toBe(400);
  });

  it('given a path escape out of the repo, should 400', async () => {
    const response = await get('?repoPath=clone&branchName=feature&scope=uncommitted&path=../other');
    expect(response.status).toBe(400);
    expect(mockReadDiffPair).not.toHaveBeenCalled();
  });

  it('given a missing repoPath, should 400 (a session has no implicit checkout)', async () => {
    const response = await get('?branchName=feature&scope=uncommitted');
    expect(response.status).toBe(400);
  });

  it('should read one file\'s diff pair when path is present', async () => {
    const response = await get('?repoPath=clone&branchName=feature&scope=uncommitted&path=src/a.ts');
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      notApplicable: false,
      scope: 'uncommitted',
      path: 'src/a.ts',
      original: 'a',
      modified: 'b',
    });
    expect(mockReadDiffPair).toHaveBeenCalledWith(
      expect.objectContaining({ workingTreePath: '/workspace/clone/src/a.ts', cwd: '/workspace/clone' }),
    );
  });

  it('given an access denial, should answer not_started 404 (SAME as not-found, review #2261/5) before parsing scope params, and audit', async () => {
    mockCheckSessionAccess.mockResolvedValue({ allowed: false, reason: 'code_execution_denied' });
    const response = await get('?bogus=1');
    expect(response.status).toBe(404);
    expect((await response.json()).reason).toBe('not_started');
    expect(mockAuditRequest).toHaveBeenCalled();
  });

  it('given no sandbox, should answer not_started 404', async () => {
    mockResolveHandle.mockResolvedValue({ ok: false, reason: 'not_started' });
    const response = await get('?repoPath=clone&branchName=feature&scope=uncommitted');
    expect(response.status).toBe(404);
  });
});
