import { describe, it, expect, beforeEach, vi } from 'vitest';

/**
 * /api/machines/git-blob request contract tests.
 *
 * Everything IO — auth, access check, handle resolution, the git-blob
 * primitive — is mocked so the tests isolate the route's own request
 * handling: required-param validation, authz-before-parsing ordering, and the
 * result → status-code mapping (invalid_ref → 400, not_found → 404,
 * exec_failed → 502).
 */

vi.mock('@pagespace/lib/services/machines/machine-branches', () => ({ BRANCH_REPO_PATH: '/workspace/repo' }));

vi.mock('@/lib/auth', () => ({
  authenticateRequestWithOptions: vi.fn(async () => ({ userId: 'user-1' })),
  isAuthError: vi.fn(() => false),
}));

type HandleResult =
  | { ok: true; handle: { machineId: string } }
  | { ok: false; reason: 'not_found' | 'vanished' };

const canViewMachine = vi.fn(async () => true);
const resolveBranchMachineHandle = vi.fn(
  async (): Promise<HandleResult> => ({ ok: true, handle: { machineId: 'sbx-1' } }),
);
const resolveMachineActorContext = vi.fn(async () => ({
  userId: 'user-1',
  tenantId: 'user-1',
  actorEmail: 'user-1@example.com',
  tier: 'pro' as const,
}));
const buildGitBlobActorContext = vi.fn(() => ({ conversationId: 'scope' }));
const buildGitBlobDepsForHandle = vi.fn(() => ({}));

vi.mock('@/lib/machines/machine-git-blob-runtime', () => ({
  canViewMachine: (...args: unknown[]) => canViewMachine(...(args as [])),
  resolveBranchMachineHandle: (...args: unknown[]) => resolveBranchMachineHandle(...(args as [])),
  resolveMachineActorContext: (...args: unknown[]) => resolveMachineActorContext(...(args as [])),
  buildGitBlobActorContext: (...args: unknown[]) => buildGitBlobActorContext(...(args as [])),
  buildGitBlobDepsForHandle: (...args: unknown[]) => buildGitBlobDepsForHandle(...(args as [])),
}));

type GitBlobResult =
  | { ok: true; content: string; truncated: boolean }
  | { ok: false; reason: 'not_found' | 'invalid_ref' | 'exec_failed'; detail?: string };

const readMachineGitBlob = vi.fn(async (): Promise<GitBlobResult> => ({ ok: true, content: 'file body', truncated: false }));
vi.mock('@pagespace/lib/services/sandbox/machine-git-blob', () => ({
  readMachineGitBlob: (...args: unknown[]) => readMachineGitBlob(...(args as [])),
}));

import { GET } from '../route';

function get(query: Record<string, string>): Request {
  const params = new URLSearchParams({
    terminalId: 't1',
    projectName: 'p1',
    branchName: 'b1',
    ref: 'origin/master',
    path: 'src/index.ts',
    ...query,
  });
  return new Request(`http://localhost/api/machines/git-blob?${params.toString()}`);
}

beforeEach(() => {
  vi.clearAllMocks();
  canViewMachine.mockResolvedValue(true);
  resolveBranchMachineHandle.mockResolvedValue({ ok: true, handle: { machineId: 'sbx-1' } });
  resolveMachineActorContext.mockResolvedValue({
    userId: 'user-1',
    tenantId: 'user-1',
    actorEmail: 'user-1@example.com',
    tier: 'pro',
  });
  readMachineGitBlob.mockResolvedValue({ ok: true, content: 'file body', truncated: false });
});

describe('/api/machines/git-blob request contract', () => {
  it('requires terminalId, projectName, branchName, ref, and path', async () => {
    for (const missing of ['terminalId', 'projectName', 'branchName', 'ref', 'path']) {
      const params = new URLSearchParams({
        terminalId: 't1',
        projectName: 'p1',
        branchName: 'b1',
        ref: 'origin/master',
        path: 'src/index.ts',
      });
      params.delete(missing);
      const res = await GET(new Request(`http://localhost/api/machines/git-blob?${params.toString()}`));
      expect(res.status).toBe(400);
    }
    expect(readMachineGitBlob).not.toHaveBeenCalled();
  });

  it('denies a user without view access before checking ref/path or resolving the machine', async () => {
    canViewMachine.mockResolvedValue(false);
    const res = await GET(get({}));
    expect(res.status).toBe(403);
    expect(resolveBranchMachineHandle).not.toHaveBeenCalled();
    expect(readMachineGitBlob).not.toHaveBeenCalled();
  });

  it('returns 404 when the branch machine has no tracking row', async () => {
    resolveBranchMachineHandle.mockResolvedValue({ ok: false, reason: 'not_found' });
    const res = await GET(get({}));
    expect(res.status).toBe(404);
    expect(readMachineGitBlob).not.toHaveBeenCalled();
  });

  it('returns 503 when the branch Sprite has vanished', async () => {
    resolveBranchMachineHandle.mockResolvedValue({ ok: false, reason: 'vanished' });
    const res = await GET(get({}));
    expect(res.status).toBe(503);
  });

  it('reads the blob and returns its content on success', async () => {
    const res = await GET(get({ ref: 'abc123', path: 'src/index.ts' }));
    expect(res.status).toBe(200);
    expect(readMachineGitBlob).toHaveBeenCalledWith(
      expect.objectContaining({ ref: 'abc123', path: 'src/index.ts', cwd: '/workspace/repo' }),
    );
    const body = (await res.json()) as { content: string; truncated: boolean };
    expect(body).toEqual({ content: 'file body', truncated: false });
  });

  it('maps invalid_ref to 400', async () => {
    readMachineGitBlob.mockResolvedValue({ ok: false, reason: 'invalid_ref' });
    const res = await GET(get({ ref: '--output=/tmp/x' }));
    expect(res.status).toBe(400);
  });

  it('maps not_found to 404', async () => {
    readMachineGitBlob.mockResolvedValue({ ok: false, reason: 'not_found', detail: "does not exist in 'HEAD'" });
    const res = await GET(get({}));
    expect(res.status).toBe(404);
  });

  it('maps exec_failed to 502', async () => {
    readMachineGitBlob.mockResolvedValue({ ok: false, reason: 'exec_failed', detail: 'boom' });
    const res = await GET(get({}));
    expect(res.status).toBe(502);
  });
});
