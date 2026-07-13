import { describe, it, expect, beforeEach, vi } from 'vitest';

/**
 * /api/machines/diff request contract tests.
 *
 * Everything IO — auth, access check, handle resolution, the diff service —
 * is mocked so the tests isolate the route's own request handling:
 * required-param validation, authz-before-parsing ordering, the EXPLICIT
 * 200 `{ notApplicable: true }` answer for main-branch committed/branch
 * scopes (returned before the machine handle is even resolved), the
 * path-confinement gate on the pair form, and the result → status-code
 * mapping (exec_failed / merge_base_failed → 502).
 *
 * The pure scope module (`machine-diff-scope.ts`) is intentionally NOT
 * mocked — the route's notApplicable short-circuit runs the real
 * `resolveDiffScope`/`isMainBranchName`, as does the real
 * `resolvePathWithinSync` confinement helper.
 */

vi.mock('@pagespace/lib/services/machines/machine-branches', () => ({ BRANCH_REPO_PATH: '/workspace/repo' }));

vi.mock('@/lib/auth', () => ({
  authenticateRequestWithOptions: vi.fn(async () => ({ userId: 'user-1' })),
  isAuthError: vi.fn(() => false),
}));

const logApiError = vi.fn();
vi.mock('@pagespace/lib/logging/logger-config', () => ({
  loggers: { api: { error: (...args: unknown[]) => logApiError(...(args as [])) } },
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
const buildDiffActorContext = vi.fn(() => ({ conversationId: 'scope' }));
const buildDiffGitDepsForHandle = vi.fn(() => ({}));

vi.mock('@/lib/machines/machine-diff-runtime', () => ({
  canViewMachine: (...args: unknown[]) => canViewMachine(...(args as [])),
  resolveBranchMachineHandle: (...args: unknown[]) => resolveBranchMachineHandle(...(args as [])),
  resolveMachineActorContext: (...args: unknown[]) => resolveMachineActorContext(...(args as [])),
  buildDiffActorContext: (...args: unknown[]) => buildDiffActorContext(...(args as [])),
  buildDiffGitDepsForHandle: (...args: unknown[]) => buildDiffGitDepsForHandle(...(args as [])),
}));

type ListResult =
  | { ok: true; notApplicable: true }
  | {
      ok: true;
      notApplicable: false;
      files: Array<{ path: string; status: string; previousPath?: string }>;
      truncated: boolean;
      mergeBase: string | null;
    }
  | { ok: false; reason: 'exec_failed' | 'merge_base_failed'; detail?: string };

type PairResult =
  | { ok: true; notApplicable: true }
  | {
      ok: true;
      notApplicable: false;
      original: { content: string; truncated: boolean } | null;
      modified: { content: string; truncated: boolean } | null;
    }
  | { ok: false; reason: 'exec_failed' | 'merge_base_failed'; detail?: string };

const listMachineDiffFiles = vi.fn(
  async (): Promise<ListResult> => ({
    ok: true,
    notApplicable: false,
    files: [{ path: 'src/a.ts', status: 'modified' }],
    truncated: false,
    mergeBase: null,
  }),
);
const readMachineDiffPair = vi.fn(
  async (): Promise<PairResult> => ({
    ok: true,
    notApplicable: false,
    original: { content: 'old', truncated: false },
    modified: { content: 'new', truncated: false },
  }),
);
vi.mock('@pagespace/lib/services/sandbox/machine-diff', () => ({
  listMachineDiffFiles: (...args: unknown[]) => listMachineDiffFiles(...(args as [])),
  readMachineDiffPair: (...args: unknown[]) => readMachineDiffPair(...(args as [])),
}));

import { GET } from '../route';

function get(query: Record<string, string>): Request {
  const params = new URLSearchParams({
    machineId: 't1',
    projectName: 'p1',
    branchName: 'feature/x',
    scope: 'uncommitted',
    ...query,
  });
  return new Request(`http://localhost/api/machines/diff?${params.toString()}`);
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
  listMachineDiffFiles.mockResolvedValue({
    ok: true,
    notApplicable: false,
    files: [{ path: 'src/a.ts', status: 'modified' }],
    truncated: false,
    mergeBase: null,
  });
  readMachineDiffPair.mockResolvedValue({
    ok: true,
    notApplicable: false,
    original: { content: 'old', truncated: false },
    modified: { content: 'new', truncated: false },
  });
});

describe('GET /api/machines/diff — request validation', () => {
  it.each(['machineId', 'projectName', 'branchName'])('400s when %s is missing', async (field) => {
    const params = new URLSearchParams({
      machineId: 't1',
      projectName: 'p1',
      branchName: 'feature/x',
      scope: 'uncommitted',
    });
    params.delete(field);
    const res = await GET(new Request(`http://localhost/api/machines/diff?${params.toString()}`));
    expect(res.status).toBe(400);
  });

  it('400s on a missing or unknown scope', async () => {
    const missing = new URLSearchParams({ machineId: 't1', projectName: 'p1', branchName: 'feature/x' });
    expect((await GET(new Request(`http://localhost/api/machines/diff?${missing.toString()}`))).status).toBe(400);
    expect((await GET(get({ scope: 'everything' }))).status).toBe(400);
  });

  it('403s a viewer without machine access BEFORE scope/path are even parsed', async () => {
    canViewMachine.mockResolvedValue(false);
    const res = await GET(get({ scope: 'not-even-a-scope', path: '../../etc/passwd' }));
    expect(res.status).toBe(403);
    expect(listMachineDiffFiles).not.toHaveBeenCalled();
    expect(readMachineDiffPair).not.toHaveBeenCalled();
  });

  it('400s a path that escapes the checkout root without touching the machine', async () => {
    const res = await GET(get({ path: '../../etc/passwd' }));
    expect(res.status).toBe(400);
    expect(resolveBranchMachineHandle).not.toHaveBeenCalled();
    expect(readMachineDiffPair).not.toHaveBeenCalled();
  });
});

describe('GET /api/machines/diff — main-branch notApplicable', () => {
  it.each(['committed', 'branch'])(
    'answers 200 { notApplicable: true } for %s scope on master without resolving the machine handle',
    async (scope) => {
      const res = await GET(get({ branchName: 'master', scope }));
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ notApplicable: true });
      expect(resolveBranchMachineHandle).not.toHaveBeenCalled();
      expect(listMachineDiffFiles).not.toHaveBeenCalled();
    },
  );

  it('keeps the uncommitted scope fully applicable on the main branch', async () => {
    const res = await GET(get({ branchName: 'main', scope: 'uncommitted' }));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ notApplicable: false, scope: 'uncommitted' });
  });
});

describe('GET /api/machines/diff — list form', () => {
  it('returns the changed-file list with truncation flag and merge-base', async () => {
    listMachineDiffFiles.mockResolvedValue({
      ok: true,
      notApplicable: false,
      files: [{ path: 'new/name.ts', status: 'renamed', previousPath: 'old/name.ts' }],
      truncated: true,
      mergeBase: 'a'.repeat(40),
    });
    const res = await GET(get({ branchName: 'feature/x', scope: 'committed' }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      notApplicable: false,
      scope: 'committed',
      files: [{ path: 'new/name.ts', status: 'renamed', previousPath: 'old/name.ts' }],
      truncated: true,
      mergeBase: 'a'.repeat(40),
    });
    expect(listMachineDiffFiles).toHaveBeenCalledWith(
      expect.objectContaining({
        branchName: 'feature/x',
        isMainBranch: false,
        scope: 'committed',
        cwd: '/workspace/repo',
      }),
    );
  });

  it('404s / 503s when the branch machine cannot be resolved', async () => {
    resolveBranchMachineHandle.mockResolvedValue({ ok: false, reason: 'not_found' });
    expect((await GET(get({}))).status).toBe(404);
    resolveBranchMachineHandle.mockResolvedValue({ ok: false, reason: 'vanished' });
    expect((await GET(get({}))).status).toBe(503);
  });

  it.each([
    { reason: 'exec_failed' as const, status: 502 },
    { reason: 'merge_base_failed' as const, status: 502 },
  ])('maps a $reason service failure to $status with a sanitized error, logging the stderr detail', async ({ reason, status }) => {
    const detail = "fatal: cannot access '/workspace/repo/.git': No such file or directory";
    listMachineDiffFiles.mockResolvedValue({ ok: false, reason, detail });
    const res = await GET(get({}));
    expect(res.status).toBe(status);
    const body = (await res.json()) as { error: string; reason: string };
    expect(body).toEqual({ error: 'Failed to compute the changed-file list', reason });
    expect(JSON.stringify(body)).not.toContain('/workspace');
    expect(JSON.stringify(body)).not.toContain('fatal:');
    expect(logApiError).toHaveBeenCalledWith(
      'Machine diff list failed',
      undefined,
      expect.objectContaining({ reason, detail }),
    );
  });

  it('does not log when a service failure carries no detail', async () => {
    listMachineDiffFiles.mockResolvedValue({ ok: false, reason: 'exec_failed' });
    const res = await GET(get({}));
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: 'Failed to compute the changed-file list', reason: 'exec_failed' });
    expect(logApiError).not.toHaveBeenCalled();
  });
});

describe('GET /api/machines/diff — per-file pair form', () => {
  it('returns the original/modified pair for a confined repo-relative path', async () => {
    const res = await GET(get({ path: 'src/a.ts' }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      notApplicable: false,
      scope: 'uncommitted',
      path: 'src/a.ts',
      original: { content: 'old', truncated: false },
      modified: { content: 'new', truncated: false },
    });
    expect(readMachineDiffPair).toHaveBeenCalledWith(
      expect.objectContaining({
        path: 'src/a.ts',
        workingTreePath: '/workspace/repo/src/a.ts',
        cwd: '/workspace/repo',
      }),
    );
  });

  it('forwards previousPath (rename source) so the original side reads the pre-rename blob', async () => {
    const res = await GET(get({ path: 'src/new-name.ts', previousPath: 'src/old-name.ts' }));
    expect(res.status).toBe(200);
    expect(readMachineDiffPair).toHaveBeenCalledWith(
      expect.objectContaining({
        path: 'src/new-name.ts',
        previousPath: 'src/old-name.ts',
        workingTreePath: '/workspace/repo/src/new-name.ts',
      }),
    );
  });

  it('forwards a valid status so the pair reader can skip a nonexistent side', async () => {
    const res = await GET(get({ path: 'src/a.ts', status: 'deleted' }));
    expect(res.status).toBe(200);
    expect(readMachineDiffPair).toHaveBeenCalledWith(expect.objectContaining({ status: 'deleted' }));
  });

  it('400s an invalid status value without touching the machine', async () => {
    const res = await GET(get({ path: 'src/a.ts', status: 'bogus' }));
    expect(res.status).toBe(400);
    expect(readMachineDiffPair).not.toHaveBeenCalled();
  });

  it('omits status (undefined) when absent or empty', async () => {
    await GET(get({ path: 'src/a.ts' }));
    expect(readMachineDiffPair).toHaveBeenCalledWith(expect.objectContaining({ status: undefined }));
  });

  it('omits previousPath (undefined) when absent or empty', async () => {
    await GET(get({ path: 'src/a.ts' }));
    expect(readMachineDiffPair).toHaveBeenCalledWith(expect.objectContaining({ previousPath: undefined }));
    vi.clearAllMocks();
    readMachineDiffPair.mockResolvedValue({
      ok: true,
      notApplicable: false,
      original: { content: 'old', truncated: false },
      modified: { content: 'new', truncated: false },
    });
    await GET(get({ path: 'src/a.ts', previousPath: '' }));
    expect(readMachineDiffPair).toHaveBeenCalledWith(expect.objectContaining({ previousPath: undefined }));
  });

  it('passes null sides through (added file has no original)', async () => {
    readMachineDiffPair.mockResolvedValue({
      ok: true,
      notApplicable: false,
      original: null,
      modified: { content: 'brand new', truncated: false },
    });
    const res = await GET(get({ path: 'new.ts' }));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ original: null, modified: { content: 'brand new' } });
  });

  it('404s when the file exists on neither side of the scope', async () => {
    readMachineDiffPair.mockResolvedValue({ ok: true, notApplicable: false, original: null, modified: null });
    const res = await GET(get({ path: 'ghost.ts' }));
    expect(res.status).toBe(404);
  });

  it('maps a pair-read exec failure to 502 with a sanitized error, logging the stderr detail', async () => {
    const detail = "fatal: path '/workspace/repo/src/a.ts' does not exist in 'HEAD'";
    readMachineDiffPair.mockResolvedValue({ ok: false, reason: 'exec_failed', detail });
    const res = await GET(get({ path: 'src/a.ts' }));
    expect(res.status).toBe(502);
    const body = (await res.json()) as { error: string; reason: string };
    expect(body).toEqual({ error: 'Failed to read the diff for this file', reason: 'exec_failed' });
    expect(JSON.stringify(body)).not.toContain('/workspace');
    expect(JSON.stringify(body)).not.toContain('fatal:');
    expect(logApiError).toHaveBeenCalledWith(
      'Machine diff pair read failed',
      undefined,
      expect.objectContaining({ reason: 'exec_failed', detail, path: 'src/a.ts' }),
    );
  });
});
