import { describe, it, expect } from 'vitest';
import { listMachineDiffFiles, readMachineDiffPair, resolveMachineMergeBase } from '../machine-diff';
import type { GitSandboxRunDeps } from '../git-tool-runners';
import type { MachineHandle } from '../machine-host';
import type { SandboxActorContext } from '../tool-runners';
import type { ExecutableSandbox, RunCommandArgs, SandboxRunResult } from '../sandbox-client/types';

/**
 * The Diff service drives the real `runGitInSandbox` / `readMachineGitBlob` /
 * `readMachineFile` (none mocked — they're pure orchestration over injected
 * deps), so a fake `ExecutableSandbox` whose `runCommand` is scripted per git
 * argv, plus a fake `MachineHandle` for working-tree reads, exercises every
 * scope with zero real Sprite/git calls — the same harness shape as
 * `machine-git-blob.test.ts`.
 */

const MERGE_BASE_SHA = 'a'.repeat(40);

function makeCtx(): SandboxActorContext {
  return {
    userId: 'u1',
    tenantId: 't1',
    conversationId: 'c1',
    actorEmail: 'u1@example.com',
    tier: 'pro',
  };
}

function makeDeps(runCommand: (args: RunCommandArgs) => Promise<SandboxRunResult>): {
  deps: GitSandboxRunDeps;
  calls: Array<{ cmd: string; args: string[] }>;
} {
  const calls: Array<{ cmd: string; args: string[] }> = [];
  const sandbox: ExecutableSandbox = {
    sandboxId: 'sbx-1',
    runCommand: async (opts) => {
      calls.push({ cmd: opts.cmd, args: opts.args ?? [] });
      return runCommand(opts);
    },
    writeFiles: async () => {},
    readFileToBuffer: async () => Buffer.from(''),
    createCheckpoint: async () => {},
  };
  const deps: GitSandboxRunDeps = {
    isEnabled: () => true,
    acquireSandbox: async () => ({ ok: true, sandboxId: 'sbx-1', resumed: false }),
    reconnect: async () => sandbox,
    quota: { acquireSlot: () => true, releaseSlot: () => {} },
    buildEnv: () => ({}),
    audit: async () => {},
    now: () => new Date('2026-07-09T12:00:00.000Z'),
    resolveGitHubToken: async () => null,
  };
  return { deps, calls };
}

/** Script git responses by subcommand; anything unscripted fails the test loudly. */
function scriptGit(
  responses: Record<string, SandboxRunResult>,
): (args: RunCommandArgs) => Promise<SandboxRunResult> {
  return async (opts) => {
    const key = (opts.args ?? []).join(' ');
    const scripted = responses[key];
    if (!scripted) throw new Error(`unscripted git call: ${key}`);
    return scripted;
  };
}

function makeHandle(files: Record<string, string>): { handle: MachineHandle; reads: string[] } {
  const reads: string[] = [];
  const handle: MachineHandle = {
    machineId: 'sbx-1',
    exec: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
    writeFiles: async () => {},
    readFile: async ({ path }) => {
      reads.push(path);
      const content = files[path];
      return content === undefined ? null : Buffer.from(content, 'utf8');
    },
    createCheckpoint: async () => {},
    stream: async () => {
      throw new Error('not used');
    },
    listStreams: async () => [],
  };
  return { handle, reads };
}

const CWD = '/workspace/repo';

describe('resolveMachineMergeBase', () => {
  it('runs `git merge-base origin/HEAD HEAD` and returns the trimmed SHA', async () => {
    const { deps, calls } = makeDeps(async () => ({ exitCode: 0, stdout: `${MERGE_BASE_SHA}\n`, stderr: '' }));
    const result = await resolveMachineMergeBase({ cwd: CWD, ctx: makeCtx(), deps });
    expect(calls).toEqual([{ cmd: 'git', args: ['merge-base', 'origin/HEAD', 'HEAD'] }]);
    expect(result).toEqual({ ok: true, sha: MERGE_BASE_SHA });
  });

  it('rejects output that is not a lone SHA (it becomes a git-blob ref, so garbage must never pass)', async () => {
    const { deps } = makeDeps(async () => ({ exitCode: 0, stdout: 'not-a-sha\n', stderr: '' }));
    const result = await resolveMachineMergeBase({ cwd: CWD, ctx: makeCtx(), deps });
    expect(result).toMatchObject({ ok: false, reason: 'merge_base_failed' });
  });

  it('maps a nonzero exit (no common ancestor / missing origin/HEAD) to merge_base_failed with stderr detail', async () => {
    const { deps } = makeDeps(async () => ({
      exitCode: 128,
      stdout: '',
      stderr: "fatal: ambiguous argument 'origin/HEAD'\n",
    }));
    const result = await resolveMachineMergeBase({ cwd: CWD, ctx: makeCtx(), deps });
    expect(result).toEqual({ ok: false, reason: 'merge_base_failed', detail: "fatal: ambiguous argument 'origin/HEAD'" });
  });

  it('maps a hard runGitInSandbox failure to exec_failed', async () => {
    const { deps } = makeDeps(async () => ({ exitCode: 0, stdout: '', stderr: '' }));
    const disabled: GitSandboxRunDeps = { ...deps, isEnabled: () => false };
    const result = await resolveMachineMergeBase({ cwd: CWD, ctx: makeCtx(), deps: disabled });
    expect(result).toEqual({ ok: false, reason: 'exec_failed', detail: 'Code execution is disabled.' });
  });
});

describe('listMachineDiffFiles', () => {
  it('uncommitted: runs diff --name-status -z HEAD then the untracked supplement (no merge-base) and unions them', async () => {
    const { deps, calls } = makeDeps(
      scriptGit({
        // HEAD-vs-working-tree tracked diff (net of staged + unstaged) — matches the rendered pair.
        'diff --name-status -z HEAD': { exitCode: 0, stdout: 'M\0src/a.ts\0', stderr: '' },
        // untracked supplement; the ` M src/a.ts` tracked line is ignored, only ?? new.ts is added.
        'status --porcelain -z -uall': { exitCode: 0, stdout: ' M src/a.ts\0?? new.ts\0', stderr: '' },
      }),
    );
    const result = await listMachineDiffFiles({
      branchName: 'feature/x',
      isMainBranch: false,
      scope: 'uncommitted',
      cwd: CWD,
      ctx: makeCtx(),
      deps,
    });
    expect(calls.map((c) => c.args)).toEqual([
      ['diff', '--name-status', '-z', 'HEAD'],
      ['status', '--porcelain', '-z', '-uall'],
    ]);
    expect(result).toEqual({
      ok: true,
      notApplicable: false,
      files: [
        { path: 'src/a.ts', status: 'modified' },
        { path: 'new.ts', status: 'added' },
      ],
      truncated: false,
      mergeBase: null,
    });
  });

  it('committed: runs the three-dot name-status diff, then resolves the concrete merge-base SHA for the client', async () => {
    const { deps, calls } = makeDeps(
      scriptGit({
        'diff --name-status -z origin/HEAD...HEAD': { exitCode: 0, stdout: 'A\0src/new.ts\0M\0src/a.ts\0', stderr: '' },
        'merge-base origin/HEAD HEAD': { exitCode: 0, stdout: `${MERGE_BASE_SHA}\n`, stderr: '' },
      }),
    );
    const result = await listMachineDiffFiles({
      branchName: 'feature/x',
      isMainBranch: false,
      scope: 'committed',
      cwd: CWD,
      ctx: makeCtx(),
      deps,
    });
    expect(calls.map((c) => c.args)).toEqual([
      ['diff', '--name-status', '-z', 'origin/HEAD...HEAD'],
      ['merge-base', 'origin/HEAD', 'HEAD'],
    ]);
    expect(result).toEqual({
      ok: true,
      notApplicable: false,
      files: [
        { path: 'src/new.ts', status: 'added' },
        { path: 'src/a.ts', status: 'modified' },
      ],
      truncated: false,
      mergeBase: MERGE_BASE_SHA,
    });
  });

  it('branch: unions the --merge-base tracked diff with untracked working-tree files, then resolves the merge-base', async () => {
    const { deps, calls } = makeDeps(
      scriptGit({
        'diff --name-status -z --merge-base origin/HEAD': { exitCode: 0, stdout: 'M\0src/a.ts\0', stderr: '' },
        // `git diff` omits untracked files — the supplement supplies the brand-new one.
        'status --porcelain -z -uall': { exitCode: 0, stdout: ' M src/a.ts\0?? brand-new.ts\0', stderr: '' },
        'merge-base origin/HEAD HEAD': { exitCode: 0, stdout: `${MERGE_BASE_SHA}\n`, stderr: '' },
      }),
    );
    const result = await listMachineDiffFiles({
      branchName: 'feature/x',
      isMainBranch: false,
      scope: 'branch',
      cwd: CWD,
      ctx: makeCtx(),
      deps,
    });
    expect(calls.map((c) => c.args)).toEqual([
      ['diff', '--name-status', '-z', '--merge-base', 'origin/HEAD'],
      ['status', '--porcelain', '-z', '-uall'],
      ['merge-base', 'origin/HEAD', 'HEAD'],
    ]);
    expect(result).toEqual({
      ok: true,
      notApplicable: false,
      // tracked diff entry first, then the appended untracked file (never a tracked one)
      files: [
        { path: 'src/a.ts', status: 'modified' },
        { path: 'brand-new.ts', status: 'added' },
      ],
      truncated: false,
      mergeBase: MERGE_BASE_SHA,
    });
  });

  it('branch: dedups an untracked path that also appears in the tracked diff (tracked entry wins)', async () => {
    const { deps } = makeDeps(
      scriptGit({
        // pathological: same path deleted in the tracked diff AND present untracked on disk
        'diff --name-status -z --merge-base origin/HEAD': { exitCode: 0, stdout: 'D\0src/dup.ts\0', stderr: '' },
        'status --porcelain -z -uall': { exitCode: 0, stdout: '?? src/dup.ts\0?? src/genuinely-new.ts\0', stderr: '' },
        'merge-base origin/HEAD HEAD': { exitCode: 0, stdout: `${MERGE_BASE_SHA}\n`, stderr: '' },
      }),
    );
    const result = await listMachineDiffFiles({
      branchName: 'feature/x',
      isMainBranch: false,
      scope: 'branch',
      cwd: CWD,
      ctx: makeCtx(),
      deps,
    });
    expect(result).toEqual({
      ok: true,
      notApplicable: false,
      files: [
        { path: 'src/dup.ts', status: 'deleted' }, // tracked entry kept, not duplicated as 'added'
        { path: 'src/genuinely-new.ts', status: 'added' },
      ],
      truncated: false,
      mergeBase: MERGE_BASE_SHA,
    });
  });

  it('branch: an output-capped untracked supplement flags the whole list truncated', async () => {
    // runGitInSandbox recomputes `truncated` from real byte length (256 KB cap),
    // so the untracked run must genuinely overflow it to exercise the OR.
    const oversized = `?? ${'a'.repeat(270 * 1024)}\0`;
    const { deps } = makeDeps(
      scriptGit({
        'diff --name-status -z --merge-base origin/HEAD': { exitCode: 0, stdout: 'M\0src/a.ts\0', stderr: '' },
        'status --porcelain -z -uall': { exitCode: 0, stdout: oversized, stderr: '' },
        'merge-base origin/HEAD HEAD': { exitCode: 0, stdout: `${MERGE_BASE_SHA}\n`, stderr: '' },
      }),
    );
    const result = await listMachineDiffFiles({
      branchName: 'feature/x',
      isMainBranch: false,
      scope: 'branch',
      cwd: CWD,
      ctx: makeCtx(),
      deps,
    });
    expect(result).toMatchObject({ ok: true, notApplicable: false, truncated: true });
  });

  it('branch: a failing untracked supplement fails the whole list (exec_failed)', async () => {
    const { deps } = makeDeps(
      scriptGit({
        'diff --name-status -z --merge-base origin/HEAD': { exitCode: 0, stdout: 'M\0src/a.ts\0', stderr: '' },
        'status --porcelain -z -uall': { exitCode: 128, stdout: '', stderr: 'fatal: not a git repository\n' },
      }),
    );
    const result = await listMachineDiffFiles({
      branchName: 'feature/x',
      isMainBranch: false,
      scope: 'branch',
      cwd: CWD,
      ctx: makeCtx(),
      deps,
    });
    expect(result).toEqual({ ok: false, reason: 'exec_failed', detail: 'fatal: not a git repository' });
  });

  it('committed on the main branch: notApplicable, and git is never invoked', async () => {
    const { deps, calls } = makeDeps(async () => {
      throw new Error('must not run');
    });
    const result = await listMachineDiffFiles({
      branchName: 'master',
      isMainBranch: true,
      scope: 'committed',
      cwd: CWD,
      ctx: makeCtx(),
      deps,
    });
    expect(result).toEqual({ ok: true, notApplicable: true });
    expect(calls).toHaveLength(0);
  });

  it('propagates a failed merge-base resolution instead of returning a list without it', async () => {
    const { deps } = makeDeps(
      scriptGit({
        'diff --name-status -z origin/HEAD...HEAD': { exitCode: 0, stdout: 'M\0src/a.ts\0', stderr: '' },
        'merge-base origin/HEAD HEAD': { exitCode: 1, stdout: '', stderr: '' },
      }),
    );
    const result = await listMachineDiffFiles({
      branchName: 'feature/x',
      isMainBranch: false,
      scope: 'committed',
      cwd: CWD,
      ctx: makeCtx(),
      deps,
    });
    expect(result).toMatchObject({ ok: false, reason: 'merge_base_failed' });
  });

  it('maps a failing diff command to exec_failed with stderr detail', async () => {
    const { deps } = makeDeps(
      scriptGit({
        'diff --name-status -z HEAD': { exitCode: 128, stdout: '', stderr: 'fatal: not a git repository\n' },
      }),
    );
    const result = await listMachineDiffFiles({
      branchName: 'feature/x',
      isMainBranch: false,
      scope: 'uncommitted',
      cwd: CWD,
      ctx: makeCtx(),
      deps,
    });
    expect(result).toEqual({ ok: false, reason: 'exec_failed', detail: 'fatal: not a git repository' });
  });
});

describe('readMachineDiffPair', () => {
  const PAIR_BASE = {
    path: 'src/a.ts',
    workingTreePath: `${CWD}/src/a.ts`,
    cwd: CWD,
  };

  it('uncommitted: original = HEAD blob (git show), modified = working tree (handle.readFile); no merge-base run', async () => {
    const { deps, calls } = makeDeps(
      scriptGit({ 'show HEAD:src/a.ts': { exitCode: 0, stdout: 'old content', stderr: '' } }),
    );
    const { handle, reads } = makeHandle({ [`${CWD}/src/a.ts`]: 'new content' });
    const result = await readMachineDiffPair({
      branchName: 'feature/x',
      isMainBranch: false,
      scope: 'uncommitted',
      ...PAIR_BASE,
      handle,
      ctx: makeCtx(),
      deps,
    });
    expect(calls).toEqual([{ cmd: 'git', args: ['show', 'HEAD:src/a.ts'] }]);
    expect(reads).toEqual([`${CWD}/src/a.ts`]);
    expect(result).toEqual({
      ok: true,
      notApplicable: false,
      original: { content: 'old content', truncated: false },
      modified: { content: 'new content', truncated: false },
    });
  });

  it('committed: original = merge-base blob, modified = HEAD blob; the working tree is never read', async () => {
    const { deps, calls } = makeDeps(
      scriptGit({
        'merge-base origin/HEAD HEAD': { exitCode: 0, stdout: `${MERGE_BASE_SHA}\n`, stderr: '' },
        [`show ${MERGE_BASE_SHA}:src/a.ts`]: { exitCode: 0, stdout: 'base content', stderr: '' },
        'show HEAD:src/a.ts': { exitCode: 0, stdout: 'head content', stderr: '' },
      }),
    );
    const { handle, reads } = makeHandle({});
    const result = await readMachineDiffPair({
      branchName: 'feature/x',
      isMainBranch: false,
      scope: 'committed',
      ...PAIR_BASE,
      handle,
      ctx: makeCtx(),
      deps,
    });
    expect(calls.map((c) => c.args)).toEqual([
      ['merge-base', 'origin/HEAD', 'HEAD'],
      ['show', `${MERGE_BASE_SHA}:src/a.ts`],
      ['show', 'HEAD:src/a.ts'],
    ]);
    expect(reads).toHaveLength(0);
    expect(result).toEqual({
      ok: true,
      notApplicable: false,
      original: { content: 'base content', truncated: false },
      modified: { content: 'head content', truncated: false },
    });
  });

  it('branch: original = merge-base blob, modified = working tree', async () => {
    const { deps, calls } = makeDeps(
      scriptGit({
        'merge-base origin/HEAD HEAD': { exitCode: 0, stdout: `${MERGE_BASE_SHA}\n`, stderr: '' },
        [`show ${MERGE_BASE_SHA}:src/a.ts`]: { exitCode: 0, stdout: 'base content', stderr: '' },
      }),
    );
    const { handle, reads } = makeHandle({ [`${CWD}/src/a.ts`]: 'tree content' });
    const result = await readMachineDiffPair({
      branchName: 'feature/x',
      isMainBranch: false,
      scope: 'branch',
      ...PAIR_BASE,
      handle,
      ctx: makeCtx(),
      deps,
    });
    expect(calls.map((c) => c.args)).toEqual([
      ['merge-base', 'origin/HEAD', 'HEAD'],
      ['show', `${MERGE_BASE_SHA}:src/a.ts`],
    ]);
    expect(reads).toEqual([`${CWD}/src/a.ts`]);
    expect(result).toEqual({
      ok: true,
      notApplicable: false,
      original: { content: 'base content', truncated: false },
      modified: { content: 'tree content', truncated: false },
    });
  });

  it('renamed file (committed): reads the original from previousPath, the modified from the target path', async () => {
    const { deps, calls } = makeDeps(
      scriptGit({
        'merge-base origin/HEAD HEAD': { exitCode: 0, stdout: `${MERGE_BASE_SHA}\n`, stderr: '' },
        // original side is addressed at the PRE-rename source, not the target:
        [`show ${MERGE_BASE_SHA}:src/old-name.ts`]: { exitCode: 0, stdout: 'base content', stderr: '' },
        'show HEAD:src/new-name.ts': { exitCode: 0, stdout: 'head content', stderr: '' },
      }),
    );
    const { handle, reads } = makeHandle({});
    const result = await readMachineDiffPair({
      branchName: 'feature/x',
      isMainBranch: false,
      scope: 'committed',
      path: 'src/new-name.ts',
      previousPath: 'src/old-name.ts',
      workingTreePath: `${CWD}/src/new-name.ts`,
      cwd: CWD,
      handle,
      ctx: makeCtx(),
      deps,
    });
    expect(calls.map((c) => c.args)).toEqual([
      ['merge-base', 'origin/HEAD', 'HEAD'],
      ['show', `${MERGE_BASE_SHA}:src/old-name.ts`],
      ['show', 'HEAD:src/new-name.ts'],
    ]);
    expect(reads).toHaveLength(0);
    expect(result).toEqual({
      ok: true,
      notApplicable: false,
      original: { content: 'base content', truncated: false },
      modified: { content: 'head content', truncated: false },
    });
  });

  it('renamed file (uncommitted): original = HEAD blob at previousPath, modified = working tree at the target', async () => {
    const { deps, calls } = makeDeps(
      scriptGit({ 'show HEAD:src/old-name.ts': { exitCode: 0, stdout: 'old content', stderr: '' } }),
    );
    const { handle, reads } = makeHandle({ [`${CWD}/src/new-name.ts`]: 'renamed content' });
    const result = await readMachineDiffPair({
      branchName: 'feature/x',
      isMainBranch: false,
      scope: 'uncommitted',
      path: 'src/new-name.ts',
      previousPath: 'src/old-name.ts',
      workingTreePath: `${CWD}/src/new-name.ts`,
      cwd: CWD,
      handle,
      ctx: makeCtx(),
      deps,
    });
    expect(calls).toEqual([{ cmd: 'git', args: ['show', 'HEAD:src/old-name.ts'] }]);
    expect(reads).toEqual([`${CWD}/src/new-name.ts`]);
    expect(result).toEqual({
      ok: true,
      notApplicable: false,
      original: { content: 'old content', truncated: false },
      modified: { content: 'renamed content', truncated: false },
    });
  });

  it("status='deleted' (branch): forces the modified side null WITHOUT reading the working tree, so an untracked file masquerading at the path can't be surfaced", async () => {
    // `git rm --cached f` leaves f on disk untracked; the branch list dedups to
    // the tracked deletion, and the pair reader must not read that leftover file.
    const { deps, calls } = makeDeps(
      scriptGit({
        'merge-base origin/HEAD HEAD': { exitCode: 0, stdout: `${MERGE_BASE_SHA}\n`, stderr: '' },
        [`show ${MERGE_BASE_SHA}:src/a.ts`]: { exitCode: 0, stdout: 'base content', stderr: '' },
      }),
    );
    // handle DOES have the file on disk (the masquerading untracked leftover):
    const { handle, reads } = makeHandle({ [`${CWD}/src/a.ts`]: 'leftover untracked bytes' });
    const result = await readMachineDiffPair({
      branchName: 'feature/x',
      isMainBranch: false,
      scope: 'branch',
      status: 'deleted',
      ...PAIR_BASE,
      handle,
      ctx: makeCtx(),
      deps,
    });
    expect(calls.map((c) => c.args)).toEqual([
      ['merge-base', 'origin/HEAD', 'HEAD'],
      ['show', `${MERGE_BASE_SHA}:src/a.ts`],
    ]);
    expect(reads).toHaveLength(0); // working tree never touched for a deletion
    expect(result).toEqual({
      ok: true,
      notApplicable: false,
      original: { content: 'base content', truncated: false },
      modified: null,
    });
  });

  it("status='added': forces the original side null and skips the blob read (and merge-base) entirely", async () => {
    const { deps, calls } = makeDeps(scriptGit({})); // no git calls should happen at all
    const { handle, reads } = makeHandle({ [`${CWD}/src/a.ts`]: 'brand new' });
    const result = await readMachineDiffPair({
      branchName: 'feature/x',
      isMainBranch: false,
      scope: 'uncommitted',
      status: 'added',
      ...PAIR_BASE,
      handle,
      ctx: makeCtx(),
      deps,
    });
    expect(calls).toHaveLength(0); // original (HEAD blob) skipped; no merge-base for uncommitted
    expect(reads).toEqual([`${CWD}/src/a.ts`]);
    expect(result).toEqual({
      ok: true,
      notApplicable: false,
      original: null,
      modified: { content: 'brand new', truncated: false },
    });
  });

  it('an added file has a null original (blob not_found is not an error)', async () => {
    const { deps } = makeDeps(
      scriptGit({
        'show HEAD:src/a.ts': {
          exitCode: 128,
          stdout: '',
          stderr: "fatal: path 'src/a.ts' does not exist in 'HEAD'\n",
        },
      }),
    );
    const { handle } = makeHandle({ [`${CWD}/src/a.ts`]: 'brand new' });
    const result = await readMachineDiffPair({
      branchName: 'feature/x',
      isMainBranch: false,
      scope: 'uncommitted',
      ...PAIR_BASE,
      handle,
      ctx: makeCtx(),
      deps,
    });
    expect(result).toEqual({
      ok: true,
      notApplicable: false,
      original: null,
      modified: { content: 'brand new', truncated: false },
    });
  });

  it('a deleted file has a null modified (working-tree not_found is not an error)', async () => {
    const { deps } = makeDeps(
      scriptGit({ 'show HEAD:src/a.ts': { exitCode: 0, stdout: 'was here', stderr: '' } }),
    );
    const { handle } = makeHandle({});
    const result = await readMachineDiffPair({
      branchName: 'feature/x',
      isMainBranch: false,
      scope: 'uncommitted',
      ...PAIR_BASE,
      handle,
      ctx: makeCtx(),
      deps,
    });
    expect(result).toEqual({
      ok: true,
      notApplicable: false,
      original: { content: 'was here', truncated: false },
      modified: null,
    });
  });

  it('branch scope on the main branch: notApplicable, and nothing is executed or read', async () => {
    const { deps, calls } = makeDeps(async () => {
      throw new Error('must not run');
    });
    const { handle, reads } = makeHandle({});
    const result = await readMachineDiffPair({
      branchName: 'main',
      isMainBranch: true,
      scope: 'branch',
      ...PAIR_BASE,
      handle,
      ctx: makeCtx(),
      deps,
    });
    expect(result).toEqual({ ok: true, notApplicable: true });
    expect(calls).toHaveLength(0);
    expect(reads).toHaveLength(0);
  });

  it('propagates a blob-side execution failure as exec_failed', async () => {
    const { deps } = makeDeps(
      scriptGit({ 'show HEAD:src/a.ts': { exitCode: 1, stdout: '', stderr: 'fatal: not a git repository\n' } }),
    );
    const { handle } = makeHandle({ [`${CWD}/src/a.ts`]: 'x' });
    const result = await readMachineDiffPair({
      branchName: 'feature/x',
      isMainBranch: false,
      scope: 'uncommitted',
      ...PAIR_BASE,
      handle,
      ctx: makeCtx(),
      deps,
    });
    expect(result).toEqual({ ok: false, reason: 'exec_failed', detail: 'fatal: not a git repository' });
  });

  it('propagates a failed merge-base resolution before reading either side', async () => {
    const { deps, calls } = makeDeps(
      scriptGit({ 'merge-base origin/HEAD HEAD': { exitCode: 1, stdout: '', stderr: '' } }),
    );
    const { handle, reads } = makeHandle({});
    const result = await readMachineDiffPair({
      branchName: 'feature/x',
      isMainBranch: false,
      scope: 'committed',
      ...PAIR_BASE,
      handle,
      ctx: makeCtx(),
      deps,
    });
    expect(result).toMatchObject({ ok: false, reason: 'merge_base_failed' });
    expect(calls).toHaveLength(1);
    expect(reads).toHaveLength(0);
  });

  it('caps a working-tree side at 2 MB and marks it truncated without corrupting a split UTF-8 sequence', async () => {
    const CAP = 2 * 1024 * 1024;
    // '€' is 3 bytes; build a buffer whose cap boundary lands mid-codepoint.
    const big = '€'.repeat(Math.ceil((CAP + 16) / 3));
    const { deps } = makeDeps(
      scriptGit({ 'show HEAD:src/a.ts': { exitCode: 0, stdout: 'old', stderr: '' } }),
    );
    const { handle } = makeHandle({ [`${CWD}/src/a.ts`]: big });
    const result = await readMachineDiffPair({
      branchName: 'feature/x',
      isMainBranch: false,
      scope: 'uncommitted',
      ...PAIR_BASE,
      handle,
      ctx: makeCtx(),
      deps,
    });
    expect(result.ok).toBe(true);
    if (!result.ok || result.notApplicable) throw new Error('unreachable');
    expect(result.modified?.truncated).toBe(true);
    expect(result.modified?.content.includes('�')).toBe(false);
    expect(Buffer.byteLength(result.modified?.content ?? '', 'utf8')).toBeLessThanOrEqual(CAP);
  });
});
