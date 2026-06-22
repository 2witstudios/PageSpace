import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createSandboxGitTools } from '../sandbox-git-tools';
import type { GitSandboxToolsDeps } from '../sandbox-git-tools';

const mockRun = vi.fn();

function makeDeps(token: string | null = 'ghp_test'): GitSandboxToolsDeps {
  const runCommandCalls: Array<{ cmd: string; args: string[]; env: Record<string, string> }> = [];
  return {
    gitRunDeps: {
      isEnabled: () => true,
      acquireSandbox: vi.fn().mockResolvedValue({ ok: true, sandboxId: 'sbx-1', resumed: false }),
      reconnect: vi.fn().mockResolvedValue({
        sandboxId: 'sbx-1',
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
    expect(calls[0].args).toEqual(['clone', '--depth', '1', 'https://github.com/owner/repo.git', '.']);
  });

  it('clones into the default working directory when no path is given', async () => {
    const deps = makeDeps();
    const { git_clone } = createSandboxGitTools(deps);
    await git_clone.execute!({ repo_url: 'https://github.com/owner/repo.git' }, {} as never);
    const calls = getRunCalls(deps);
    expect(calls[0].args).toEqual(['clone', 'https://github.com/owner/repo.git', '.']);
  });

  it('uses the explicit clone path when provided', async () => {
    const deps = makeDeps();
    const { git_clone } = createSandboxGitTools(deps);
    await git_clone.execute!(
      { repo_url: 'https://github.com/owner/repo.git', path: 'repo' },
      {} as never,
    );
    const calls = getRunCalls(deps);
    expect(calls[0].args).toEqual(['clone', 'https://github.com/owner/repo.git', 'repo']);
  });
});

// ── git_init ───────────────────────────────────────────────────────────────

describe('git_init', () => {
  it('defaults to "." when no path given', async () => {
    const deps = makeDeps();
    const { git_init } = createSandboxGitTools(deps);
    await git_init.execute!({}, {} as never);
    const calls = getRunCalls(deps);
    expect(calls[0].args).toEqual(['init', '.']);
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
    await git_push.execute!({ force: true }, {} as never);
    const calls = getRunCalls(deps);
    expect(calls[0].args).toContain('--force-with-lease');
    expect(calls[0].args).not.toContain('--force');
  });

  it('includes -u when set_upstream: true', async () => {
    const deps = makeDeps();
    const { git_push } = createSandboxGitTools(deps);
    await git_push.execute!({ set_upstream: true }, {} as never);
    const calls = getRunCalls(deps);
    expect(calls[0].args).toContain('-u');
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

// ── tool count ─────────────────────────────────────────────────────────────

describe('createSandboxGitTools', () => {
  it('exports exactly 26 tools', () => {
    const deps = makeDeps();
    const tools = createSandboxGitTools(deps);
    expect(Object.keys(tools)).toHaveLength(26);
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
