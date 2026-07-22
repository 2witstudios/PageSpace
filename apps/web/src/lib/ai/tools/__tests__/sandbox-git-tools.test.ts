import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createSandboxGitTools, SANDBOX_GIT_TOOL_NAMES } from '../sandbox-git-tools';
import type { GitSandboxToolsDeps } from '../sandbox-git-tools';
import type { MachineNodeHandle, MachineNodeHandleSet } from '@pagespace/lib/services/machines/machine-pane-binding';

const mockRun = vi.fn();

function makeDeps(token: string | null = 'ghp_test'): GitSandboxToolsDeps {
  const runCommandCalls: Array<{ cmd: string; args: string[]; env: Record<string, string> }> = [];
  return {
    gitRunDeps: {
      isEnabled: () => true,
      acquireSandbox: vi.fn().mockResolvedValue({ ok: true, sandboxId: 'sbx-1', resumed: false }),
      reconnect: vi.fn().mockResolvedValue({
        sandboxId: 'sbx-1',
        spriteInstanceId: null,
        runCommand: vi.fn().mockImplementation(async (opts) => {
          runCommandCalls.push(opts);
          mockRun(opts);
          return { exitCode: 0, stdout: 'ok', stderr: '' };
        }),
        writeFiles: vi.fn(),
        readFileToBuffer: vi.fn(),
      }),
      quota: {
        acquireSlot: vi.fn().mockReturnValue(true),
        releaseSlot: vi.fn(),
      },
      buildEnv: vi.fn().mockReturnValue({ NODE_ENV: 'test' }),
      audit: vi.fn().mockResolvedValue(undefined),
      now: () => new Date('2026-06-01T12:00:00Z'),
      resolveGitHubToken: vi.fn().mockResolvedValue(token),
    },
    resolveContext: vi.fn().mockResolvedValue({
      userId: 'u1', tenantId: 't1', driveId: 'd1', conversationId: 'c1',
      actorEmail: 'u@test.com', tier: 'pro',
    }),
    gate: vi.fn().mockResolvedValue({ ok: true }),
    machines: {
      listMachines: vi.fn().mockResolvedValue([{ kind: 'own' }]),
      describeMachine: vi.fn().mockResolvedValue({ name: 'My Machine' }),
      isMachineAccessible: vi.fn().mockResolvedValue({ allowed: true }),
    },
    _runCommandCalls: runCommandCalls,
  } as unknown as GitSandboxToolsDeps & { _runCommandCalls: typeof runCommandCalls };
}

function getRunCalls(deps: GitSandboxToolsDeps) {
  return (deps as unknown as { _runCommandCalls: Array<{ cmd: string; args: string[]; env: Record<string, string> }> })._runCommandCalls;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockRun.mockReset();
});

// ── git_clone ──────────────────────────────────────────────────────────────

describe('git_clone', () => {
  it('rejects SSH git@ URLs', async () => {
    const deps = makeDeps();
    const { git_clone } = createSandboxGitTools(deps);
    const result = await git_clone.execute!(
      { repo_url: 'git@github.com:owner/repo.git' },
      {} as never,
    );
    expect(result).toMatchObject({ success: false });
    expect(deps.gitRunDeps.acquireSandbox).not.toHaveBeenCalled();
  });

  it('rejects ssh:// URLs', async () => {
    const deps = makeDeps();
    const { git_clone } = createSandboxGitTools(deps);
    const result = await git_clone.execute!(
      { repo_url: 'ssh://git@github.com/owner/repo.git' },
      {} as never,
    );
    expect(result).toMatchObject({ success: false });
  });

  it('builds correct args for clone with depth', async () => {
    const deps = makeDeps();
    const { git_clone } = createSandboxGitTools(deps);
    await git_clone.execute!(
      { repo_url: 'https://github.com/owner/repo.git', depth: 1 },
      {} as never,
    );
    const calls = getRunCalls(deps);
    expect(calls[0].cmd).toBe('git');
    expect(calls[0].args).toEqual([
      'clone', '--no-single-branch', '--depth', '1', 'https://github.com/owner/repo.git', '/workspace',
    ]);
  });

  it('clones into the sandbox root when no path is given', async () => {
    const deps = makeDeps();
    const { git_clone } = createSandboxGitTools(deps);
    await git_clone.execute!({ repo_url: 'https://github.com/owner/repo.git' }, {} as never);
    const calls = getRunCalls(deps);
    expect(calls[0].args).toEqual(['clone', 'https://github.com/owner/repo.git', '/workspace']);
  });

  it('resolves the explicit clone path under the sandbox root', async () => {
    const deps = makeDeps();
    const { git_clone } = createSandboxGitTools(deps);
    await git_clone.execute!(
      { repo_url: 'https://github.com/owner/repo.git', path: 'repo' },
      {} as never,
    );
    const calls = getRunCalls(deps);
    expect(calls[0].args).toEqual(['clone', 'https://github.com/owner/repo.git', '/workspace/repo']);
  });

  it('rejects a clone destination that escapes the sandbox root', async () => {
    const deps = makeDeps();
    const { git_clone } = createSandboxGitTools(deps);
    const result = await git_clone.execute!(
      { repo_url: 'https://github.com/owner/repo.git', path: '../../escaped-outside-workspace' },
      {} as never,
    );
    expect(result).toMatchObject({ success: false, reason: 'path_escape' });
    expect(deps.gitRunDeps.acquireSandbox).not.toHaveBeenCalled();
  });
});

// ── git_init ───────────────────────────────────────────────────────────────

describe('git_init', () => {
  it('defaults to the sandbox root when no path given', async () => {
    const deps = makeDeps();
    const { git_init } = createSandboxGitTools(deps);
    await git_init.execute!({}, {} as never);
    const calls = getRunCalls(deps);
    expect(calls[0].args).toEqual(['init', '/workspace']);
  });

  it('rejects an init path that escapes the sandbox root', async () => {
    const deps = makeDeps();
    const { git_init } = createSandboxGitTools(deps);
    const result = await git_init.execute!({ path: '/etc/foo' }, {} as never);
    expect(result).toMatchObject({ success: false, reason: 'path_escape' });
    expect(deps.gitRunDeps.acquireSandbox).not.toHaveBeenCalled();
  });
});

// ── git_config ─────────────────────────────────────────────────────────────

describe('git_config', () => {
  it('includes --global when global: true', async () => {
    const deps = makeDeps();
    const { git_config } = createSandboxGitTools(deps);
    await git_config.execute!({ key: 'user.name', value: 'Bot', global: true }, {} as never);
    const calls = getRunCalls(deps);
    expect(calls[0].args).toContain('--global');
  });
});

// ── git_add ────────────────────────────────────────────────────────────────

describe('git_add', () => {
  it('rejects empty paths with all: false', async () => {
    const deps = makeDeps();
    const { git_add } = createSandboxGitTools(deps);
    const result = await git_add.execute!({ paths: [] }, {} as never);
    expect(result).toMatchObject({ success: false });
  });

  it('builds -A when all: true', async () => {
    const deps = makeDeps();
    const { git_add } = createSandboxGitTools(deps);
    await git_add.execute!({ all: true }, {} as never);
    const calls = getRunCalls(deps);
    expect(calls[0].args).toEqual(['add', '-A']);
  });
});

// ── git_diff ───────────────────────────────────────────────────────────────

describe('git_diff', () => {
  it('includes --cached when staged: true', async () => {
    const deps = makeDeps();
    const { git_diff } = createSandboxGitTools(deps);
    await git_diff.execute!({ staged: true }, {} as never);
    const calls = getRunCalls(deps);
    expect(calls[0].args).toContain('--cached');
  });

  it('uses three-dot merge-base diff when base is given', async () => {
    const deps = makeDeps();
    const { git_diff } = createSandboxGitTools(deps);
    await git_diff.execute!({ base: 'origin/master' }, {} as never);
    const calls = getRunCalls(deps);
    expect(calls[0].args).toContain('origin/master...HEAD');
  });

  it('uses explicit head ref when both base and head are given', async () => {
    const deps = makeDeps();
    const { git_diff } = createSandboxGitTools(deps);
    await git_diff.execute!({ base: 'origin/master', head: 'feature-x' }, {} as never);
    const calls = getRunCalls(deps);
    expect(calls[0].args).toContain('origin/master...feature-x');
  });

  it('includes --path filter when path is given with base', async () => {
    const deps = makeDeps();
    const { git_diff } = createSandboxGitTools(deps);
    await git_diff.execute!({ base: 'origin/master', path: 'src/foo.ts' }, {} as never);
    const calls = getRunCalls(deps);
    expect(calls[0].args).toContain('--');
    expect(calls[0].args).toContain('src/foo.ts');
  });

  it('falls back to working-tree diff when base is not given', async () => {
    const deps = makeDeps();
    const { git_diff } = createSandboxGitTools(deps);
    await git_diff.execute!({}, {} as never);
    const calls = getRunCalls(deps);
    expect(calls[0].args).toEqual(['diff']);
    expect(calls[0].args).not.toContain('...');
  });

  it('rejects head without base', () => {
    const { git_diff } = createSandboxGitTools(makeDeps());
    const ok = (v: unknown) => (git_diff.inputSchema as unknown as { safeParse: (v: unknown) => { success: boolean } }).safeParse(v).success;
    expect(ok({ head: 'feature-x' })).toBe(false);
    expect(ok({ base: 'origin/master', head: 'feature-x' })).toBe(true);
  });

  it('rejects staged combined with base', () => {
    const { git_diff } = createSandboxGitTools(makeDeps());
    const ok = (v: unknown) => (git_diff.inputSchema as unknown as { safeParse: (v: unknown) => { success: boolean } }).safeParse(v).success;
    expect(ok({ staged: true, base: 'origin/master' })).toBe(false);
    expect(ok({ staged: true })).toBe(true);
    expect(ok({ base: 'origin/master' })).toBe(true);
  });
});

// ── git_reset ──────────────────────────────────────────────────────────────

describe('git_reset', () => {
  it('builds --hard for mode hard', async () => {
    const deps = makeDeps();
    const { git_reset } = createSandboxGitTools(deps);
    await git_reset.execute!({ mode: 'hard' }, {} as never);
    const calls = getRunCalls(deps);
    expect(calls[0].args).toContain('--hard');
  });
});

// ── git_stash ──────────────────────────────────────────────────────────────

describe('git_stash', () => {
  it('push with message includes -m', async () => {
    const deps = makeDeps();
    const { git_stash } = createSandboxGitTools(deps);
    await git_stash.execute!({ action: 'push', message: 'wip' }, {} as never);
    const calls = getRunCalls(deps);
    expect(calls[0].args).toContain('-m');
    expect(calls[0].args).toContain('wip');
  });

  it('list builds ["stash", "list"]', async () => {
    const deps = makeDeps();
    const { git_stash } = createSandboxGitTools(deps);
    await git_stash.execute!({ action: 'list' }, {} as never);
    const calls = getRunCalls(deps);
    expect(calls[0].args).toEqual(['stash', 'list']);
  });
});

// ── git_commit ─────────────────────────────────────────────────────────────

describe('git_commit', () => {
  it('rejects empty message', async () => {
    const deps = makeDeps();
    const { git_commit } = createSandboxGitTools(deps);
    const result = await git_commit.execute!({ message: '' }, {} as never);
    expect(result).toMatchObject({ success: false });
  });
});

// ── git_log ────────────────────────────────────────────────────────────────

describe('git_log', () => {
  it('defaults to --oneline and -20', async () => {
    const deps = makeDeps();
    const { git_log } = createSandboxGitTools(deps);
    await git_log.execute!({}, {} as never);
    const calls = getRunCalls(deps);
    expect(calls[0].args).toContain('--oneline');
    expect(calls[0].args).toContain('-20');
  });

  it('uses -5 when n: 5', async () => {
    const deps = makeDeps();
    const { git_log } = createSandboxGitTools(deps);
    await git_log.execute!({ n: 5 }, {} as never);
    const calls = getRunCalls(deps);
    expect(calls[0].args).toContain('-5');
  });
});

// ── git_merge ──────────────────────────────────────────────────────────────

describe('git_merge', () => {
  it('adds --squash for squash strategy', async () => {
    const deps = makeDeps();
    const { git_merge } = createSandboxGitTools(deps);
    await git_merge.execute!({ branch: 'feature', strategy: 'squash' }, {} as never);
    const calls = getRunCalls(deps);
    expect(calls[0].args).toContain('--squash');
  });
});

// ── git_branch ─────────────────────────────────────────────────────────────

describe('git_branch', () => {
  it('rejects delete without name', async () => {
    const deps = makeDeps();
    const { git_branch } = createSandboxGitTools(deps);
    const result = await git_branch.execute!({ action: 'delete' }, {} as never);
    expect(result).toMatchObject({ success: false });
  });
});

// ── git_push ───────────────────────────────────────────────────────────────

describe('git_push', () => {
  it('uses --force-with-lease, not --force', async () => {
    const deps = makeDeps();
    const { git_push } = createSandboxGitTools(deps);
    await git_push.execute!({ force: true, branch: 'feature' }, {} as never);
    const calls = getRunCalls(deps);
    expect(calls[0].args).toContain('--force-with-lease');
    expect(calls[0].args).not.toContain('--force');
  });

  it('rejects force-push to main without opening a sandbox', async () => {
    const deps = makeDeps();
    const { git_push } = createSandboxGitTools(deps);
    const result = await git_push.execute!({ force: true, branch: 'main' }, {} as never);
    expect(result).toMatchObject({ success: false });
    expect(deps.gitRunDeps.acquireSandbox).not.toHaveBeenCalled();
  });

  it('rejects force-push to master (case-insensitive)', async () => {
    const deps = makeDeps();
    const { git_push } = createSandboxGitTools(deps);
    const result = await git_push.execute!({ force: true, branch: 'MASTER' }, {} as never);
    expect(result).toMatchObject({ success: false });
    expect(deps.gitRunDeps.acquireSandbox).not.toHaveBeenCalled();
  });

  it('rejects force-push without an explicit branch (cannot verify the target)', async () => {
    const deps = makeDeps();
    const { git_push } = createSandboxGitTools(deps);
    const result = await git_push.execute!({ force: true }, {} as never);
    expect(result).toMatchObject({ success: false });
    expect(deps.gitRunDeps.acquireSandbox).not.toHaveBeenCalled();
  });

  it('allows force-push to a feature branch', async () => {
    const deps = makeDeps();
    const { git_push } = createSandboxGitTools(deps);
    await git_push.execute!({ force: true, branch: 'pu/fix-x' }, {} as never);
    const calls = getRunCalls(deps);
    expect(calls[0].args).toContain('--force-with-lease');
    expect(calls[0].args).toContain('pu/fix-x');
  });

  it('rejects a force-push refspec whose destination is the default branch (HEAD:main)', async () => {
    const deps = makeDeps();
    const { git_push } = createSandboxGitTools(deps);
    const result = await git_push.execute!({ force: true, branch: 'HEAD:main' }, {} as never);
    expect(result).toMatchObject({ success: false });
    expect(deps.gitRunDeps.acquireSandbox).not.toHaveBeenCalled();
  });

  it('rejects a force-push refspec to a fully-qualified default ref (feature:refs/heads/master)', async () => {
    const deps = makeDeps();
    const { git_push } = createSandboxGitTools(deps);
    const result = await git_push.execute!(
      { force: true, branch: 'feature:refs/heads/master' },
      {} as never,
    );
    expect(result).toMatchObject({ success: false });
    expect(deps.gitRunDeps.acquireSandbox).not.toHaveBeenCalled();
  });

  it('rejects a +-prefixed force refspec to the default branch even without the force flag', async () => {
    const deps = makeDeps();
    const { git_push } = createSandboxGitTools(deps);
    const result = await git_push.execute!({ branch: '+main' }, {} as never);
    expect(result).toMatchObject({ success: false });
    expect(deps.gitRunDeps.acquireSandbox).not.toHaveBeenCalled();
  });

  it('allows a force-push whose refspec destination is a feature branch (main:feature)', async () => {
    const deps = makeDeps();
    const { git_push } = createSandboxGitTools(deps);
    await git_push.execute!({ force: true, branch: 'main:feature' }, {} as never);
    const calls = getRunCalls(deps);
    expect(calls[0].args).toContain('main:feature');
  });

  it('rejects deleting the default branch via an empty-source refspec (:main)', async () => {
    const deps = makeDeps();
    const { git_push } = createSandboxGitTools(deps);
    const result = await git_push.execute!({ branch: ':main' }, {} as never);
    expect(result).toMatchObject({ success: false });
    expect(deps.gitRunDeps.acquireSandbox).not.toHaveBeenCalled();
  });

  it('allows deleting a feature branch (:feature)', async () => {
    const deps = makeDeps();
    const { git_push } = createSandboxGitTools(deps);
    await git_push.execute!({ branch: ':feature' }, {} as never);
    const calls = getRunCalls(deps);
    expect(calls[0].args).toContain(':feature');
  });

  it('allows a non-force push with no branch (current branch)', async () => {
    const deps = makeDeps();
    const { git_push } = createSandboxGitTools(deps);
    await git_push.execute!({}, {} as never);
    const calls = getRunCalls(deps);
    expect(calls[0].args[0]).toBe('push');
  });

  it('includes -u when set_upstream: true', async () => {
    const deps = makeDeps();
    const { git_push } = createSandboxGitTools(deps);
    await git_push.execute!({ set_upstream: true }, {} as never);
    const calls = getRunCalls(deps);
    expect(calls[0].args).toContain('-u');
  });

  it('includes -u by default when set_upstream is omitted', async () => {
    const deps = makeDeps();
    const { git_push } = createSandboxGitTools(deps);
    await git_push.execute!({ branch: 'feature' }, {} as never);
    const calls = getRunCalls(deps);
    expect(calls[0].args).toContain('-u');
  });

  it('omits -u when set_upstream: false is explicit', async () => {
    const deps = makeDeps();
    const { git_push } = createSandboxGitTools(deps);
    await git_push.execute!({ branch: 'feature', set_upstream: false }, {} as never);
    const calls = getRunCalls(deps);
    expect(calls[0].args).not.toContain('-u');
  });

  it('returns no-connection error without opening sandbox when token is null', async () => {
    const deps = makeDeps(null);
    const { git_push } = createSandboxGitTools(deps);
    const result = await git_push.execute!({}, {} as never);
    expect(result).toMatchObject({ success: false });
    expect(deps.gitRunDeps.acquireSandbox).not.toHaveBeenCalled();
  });
});

// ── git_fetch ──────────────────────────────────────────────────────────────

describe('git_fetch', () => {
  it('defaults to ["fetch", "origin"]', async () => {
    const deps = makeDeps();
    const { git_fetch } = createSandboxGitTools(deps);
    await git_fetch.execute!({}, {} as never);
    const calls = getRunCalls(deps);
    expect(calls[0].args).toEqual(['fetch', 'origin']);
  });

  it('returns no-connection error without opening sandbox when token is null', async () => {
    const deps = makeDeps(null);
    const { git_fetch } = createSandboxGitTools(deps);
    const result = await git_fetch.execute!({}, {} as never);
    expect(result).toMatchObject({ success: false });
    expect(deps.gitRunDeps.acquireSandbox).not.toHaveBeenCalled();
  });
});

// ── gh_pr_create ───────────────────────────────────────────────────────────

describe('gh_pr_create', () => {
  it('rejects empty title', async () => {
    const deps = makeDeps();
    const { gh_pr_create } = createSandboxGitTools(deps);
    const result = await gh_pr_create.execute!({ title: '', body: 'desc' }, {} as never);
    expect(result).toMatchObject({ success: false });
  });

  it('includes --draft when draft: true', async () => {
    const deps = makeDeps();
    const { gh_pr_create } = createSandboxGitTools(deps);
    await gh_pr_create.execute!({ title: 'My PR', body: 'desc', draft: true }, {} as never);
    const calls = getRunCalls(deps);
    expect(calls[0].cmd).toBe('gh');
    expect(calls[0].args).toContain('--draft');
  });

  it('passes --head <branch> when head is given', async () => {
    const deps = makeDeps();
    const { gh_pr_create } = createSandboxGitTools(deps);
    await gh_pr_create.execute!({ title: 'PR', body: 'b', head: 'feat/x' }, {} as never);
    const calls = getRunCalls(deps);
    const headIdx = calls[0].args.indexOf('--head');
    expect(headIdx).toBeGreaterThan(-1);
    expect(calls[0].args[headIdx + 1]).toBe('feat/x');
  });

  it('omits --head when head is not given', async () => {
    const deps = makeDeps();
    const { gh_pr_create } = createSandboxGitTools(deps);
    await gh_pr_create.execute!({ title: 'PR', body: 'b' }, {} as never);
    const calls = getRunCalls(deps);
    expect(calls[0].args).not.toContain('--head');
  });

  it('joins labels with comma in --label arg', async () => {
    const deps = makeDeps();
    const { gh_pr_create } = createSandboxGitTools(deps);
    await gh_pr_create.execute!({ title: 'PR', body: 'b', labels: ['bug', 'ui'] }, {} as never);
    const calls = getRunCalls(deps);
    const labelIdx = calls[0].args.indexOf('--label');
    expect(calls[0].args[labelIdx + 1]).toBe('bug,ui');
  });

  it('returns no-connection error when token is null', async () => {
    const deps = makeDeps(null);
    const { gh_pr_create } = createSandboxGitTools(deps);
    const result = await gh_pr_create.execute!({ title: 'PR', body: 'b' }, {} as never);
    expect(result).toMatchObject({ success: false });
    expect(deps.gitRunDeps.acquireSandbox).not.toHaveBeenCalled();
  });
});

// ── gh_pr_diff ─────────────────────────────────────────────────────────────

describe('gh_pr_diff', () => {
  it('builds ["pr", "diff", "<number>"]', async () => {
    const deps = makeDeps();
    const { gh_pr_diff } = createSandboxGitTools(deps);
    await gh_pr_diff.execute!({ number: 42 }, {} as never);
    const calls = getRunCalls(deps);
    expect(calls[0].cmd).toBe('gh');
    expect(calls[0].args).toEqual(['pr', 'diff', '42', '--color', 'never']);
  });

  it('returns no-connection error when token is null', async () => {
    const deps = makeDeps(null);
    const { gh_pr_diff } = createSandboxGitTools(deps);
    const result = await gh_pr_diff.execute!({ number: 42 }, {} as never);
    expect(result).toMatchObject({ success: false });
    expect(deps.gitRunDeps.acquireSandbox).not.toHaveBeenCalled();
  });
});

// ── gh_issue_create ────────────────────────────────────────────────────────

describe('gh_issue_create', () => {
  it('rejects empty title', async () => {
    const deps = makeDeps();
    const { gh_issue_create } = createSandboxGitTools(deps);
    const result = await gh_issue_create.execute!({ title: '', body: 'b' }, {} as never);
    expect(result).toMatchObject({ success: false });
  });

  it('returns no-connection error when token is null', async () => {
    const deps = makeDeps(null);
    const { gh_issue_create } = createSandboxGitTools(deps);
    const result = await gh_issue_create.execute!({ title: 'Issue', body: 'b' }, {} as never);
    expect(result).toMatchObject({ success: false });
    expect(deps.gitRunDeps.acquireSandbox).not.toHaveBeenCalled();
  });
});

// ── gh_run_list ─────────────────────────────────────────────────────────────

describe('gh_run_list', () => {
  it('defaults to limit 10', async () => {
    const deps = makeDeps();
    const { gh_run_list } = createSandboxGitTools(deps);
    await gh_run_list.execute!({}, {} as never);
    const calls = getRunCalls(deps);
    expect(calls[0].cmd).toBe('gh');
    expect(calls[0].args).toContain('--limit');
    const limitIdx = calls[0].args.indexOf('--limit');
    expect(calls[0].args[limitIdx + 1]).toBe('10');
  });

  it('passes branch and status filters', async () => {
    const deps = makeDeps();
    const { gh_run_list } = createSandboxGitTools(deps);
    await gh_run_list.execute!({ branch: 'feat/x', status: 'completed' }, {} as never);
    const calls = getRunCalls(deps);
    const branchIdx = calls[0].args.indexOf('--branch');
    expect(calls[0].args[branchIdx + 1]).toBe('feat/x');
    const statusIdx = calls[0].args.indexOf('--status');
    expect(calls[0].args[statusIdx + 1]).toBe('completed');
  });

  it('returns no-connection error when token is null', async () => {
    const deps = makeDeps(null);
    const { gh_run_list } = createSandboxGitTools(deps);
    const result = await gh_run_list.execute!({}, {} as never);
    expect(result).toMatchObject({ success: false });
    expect(deps.gitRunDeps.acquireSandbox).not.toHaveBeenCalled();
  });
});

// ── gh_run_view ──────────────────────────────────────────────────────────────

describe('gh_run_view', () => {
  it('uses --json when log is not set', async () => {
    const deps = makeDeps();
    const { gh_run_view } = createSandboxGitTools(deps);
    await gh_run_view.execute!({ runId: 12345 }, {} as never);
    const calls = getRunCalls(deps);
    expect(calls[0].cmd).toBe('gh');
    expect(calls[0].args).toContain('--json');
    expect(calls[0].args).toContain('12345');
    expect(calls[0].args).not.toContain('--log-failed');
  });

  it('uses --log-failed when log: true', async () => {
    const deps = makeDeps();
    const { gh_run_view } = createSandboxGitTools(deps);
    await gh_run_view.execute!({ runId: 12345, log: true }, {} as never);
    const calls = getRunCalls(deps);
    expect(calls[0].args).toContain('--log-failed');
    expect(calls[0].args).not.toContain('--json');
  });

  it('returns no-connection error when token is null', async () => {
    const deps = makeDeps(null);
    const { gh_run_view } = createSandboxGitTools(deps);
    const result = await gh_run_view.execute!({ runId: 12345 }, {} as never);
    expect(result).toMatchObject({ success: false });
    expect(deps.gitRunDeps.acquireSandbox).not.toHaveBeenCalled();
  });
});

// ── gh_pr_checks ───────────────────────────────────────────────────────────

describe('gh_pr_checks', () => {
  it('calls gh pr checks with JSON output', async () => {
    const deps = makeDeps();
    const { gh_pr_checks } = createSandboxGitTools(deps);
    await gh_pr_checks.execute!({ number: 42 }, {} as never);
    const calls = getRunCalls(deps);
    expect(calls[0].cmd).toBe('gh');
    expect(calls[0].args).toContain('checks');
    expect(calls[0].args).toContain('42');
    const jsonIdx = calls[0].args.indexOf('--json');
    expect(jsonIdx).toBeGreaterThan(-1);
    expect(calls[0].args[jsonIdx + 1]).toContain('name');
    expect(calls[0].args[jsonIdx + 1]).toContain('state');
  });

  it('returns no-connection error when token is null', async () => {
    const deps = makeDeps(null);
    const { gh_pr_checks } = createSandboxGitTools(deps);
    const result = await gh_pr_checks.execute!({ number: 42 }, {} as never);
    expect(result).toMatchObject({ success: false });
    expect(deps.gitRunDeps.acquireSandbox).not.toHaveBeenCalled();
  });
});

// ── gh_pr_review ───────────────────────────────────────────────────────────

describe('gh_pr_review', () => {
  it('uses --approve for approve action', async () => {
    const deps = makeDeps();
    const { gh_pr_review } = createSandboxGitTools(deps);
    await gh_pr_review.execute!({ number: 42, action: 'approve', body: 'LGTM' }, {} as never);
    const calls = getRunCalls(deps);
    expect(calls[0].cmd).toBe('gh');
    expect(calls[0].args).toContain('--approve');
    expect(calls[0].args).toContain('LGTM');
  });

  it('uses --request-changes for request_changes action', async () => {
    const deps = makeDeps();
    const { gh_pr_review } = createSandboxGitTools(deps);
    await gh_pr_review.execute!({ number: 42, action: 'request_changes', body: 'Fix X' }, {} as never);
    const calls = getRunCalls(deps);
    expect(calls[0].args).toContain('--request-changes');
    expect(calls[0].args).toContain('Fix X');
  });

  it('uses --comment for comment action', async () => {
    const deps = makeDeps();
    const { gh_pr_review } = createSandboxGitTools(deps);
    await gh_pr_review.execute!({ number: 42, action: 'comment', body: 'Note: ...' }, {} as never);
    const calls = getRunCalls(deps);
    expect(calls[0].args).toContain('--comment');
    expect(calls[0].args).toContain('Note: ...');
  });

  it('returns no-connection error when token is null', async () => {
    const deps = makeDeps(null);
    const { gh_pr_review } = createSandboxGitTools(deps);
    const result = await gh_pr_review.execute!({ number: 42, action: 'approve' }, {} as never);
    expect(result).toMatchObject({ success: false });
    expect(deps.gitRunDeps.acquireSandbox).not.toHaveBeenCalled();
  });
});

// ── gh_pr_review_comment ────────────────────────────────────────────────────

describe('gh_pr_review_comment', () => {
  it('builds the correct gh api call for an inline comment', async () => {
    const deps = makeDeps();
    const { gh_pr_review_comment } = createSandboxGitTools(deps);
    await gh_pr_review_comment.execute!(
      { number: 42, body: 'Off-by-one here', path: 'src/index.ts', line: 10, side: 'RIGHT', commit_id: 'abc123' },
      {} as never,
    );
    const calls = getRunCalls(deps);
    expect(calls[0].cmd).toBe('gh');
    expect(calls[0].args[0]).toBe('api');
    expect(calls[0].args[1]).toBe('repos/{owner}/{repo}/pulls/42/comments');
    expect(calls[0].args).toContain('-f');
    expect(calls[0].args).toContain('body=Off-by-one here');
    expect(calls[0].args).toContain('path=src/index.ts');
    expect(calls[0].args).toContain('side=RIGHT');
    expect(calls[0].args).toContain('commit_id=abc123');
    expect(calls[0].args).toContain('-F');
    expect(calls[0].args).toContain('line=10');
  });

  it('includes start_line/start_side for a multi-line comment', async () => {
    const deps = makeDeps();
    const { gh_pr_review_comment } = createSandboxGitTools(deps);
    await gh_pr_review_comment.execute!(
      {
        number: 42,
        body: 'Refactor this block',
        path: 'src/index.ts',
        line: 20,
        start_line: 10,
        start_side: 'RIGHT',
        commit_id: 'abc123',
      },
      {} as never,
    );
    const calls = getRunCalls(deps);
    expect(calls[0].args).toContain('start_line=10');
    expect(calls[0].args).toContain('start_side=RIGHT');
  });

  it('includes subject_type for a file-level comment', async () => {
    const deps = makeDeps();
    const { gh_pr_review_comment } = createSandboxGitTools(deps);
    await gh_pr_review_comment.execute!(
      { number: 42, body: 'Consider splitting this file', path: 'src/index.ts', commit_id: 'abc123', subject_type: 'file' },
      {} as never,
    );
    const calls = getRunCalls(deps);
    expect(calls[0].args).toContain('subject_type=file');
  });

  it('builds a reply with only in_reply_to and body', async () => {
    const deps = makeDeps();
    const { gh_pr_review_comment } = createSandboxGitTools(deps);
    await gh_pr_review_comment.execute!(
      { number: 42, body: 'Fixed in latest push', in_reply_to: 999 },
      {} as never,
    );
    const calls = getRunCalls(deps);
    expect(calls[0].args).toContain('in_reply_to=999');
    expect(calls[0].args).not.toContain('path=undefined');
  });

  it('rejects empty body', async () => {
    const deps = makeDeps();
    const { gh_pr_review_comment } = createSandboxGitTools(deps);
    const result = await gh_pr_review_comment.execute!({ number: 42, body: '' }, {} as never);
    expect(result).toMatchObject({ success: false });
    expect(deps.gitRunDeps.acquireSandbox).not.toHaveBeenCalled();
  });

  it('returns no-connection error when token is null', async () => {
    const deps = makeDeps(null);
    const { gh_pr_review_comment } = createSandboxGitTools(deps);
    const result = await gh_pr_review_comment.execute!({ number: 42, body: 'LGTM' }, {} as never);
    expect(result).toMatchObject({ success: false });
    expect(deps.gitRunDeps.acquireSandbox).not.toHaveBeenCalled();
  });
});

// ── gh_pr_close ────────────────────────────────────────────────────────────

describe('gh_pr_close', () => {
  it('includes --comment when comment is given', async () => {
    const deps = makeDeps();
    const { gh_pr_close } = createSandboxGitTools(deps);
    await gh_pr_close.execute!({ number: 42, comment: 'Duplicate' }, {} as never);
    const calls = getRunCalls(deps);
    expect(calls[0].cmd).toBe('gh');
    expect(calls[0].args).toContain('close');
    expect(calls[0].args).toContain('42');
    expect(calls[0].args).toContain('--comment');
    expect(calls[0].args).toContain('Duplicate');
  });

  it('omits --comment when not given', async () => {
    const deps = makeDeps();
    const { gh_pr_close } = createSandboxGitTools(deps);
    await gh_pr_close.execute!({ number: 42 }, {} as never);
    const calls = getRunCalls(deps);
    expect(calls[0].args).not.toContain('--comment');
  });

  it('returns no-connection error when token is null', async () => {
    const deps = makeDeps(null);
    const { gh_pr_close } = createSandboxGitTools(deps);
    const result = await gh_pr_close.execute!({ number: 42 }, {} as never);
    expect(result).toMatchObject({ success: false });
    expect(deps.gitRunDeps.acquireSandbox).not.toHaveBeenCalled();
  });
});

// ── gh_pr_reopen ───────────────────────────────────────────────────────────

describe('gh_pr_reopen', () => {
  it('builds ["pr", "reopen", "<number>"]', async () => {
    const deps = makeDeps();
    const { gh_pr_reopen } = createSandboxGitTools(deps);
    await gh_pr_reopen.execute!({ number: 42 }, {} as never);
    const calls = getRunCalls(deps);
    expect(calls[0].cmd).toBe('gh');
    expect(calls[0].args).toEqual(['pr', 'reopen', '42']);
  });

  it('returns no-connection error when token is null', async () => {
    const deps = makeDeps(null);
    const { gh_pr_reopen } = createSandboxGitTools(deps);
    const result = await gh_pr_reopen.execute!({ number: 42 }, {} as never);
    expect(result).toMatchObject({ success: false });
    expect(deps.gitRunDeps.acquireSandbox).not.toHaveBeenCalled();
  });
});

// ── gh_pr_ready ────────────────────────────────────────────────────────────

describe('gh_pr_ready', () => {
  it('builds ["pr", "ready", "<number>"]', async () => {
    const deps = makeDeps();
    const { gh_pr_ready } = createSandboxGitTools(deps);
    await gh_pr_ready.execute!({ number: 42 }, {} as never);
    const calls = getRunCalls(deps);
    expect(calls[0].cmd).toBe('gh');
    expect(calls[0].args).toEqual(['pr', 'ready', '42']);
  });

  it('returns no-connection error when token is null', async () => {
    const deps = makeDeps(null);
    const { gh_pr_ready } = createSandboxGitTools(deps);
    const result = await gh_pr_ready.execute!({ number: 42 }, {} as never);
    expect(result).toMatchObject({ success: false });
    expect(deps.gitRunDeps.acquireSandbox).not.toHaveBeenCalled();
  });
});

// ── git_show ───────────────────────────────────────────────────────────────

describe('git_show', () => {
  it('defaults to HEAD', async () => {
    const deps = makeDeps();
    const { git_show } = createSandboxGitTools(deps);
    await git_show.execute!({}, {} as never);
    const calls = getRunCalls(deps);
    expect(calls[0].cmd).toBe('git');
    expect(calls[0].args).toEqual(['show', 'HEAD']);
  });

  it('builds --stat with a ref and path filter', async () => {
    const deps = makeDeps();
    const { git_show } = createSandboxGitTools(deps);
    await git_show.execute!({ ref: 'abc123', stat: true, path: 'src/foo.ts' }, {} as never);
    const calls = getRunCalls(deps);
    expect(calls[0].args).toEqual(['show', '--stat', 'abc123', '--', 'src/foo.ts']);
  });

  it('rejects a ref that looks like a flag', async () => {
    const deps = makeDeps();
    const { git_show } = createSandboxGitTools(deps);
    const result = await git_show.execute!({ ref: '--exec=whoami' }, {} as never);
    expect(result).toMatchObject({ success: false });
    expect(deps.gitRunDeps.acquireSandbox).not.toHaveBeenCalled();
  });
});

// ── git_blame ──────────────────────────────────────────────────────────────

describe('git_blame', () => {
  it('builds a line-range blame', async () => {
    const deps = makeDeps();
    const { git_blame } = createSandboxGitTools(deps);
    await git_blame.execute!({ path: 'src/foo.ts', start_line: 5, end_line: 20 }, {} as never);
    const calls = getRunCalls(deps);
    expect(calls[0].args).toEqual(['blame', '-L', '5,20', '--', 'src/foo.ts']);
  });

  it('rejects start_line without end_line', async () => {
    const deps = makeDeps();
    const { git_blame } = createSandboxGitTools(deps);
    const result = await git_blame.execute!({ path: 'src/foo.ts', start_line: 5 }, {} as never);
    expect(result).toMatchObject({ success: false });
    expect(deps.gitRunDeps.acquireSandbox).not.toHaveBeenCalled();
  });
});

// ── git_merge / git_rebase conflict recovery ────────────────────────────────

describe('git_merge action', () => {
  it('runs a plain merge by default', async () => {
    const deps = makeDeps();
    const { git_merge } = createSandboxGitTools(deps);
    await git_merge.execute!({ branch: 'feature-x' }, {} as never);
    const calls = getRunCalls(deps);
    expect(calls[0].args).toEqual(['merge', 'feature-x']);
  });

  it('builds --abort without requiring a branch', async () => {
    const deps = makeDeps();
    const { git_merge } = createSandboxGitTools(deps);
    await git_merge.execute!({ action: 'abort' }, {} as never);
    const calls = getRunCalls(deps);
    expect(calls[0].args).toEqual(['merge', '--abort']);
  });

  it('rejects a run without a branch', async () => {
    const deps = makeDeps();
    const { git_merge } = createSandboxGitTools(deps);
    const result = await git_merge.execute!({}, {} as never);
    expect(result).toMatchObject({ success: false });
  });

  it('rejects a branch that looks like a flag', async () => {
    const deps = makeDeps();
    const { git_merge } = createSandboxGitTools(deps);
    const result = await git_merge.execute!({ branch: '--strategy=octopus' }, {} as never);
    expect(result).toMatchObject({ success: false });
    expect(deps.gitRunDeps.acquireSandbox).not.toHaveBeenCalled();
  });
});

describe('git_rebase action', () => {
  it('runs a plain rebase by default', async () => {
    const deps = makeDeps();
    const { git_rebase } = createSandboxGitTools(deps);
    await git_rebase.execute!({ branch_or_ref: 'origin/main' }, {} as never);
    const calls = getRunCalls(deps);
    expect(calls[0].args).toEqual(['rebase', 'origin/main']);
  });

  it('builds --continue without requiring a ref', async () => {
    const deps = makeDeps();
    const { git_rebase } = createSandboxGitTools(deps);
    await git_rebase.execute!({ action: 'continue' }, {} as never);
    const calls = getRunCalls(deps);
    expect(calls[0].args).toEqual(['rebase', '--continue']);
  });

  it('rejects a run without a ref', async () => {
    const deps = makeDeps();
    const { git_rebase } = createSandboxGitTools(deps);
    const result = await git_rebase.execute!({}, {} as never);
    expect(result).toMatchObject({ success: false });
  });

  it('rejects a branch_or_ref that looks like a flag', async () => {
    const deps = makeDeps();
    const { git_rebase } = createSandboxGitTools(deps);
    const result = await git_rebase.execute!({ branch_or_ref: '--exec=whoami' }, {} as never);
    expect(result).toMatchObject({ success: false });
    expect(deps.gitRunDeps.acquireSandbox).not.toHaveBeenCalled();
  });
});

// ── git_revert ─────────────────────────────────────────────────────────────

describe('git_revert', () => {
  it('builds --no-edit with a single sha', async () => {
    const deps = makeDeps();
    const { git_revert } = createSandboxGitTools(deps);
    await git_revert.execute!({ sha: 'abc1234' }, {} as never);
    const calls = getRunCalls(deps);
    expect(calls[0].args).toEqual(['revert', '--no-edit', 'abc1234']);
  });

  it('rejects a range', async () => {
    const deps = makeDeps();
    const { git_revert } = createSandboxGitTools(deps);
    const result = await git_revert.execute!({ sha: 'HEAD~3..HEAD' }, {} as never);
    expect(result).toMatchObject({ success: false });
    expect(deps.gitRunDeps.acquireSandbox).not.toHaveBeenCalled();
  });

  it('rejects a ref name', async () => {
    const deps = makeDeps();
    const { git_revert } = createSandboxGitTools(deps);
    const result = await git_revert.execute!({ sha: 'main' }, {} as never);
    expect(result).toMatchObject({ success: false });
  });

  it('builds --abort without requiring a sha', async () => {
    const deps = makeDeps();
    const { git_revert } = createSandboxGitTools(deps);
    await git_revert.execute!({ action: 'abort' }, {} as never);
    const calls = getRunCalls(deps);
    expect(calls[0].args).toEqual(['revert', '--abort']);
  });

  it('builds --continue without requiring a sha', async () => {
    const deps = makeDeps();
    const { git_revert } = createSandboxGitTools(deps);
    await git_revert.execute!({ action: 'continue' }, {} as never);
    const calls = getRunCalls(deps);
    expect(calls[0].args).toEqual(['revert', '--continue']);
  });

  it('rejects a run without a sha', async () => {
    const deps = makeDeps();
    const { git_revert } = createSandboxGitTools(deps);
    const result = await git_revert.execute!({}, {} as never);
    expect(result).toMatchObject({ success: false });
    expect(deps.gitRunDeps.acquireSandbox).not.toHaveBeenCalled();
  });

  it('supports mainline for reverting a merge commit', async () => {
    const deps = makeDeps();
    const { git_revert } = createSandboxGitTools(deps);
    await git_revert.execute!({ sha: 'abc1234', mainline: 1 }, {} as never);
    const calls = getRunCalls(deps);
    expect(calls[0].args).toEqual(['revert', '--no-edit', '-m', '1', 'abc1234']);
  });
});

// ── gh_pr_comment ──────────────────────────────────────────────────────────

describe('gh_pr_comment', () => {
  it('builds ["pr", "comment", "<number>", "--body", ...]', async () => {
    const deps = makeDeps();
    const { gh_pr_comment } = createSandboxGitTools(deps);
    await gh_pr_comment.execute!({ number: 42, body: 'Thanks, addressed!' }, {} as never);
    const calls = getRunCalls(deps);
    expect(calls[0].cmd).toBe('gh');
    expect(calls[0].args).toEqual(['pr', 'comment', '42', '--body', 'Thanks, addressed!']);
  });

  it('returns no-connection error when token is null', async () => {
    const deps = makeDeps(null);
    const { gh_pr_comment } = createSandboxGitTools(deps);
    const result = await gh_pr_comment.execute!({ number: 42, body: 'hi' }, {} as never);
    expect(result).toMatchObject({ success: false });
    expect(deps.gitRunDeps.acquireSandbox).not.toHaveBeenCalled();
  });
});

// ── gh_pr_edit ─────────────────────────────────────────────────────────────

describe('gh_pr_edit', () => {
  it('builds title/body/label/reviewer flags', async () => {
    const deps = makeDeps();
    const { gh_pr_edit } = createSandboxGitTools(deps);
    await gh_pr_edit.execute!(
      {
        number: 42,
        title: 'New title',
        body: 'New body',
        add_labels: ['bug', 'urgent'],
        remove_labels: ['wip'],
        add_reviewers: ['octocat'],
      },
      {} as never,
    );
    const calls = getRunCalls(deps);
    expect(calls[0].args).toEqual([
      'pr', 'edit', '42',
      '--title', 'New title',
      '--body', 'New body',
      '--add-label', 'bug,urgent',
      '--remove-label', 'wip',
      '--add-reviewer', 'octocat',
    ]);
  });

  it('rejects an edit with no fields', async () => {
    const deps = makeDeps();
    const { gh_pr_edit } = createSandboxGitTools(deps);
    const result = await gh_pr_edit.execute!({ number: 42 }, {} as never);
    expect(result).toMatchObject({ success: false });
    expect(deps.gitRunDeps.acquireSandbox).not.toHaveBeenCalled();
  });
});

// ── gh_pr_update_branch ────────────────────────────────────────────────────

describe('gh_pr_update_branch', () => {
  it('builds ["pr", "update-branch", "<number>"]', async () => {
    const deps = makeDeps();
    const { gh_pr_update_branch } = createSandboxGitTools(deps);
    await gh_pr_update_branch.execute!({ number: 42 }, {} as never);
    const calls = getRunCalls(deps);
    expect(calls[0].args).toEqual(['pr', 'update-branch', '42']);
  });
});

// ── gh_pr_thread_list / gh_pr_thread_resolve ───────────────────────────────

describe('gh_pr_thread_list', () => {
  it('passes variables as flags, never interpolated into the query document', async () => {
    const deps = makeDeps();
    const { gh_pr_thread_list } = createSandboxGitTools(deps);
    await gh_pr_thread_list.execute!({ owner: 'acme', repo: 'webapp', number: 42 }, {} as never);
    const calls = getRunCalls(deps);
    expect(calls[0].cmd).toBe('gh');
    expect(calls[0].args[0]).toBe('api');
    expect(calls[0].args[1]).toBe('graphql');
    const queryArg = calls[0].args[calls[0].args.indexOf('-f') + 1];
    expect(queryArg).toContain('reviewThreads');
    expect(queryArg).not.toContain('acme');
    expect(calls[0].args).toContain('owner=acme');
    expect(calls[0].args).toContain('repo=webapp');
    expect(calls[0].args).toContain('number=42');
  });
});

describe('gh_pr_thread_resolve', () => {
  it('uses the fixed mutation document with threadId as a flag', async () => {
    const deps = makeDeps();
    const { gh_pr_thread_resolve } = createSandboxGitTools(deps);
    await gh_pr_thread_resolve.execute!({ thread_id: 'PRRT_abc123' }, {} as never);
    const calls = getRunCalls(deps);
    expect(calls[0].args[0]).toBe('api');
    expect(calls[0].args[1]).toBe('graphql');
    const queryArg = calls[0].args[calls[0].args.indexOf('-f') + 1];
    expect(queryArg).toContain('resolveReviewThread');
    expect(queryArg).not.toContain('PRRT_abc123');
    expect(calls[0].args).toContain('threadId=PRRT_abc123');
  });

  it('returns no-connection error when token is null', async () => {
    const deps = makeDeps(null);
    const { gh_pr_thread_resolve } = createSandboxGitTools(deps);
    const result = await gh_pr_thread_resolve.execute!({ thread_id: 'PRRT_abc123' }, {} as never);
    expect(result).toMatchObject({ success: false });
    expect(deps.gitRunDeps.acquireSandbox).not.toHaveBeenCalled();
  });
});

// ── gh_run_rerun / gh_workflow_* ───────────────────────────────────────────

describe('gh_run_rerun', () => {
  it('builds ["run", "rerun", "<id>"] and adds --failed for failed_only', async () => {
    const deps = makeDeps();
    const { gh_run_rerun } = createSandboxGitTools(deps);
    await gh_run_rerun.execute!({ runId: 123, failed_only: true }, {} as never);
    const calls = getRunCalls(deps);
    expect(calls[0].args).toEqual(['run', 'rerun', '123', '--failed']);
  });
});

describe('gh_workflow_list', () => {
  it('builds ["workflow", "list", ...] with json fields', async () => {
    const deps = makeDeps();
    const { gh_workflow_list } = createSandboxGitTools(deps);
    await gh_workflow_list.execute!({}, {} as never);
    const calls = getRunCalls(deps);
    expect(calls[0].args).toEqual(['workflow', 'list', '--limit', '50', '--json', 'id,name,path,state']);
  });
});

describe('gh_workflow_run', () => {
  it('builds workflow dispatch with ref and -f inputs', async () => {
    const deps = makeDeps();
    const { gh_workflow_run } = createSandboxGitTools(deps);
    await gh_workflow_run.execute!(
      { workflow: 'ci.yml', ref: 'main', inputs: { environment: 'staging' } },
      {} as never,
    );
    const calls = getRunCalls(deps);
    expect(calls[0].args).toEqual([
      'workflow', 'run', 'ci.yml', '--ref', 'main', '-f', 'environment=staging',
    ]);
  });

  it('rejects an invalid input name', async () => {
    const deps = makeDeps();
    const { gh_workflow_run } = createSandboxGitTools(deps);
    const result = await gh_workflow_run.execute!(
      { workflow: 'ci.yml', ref: 'main', inputs: { 'bad name!': 'x' } },
      {} as never,
    );
    expect(result).toMatchObject({ success: false });
    expect(deps.gitRunDeps.acquireSandbox).not.toHaveBeenCalled();
  });

  it('requires ref in the schema', () => {
    const { gh_workflow_run } = createSandboxGitTools(makeDeps());
    const parse = (gh_workflow_run.inputSchema as { safeParse: (v: unknown) => { success: boolean } }).safeParse;
    expect(parse({ workflow: 'ci.yml' }).success).toBe(false);
    expect(parse({ workflow: 'ci.yml', ref: 'main' }).success).toBe(true);
  });

  it('rejects a workflow name that looks like a flag', async () => {
    const deps = makeDeps();
    const { gh_workflow_run } = createSandboxGitTools(deps);
    const result = await gh_workflow_run.execute!(
      { workflow: '--repo=other/repo', ref: 'main' },
      {} as never,
    );
    expect(result).toMatchObject({ success: false });
    expect(deps.gitRunDeps.acquireSandbox).not.toHaveBeenCalled();
  });
});

// ── gh_issue lifecycle ─────────────────────────────────────────────────────

describe('gh_issue_comment', () => {
  it('builds ["issue", "comment", "<number>", "--body", ...]', async () => {
    const deps = makeDeps();
    const { gh_issue_comment } = createSandboxGitTools(deps);
    await gh_issue_comment.execute!({ number: 7, body: 'On it.' }, {} as never);
    const calls = getRunCalls(deps);
    expect(calls[0].args).toEqual(['issue', 'comment', '7', '--body', 'On it.']);
  });
});

describe('gh_issue_edit', () => {
  it('builds label and assignee flags', async () => {
    const deps = makeDeps();
    const { gh_issue_edit } = createSandboxGitTools(deps);
    await gh_issue_edit.execute!(
      { number: 7, add_labels: ['bug'], add_assignees: ['octocat'] },
      {} as never,
    );
    const calls = getRunCalls(deps);
    expect(calls[0].args).toEqual([
      'issue', 'edit', '7', '--add-label', 'bug', '--add-assignee', 'octocat',
    ]);
  });

  it('rejects an edit with no fields', async () => {
    const deps = makeDeps();
    const { gh_issue_edit } = createSandboxGitTools(deps);
    const result = await gh_issue_edit.execute!({ number: 7 }, {} as never);
    expect(result).toMatchObject({ success: false });
  });
});

describe('gh_issue_close', () => {
  it('maps not_planned to the gh "not planned" reason', async () => {
    const deps = makeDeps();
    const { gh_issue_close } = createSandboxGitTools(deps);
    await gh_issue_close.execute!(
      { number: 7, comment: 'Duplicate of #5', reason: 'not_planned' },
      {} as never,
    );
    const calls = getRunCalls(deps);
    expect(calls[0].args).toEqual([
      'issue', 'close', '7', '--comment', 'Duplicate of #5', '--reason', 'not planned',
    ]);
  });
});

describe('gh_issue_reopen', () => {
  it('builds ["issue", "reopen", "<number>"]', async () => {
    const deps = makeDeps();
    const { gh_issue_reopen } = createSandboxGitTools(deps);
    await gh_issue_reopen.execute!({ number: 7 }, {} as never);
    const calls = getRunCalls(deps);
    expect(calls[0].args).toEqual(['issue', 'reopen', '7']);
  });
});

// ── gh repo / search / labels ──────────────────────────────────────────────

describe('gh_repo_view', () => {
  it('includes defaultBranchRef in json fields', async () => {
    const deps = makeDeps();
    const { gh_repo_view } = createSandboxGitTools(deps);
    await gh_repo_view.execute!({ repo: 'acme/webapp' }, {} as never);
    const calls = getRunCalls(deps);
    expect(calls[0].args.slice(0, 3)).toEqual(['repo', 'view', 'acme/webapp']);
    expect(calls[0].args[calls[0].args.indexOf('--json') + 1]).toContain('defaultBranchRef');
  });

  it('rejects a repo that looks like a flag', async () => {
    const deps = makeDeps();
    const { gh_repo_view } = createSandboxGitTools(deps);
    const result = await gh_repo_view.execute!({ repo: '--help' }, {} as never);
    expect(result).toMatchObject({ success: false });
    expect(deps.gitRunDeps.acquireSandbox).not.toHaveBeenCalled();
  });
});

describe('gh_repo_list', () => {
  it('lists the connected account by default', async () => {
    const deps = makeDeps();
    const { gh_repo_list } = createSandboxGitTools(deps);
    await gh_repo_list.execute!({}, {} as never);
    const calls = getRunCalls(deps);
    expect(calls[0].args.slice(0, 2)).toEqual(['repo', 'list']);
    expect(calls[0].args).toContain('--limit');
  });

  it('returns no-connection error when token is null', async () => {
    const deps = makeDeps(null);
    const { gh_repo_list } = createSandboxGitTools(deps);
    const result = await gh_repo_list.execute!({}, {} as never);
    expect(result).toMatchObject({ success: false });
    expect(deps.gitRunDeps.acquireSandbox).not.toHaveBeenCalled();
  });

  it('rejects an owner that looks like a flag', async () => {
    const deps = makeDeps();
    const { gh_repo_list } = createSandboxGitTools(deps);
    const result = await gh_repo_list.execute!({ owner: '--limit=999' }, {} as never);
    expect(result).toMatchObject({ success: false });
    expect(deps.gitRunDeps.acquireSandbox).not.toHaveBeenCalled();
  });
});

describe('gh_repo_fork', () => {
  it('forks without cloning or adding a remote', async () => {
    const deps = makeDeps();
    const { gh_repo_fork } = createSandboxGitTools(deps);
    await gh_repo_fork.execute!({ repo: 'acme/webapp' }, {} as never);
    const calls = getRunCalls(deps);
    expect(calls[0].args).toEqual(['repo', 'fork', 'acme/webapp', '--clone=false', '--remote=false']);
  });

  it('rejects a repo that looks like a flag', async () => {
    const deps = makeDeps();
    const { gh_repo_fork } = createSandboxGitTools(deps);
    const result = await gh_repo_fork.execute!({ repo: '--clone=true' }, {} as never);
    expect(result).toMatchObject({ success: false });
    expect(deps.gitRunDeps.acquireSandbox).not.toHaveBeenCalled();
  });
});

describe('gh_repo_create', () => {
  it('builds an explicit-visibility create', async () => {
    const deps = makeDeps();
    const { gh_repo_create } = createSandboxGitTools(deps);
    await gh_repo_create.execute!(
      { name: 'my-tool', visibility: 'private', description: 'A tool' },
      {} as never,
    );
    const calls = getRunCalls(deps);
    expect(calls[0].args).toEqual(['repo', 'create', 'my-tool', '--private', '--description', 'A tool']);
  });

  it('rejects a name with flag-like characters', async () => {
    const deps = makeDeps();
    const { gh_repo_create } = createSandboxGitTools(deps);
    const result = await gh_repo_create.execute!(
      { name: '--source=.', visibility: 'private' },
      {} as never,
    );
    expect(result).toMatchObject({ success: false });
    expect(deps.gitRunDeps.acquireSandbox).not.toHaveBeenCalled();
  });

  it('rejects a name with a leading hyphen (flag injection)', async () => {
    const deps = makeDeps();
    const { gh_repo_create } = createSandboxGitTools(deps);
    const result = await gh_repo_create.execute!(
      { name: '--private', visibility: 'private' },
      {} as never,
    );
    expect(result).toMatchObject({ success: false });
    expect(deps.gitRunDeps.acquireSandbox).not.toHaveBeenCalled();
  });

  it('requires visibility in the schema', () => {
    const { gh_repo_create } = createSandboxGitTools(makeDeps());
    const parse = (gh_repo_create.inputSchema as { safeParse: (v: unknown) => { success: boolean } }).safeParse;
    expect(parse({ name: 'my-tool' }).success).toBe(false);
    expect(parse({ name: 'my-tool', visibility: 'public' }).success).toBe(true);
  });
});

describe('gh_search', () => {
  it('uses issue-shaped json fields for prs, with query last after a "--" separator', async () => {
    const deps = makeDeps();
    const { gh_search } = createSandboxGitTools(deps);
    await gh_search.execute!({ type: 'prs', query: 'fix login repo:acme/webapp' }, {} as never);
    const calls = getRunCalls(deps);
    expect(calls[0].args).toEqual([
      'search', 'prs', '--limit', '20', '--json', 'number,title,state,url,repository',
      '--', 'fix login repo:acme/webapp',
    ]);
  });

  it('uses code-shaped json fields for code', async () => {
    const deps = makeDeps();
    const { gh_search } = createSandboxGitTools(deps);
    await gh_search.execute!({ type: 'code', query: 'useState repo:acme/webapp' }, {} as never);
    const calls = getRunCalls(deps);
    expect(calls[0].args[calls[0].args.indexOf('--json') + 1]).toBe('repository,path,url');
  });

  it('places a leading-hyphen query after the "--" separator rather than letting it be parsed as a flag', async () => {
    const deps = makeDeps();
    const { gh_search } = createSandboxGitTools(deps);
    await gh_search.execute!({ type: 'code', query: '-1 test' }, {} as never);
    const calls = getRunCalls(deps);
    const dashDashIndex = calls[0].args.indexOf('--');
    const queryIndex = calls[0].args.indexOf('-1 test');
    expect(dashDashIndex).toBeGreaterThan(-1);
    expect(queryIndex).toBe(dashDashIndex + 1);
    expect(queryIndex).toBe(calls[0].args.length - 1);
  });
});

describe('gh_label_list', () => {
  it('scopes to an explicit repo when given', async () => {
    const deps = makeDeps();
    const { gh_label_list } = createSandboxGitTools(deps);
    await gh_label_list.execute!({ repo: 'acme/webapp' }, {} as never);
    const calls = getRunCalls(deps);
    expect(calls[0].args).toEqual([
      'label', 'list', '--repo', 'acme/webapp', '--limit', '50', '--json', 'name,description,color',
    ]);
  });
});

// ── cwd threading ────────────────────────────────────────────────────────────

describe('cwd threading', () => {
  it('git_status forwards cwd into the runner, resolved under /workspace', async () => {
    const deps = makeDeps();
    const { git_status } = createSandboxGitTools(deps);
    await git_status.execute!({ cwd: 'repo' }, {} as never);
    const calls = getRunCalls(deps);
    expect((calls[0] as unknown as { cwd: string }).cwd).toBe('/workspace/repo');
  });

  it('git_commit forwards cwd into the runner', async () => {
    const deps = makeDeps();
    const { git_commit } = createSandboxGitTools(deps);
    await git_commit.execute!({ message: 'msg', cwd: 'repo' }, {} as never);
    const calls = getRunCalls(deps);
    expect((calls[0] as unknown as { cwd: string }).cwd).toBe('/workspace/repo');
  });

  it('gh_pr_create forwards cwd into the runner', async () => {
    const deps = makeDeps();
    const { gh_pr_create } = createSandboxGitTools(deps);
    await gh_pr_create.execute!({ title: 'PR', body: 'b', cwd: 'repo' }, {} as never);
    const calls = getRunCalls(deps);
    expect((calls[0] as unknown as { cwd: string }).cwd).toBe('/workspace/repo');
  });

  it('defaults to the sandbox root when no cwd is given', async () => {
    const deps = makeDeps();
    const { git_status } = createSandboxGitTools(deps);
    await git_status.execute!({}, {} as never);
    const calls = getRunCalls(deps);
    expect((calls[0] as unknown as { cwd: string }).cwd).toBe('/workspace');
  });
});

// ── active machine access ───────────────────────────────────────────────────

describe('active machine access', () => {
  it('git_status: given the resolved active machine is no longer accessible, should deny without acquiring a sandbox', async () => {
    const deps = makeDeps();
    deps.machines.listMachines = vi.fn().mockResolvedValue([{ kind: 'existing', machineId: 't1' }]);
    deps.machines.isMachineAccessible = vi.fn().mockResolvedValue({ allowed: false });
    const { git_status } = createSandboxGitTools(deps);
    const result = await git_status.execute!({}, {} as never);
    expect(result).toMatchObject({ success: false });
    expect(deps.gitRunDeps.acquireSandbox).not.toHaveBeenCalled();
  });

  it('git_status: given no configured machines (machineAccess off), should deny instead of falling back to the own machine', async () => {
    const deps = makeDeps();
    // createMachineDirectory.listMachines returns [] exactly when machineAccess
    // is off — this must deny the call, not silently resolve to { kind: 'own' }
    // (which used to key an implicit persistent machine off the agent's own
    // page, bypassing the machineAccess gate entirely).
    deps.machines.listMachines = vi.fn().mockResolvedValue([]);
    const { git_status } = createSandboxGitTools(deps);
    const result = await git_status.execute!({}, {} as never);
    expect(result).toMatchObject({ success: false });
    expect(deps.gitRunDeps.acquireSandbox).not.toHaveBeenCalled();
  });

  it('git_status: given machines has no resolveDriveId/resolveTenantId, should use the ambient ctx.driveId/tenantId unchanged', async () => {
    const deps = makeDeps();
    const { git_status } = createSandboxGitTools(deps);
    await git_status.execute!({}, {} as never);
    expect(deps.gitRunDeps.acquireSandbox).toHaveBeenCalledWith(
      expect.objectContaining({ driveId: 'd1', tenantId: 't1' }),
    );
  });

  it('git_status: given machines provides resolveDriveId/resolveTenantId (existing machine in another drive), should override both — mirroring sandbox-tools.ts so git tools attach to the same session as bash/file tools', async () => {
    const deps = makeDeps();
    deps.machines.listMachines = vi.fn().mockResolvedValue([{ kind: 'existing', machineId: 't1' }]);
    deps.machines.resolveDriveId = vi.fn().mockResolvedValue('home-drive-1');
    deps.machines.resolveTenantId = vi.fn().mockResolvedValue('real-drive-owner');
    const { git_status } = createSandboxGitTools(deps);
    await git_status.execute!({}, {} as never);
    expect(deps.gitRunDeps.acquireSandbox).toHaveBeenCalledWith(
      expect.objectContaining({ driveId: 'home-drive-1', tenantId: 'real-drive-owner' }),
    );
  });
});

// ── schema strictness ────────────────────────────────────────────────────

describe('schema strictness', () => {
  function safeParse(schema: unknown, value: unknown) {
    return (schema as { safeParse: (v: unknown) => { success: boolean } }).safeParse(value);
  }

  it('git_status: given an unrecognized field, should reject instead of silently dropping it', () => {
    const { git_status } = createSandboxGitTools(makeDeps());
    expect(safeParse(git_status.inputSchema, { cwd: 'repo', bogus: true }).success).toBe(false);
    expect(safeParse(git_status.inputSchema, { cwd: 'repo' }).success).toBe(true);
  });

  it('git_add (refine-wrapped schema): given an unrecognized field, should reject instead of silently dropping it', () => {
    const { git_add } = createSandboxGitTools(makeDeps());
    expect(safeParse(git_add.inputSchema, { all: true, bogus: true }).success).toBe(false);
    expect(safeParse(git_add.inputSchema, { all: true }).success).toBe(true);
  });

  it('git_clone (field-level refine on repo_url): given an unrecognized field, should reject; a valid HTTPS url still passes', () => {
    const { git_clone } = createSandboxGitTools(makeDeps());
    expect(
      safeParse(git_clone.inputSchema, { repo_url: 'https://github.com/o/r.git', bogus: true }).success,
    ).toBe(false);
    expect(safeParse(git_clone.inputSchema, { repo_url: 'https://github.com/o/r.git' }).success).toBe(true);
  });

  it('gh_pr_create: given an unrecognized field, should reject instead of silently dropping it', () => {
    const { gh_pr_create } = createSandboxGitTools(makeDeps());
    expect(safeParse(gh_pr_create.inputSchema, { title: 't', body: 'b', bogus: true }).success).toBe(false);
    expect(safeParse(gh_pr_create.inputSchema, { title: 't', body: 'b' }).success).toBe(true);
  });
});

// ── tool count ─────────────────────────────────────────────────────────────

describe('createSandboxGitTools', () => {
  it('exports exactly 56 tools', () => {
    const deps = makeDeps();
    const tools = createSandboxGitTools(deps);
    expect(Object.keys(tools)).toHaveLength(56);
  });

  it('SANDBOX_GIT_TOOL_NAMES stays in sync with the factory output', () => {
    const deps = makeDeps();
    const tools = createSandboxGitTools(deps);
    expect([...SANDBOX_GIT_TOOL_NAMES].sort()).toEqual(Object.keys(tools).sort());
  });

  it('no tool passes sh or -c as the cmd or first arg', async () => {
    const deps = makeDeps();
    const tools = createSandboxGitTools(deps);
    // Run a quick execute on tools that accept empty inputs to collect cmd values
    await tools.git_status.execute!({}, {} as never);
    await tools.git_diff.execute!({}, {} as never);
    const calls = getRunCalls(deps);
    for (const call of calls) {
      expect(call.cmd).not.toBe('sh');
      expect(call.args[0]).not.toBe('-c');
    }
  });
});

// ── machine-pane binding: node scope + target addressing ───────────────────
//
// git ran at the machine root for EVERY bound conversation, branch or not: the
// git open() never threaded the binding's cwd or its branchSandbox onto the
// actor ctx, so a branch-bound pane's `git status` silently reported the
// machine checkout. These pin both halves plus target addressing, which the
// generator wires into all 56 tools at once.

describe('machine-pane binding (git)', () => {
  const MACHINE: MachineNodeHandle = { kind: 'machine', machineId: 'm1', cwd: '/workspace' };
  const PROJECT: MachineNodeHandle = {
    kind: 'project',
    machineId: 'm1',
    project: 'repo',
    cwd: '/workspace/projects/repo',
  };
  const BRANCH: MachineNodeHandle = {
    kind: 'branch',
    machineId: 'm1',
    project: 'repo',
    branch: 'feature',
    cwd: '/workspace/repo',
    branchSandbox: { machineBranchId: 'branch-1', sandboxId: 'sbx-1' },
  };
  const machineRootBinding: MachineNodeHandleSet = { self: MACHINE, handles: [MACHINE, PROJECT, BRANCH] };
  const branchBinding: MachineNodeHandleSet = { self: BRANCH, handles: [BRANCH] };

  function ctxOf(machineBinding: MachineNodeHandleSet) {
    return { experimental_context: { userId: 'u1', machineBinding } } as never;
  }

  it('given a branch-bound conversation, should acquire the BRANCH Sprite — not the machine root', async () => {
    const deps = makeDeps();
    const { git_status } = createSandboxGitTools(deps);
    await git_status.execute!({}, ctxOf(branchBinding));
    expect(deps.gitRunDeps.acquireSandbox).toHaveBeenCalledWith(
      expect.objectContaining({ branchSandbox: { machineId: 'm1', machineBranchId: 'branch-1' } }),
    );
  });

  it('given a branch-bound conversation and no explicit cwd, should run in the branch checkout', async () => {
    const deps = makeDeps();
    const { git_status } = createSandboxGitTools(deps);
    await git_status.execute!({}, ctxOf(branchBinding));
    expect(getRunCalls(deps)[0]).toMatchObject({ cwd: '/workspace/repo' });
  });

  it('given an unbound conversation, should carry no branchSandbox (unchanged behaviour)', async () => {
    const deps = makeDeps();
    const { git_status } = createSandboxGitTools(deps);
    await git_status.execute!({}, {} as never);
    expect(deps.gitRunDeps.acquireSandbox).toHaveBeenCalledWith(
      expect.objectContaining({ branchSandbox: undefined }),
    );
  });

  it('given target { project }, should run at the project checkout on the machine Sprite', async () => {
    const deps = makeDeps();
    const { git_status } = createSandboxGitTools(deps);
    await git_status.execute!({ target: { project: 'repo' } }, ctxOf(machineRootBinding));
    expect(getRunCalls(deps)[0]).toMatchObject({ cwd: '/workspace/projects/repo' });
    expect(deps.gitRunDeps.acquireSandbox).toHaveBeenCalledWith(
      expect.objectContaining({ branchSandbox: undefined }),
    );
  });

  it('given target { branch }, should route to the branch Sprite (token path too)', async () => {
    const deps = makeDeps();
    const { gh_pr_list } = createSandboxGitTools(deps);
    await gh_pr_list.execute!({ target: { project: 'repo', branch: 'feature' } }, ctxOf(machineRootBinding));
    expect(deps.gitRunDeps.acquireSandbox).toHaveBeenCalledWith(
      expect.objectContaining({ branchSandbox: { machineId: 'm1', machineBranchId: 'branch-1' } }),
    );
  });

  it('given an explicit cwd alongside a target, the explicit cwd should still win', async () => {
    const deps = makeDeps();
    const { git_status } = createSandboxGitTools(deps);
    await git_status.execute!({ cwd: 'sub', target: { project: 'repo' } }, ctxOf(machineRootBinding));
    expect(getRunCalls(deps)[0]).toMatchObject({ cwd: '/workspace/sub' });
  });

  it('given a target outside the derived set, should deny without acquiring a sandbox', async () => {
    const deps = makeDeps();
    const { git_status } = createSandboxGitTools(deps);
    const result = await git_status.execute!({ target: { project: 'sibling' } }, ctxOf(branchBinding));
    expect(result).toMatchObject({ success: false });
    expect(deps.gitRunDeps.acquireSandbox).not.toHaveBeenCalled();
  });

  // Every row's schema is strict, so an unknown key is reported as
  // `unrecognized_keys`. `target` must never be reported that way — for any of
  // the 56 tools, whatever else their own required fields say.
  it('every git tool should recognize an optional target (one generator change, all 56)', () => {
    const tools = createSandboxGitTools(makeDeps());
    for (const [name, t] of Object.entries(tools)) {
      const schema = t.inputSchema as unknown as {
        safeParse: (v: unknown) => { success: boolean; error?: { issues: Array<{ code: string; keys?: string[] }> } };
      };
      const parsed = schema.safeParse({ target: { project: 'repo' } });
      const rejectedTarget = (parsed.error?.issues ?? []).some(
        (issue) => issue.code === 'unrecognized_keys' && (issue.keys ?? []).includes('target'),
      );
      expect(rejectedTarget, `${name} should recognize target`).toBe(false);
    }
  });
});
