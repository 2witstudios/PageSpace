/**
 * Machine Diff service — the imperative shell over `machine-diff-scope.ts`'s
 * pure scope resolution (Machine page rebuild, Phase 1 — the Diff tab's 3-way
 * scope service). Every scope decision, git argv, side mapping, and output
 * parser lives in the pure module; this file only EXECUTES what the pure core
 * resolved — through the same DI seams the merged siblings use:
 *
 *   changed-file lists / merge-base — `runGitInSandbox`
 *     (./git-tool-runners.ts), the hardened human+agent git path, NOT the
 *     AI-tool orchestration in tool-runners.ts/sandbox-tools.ts (billing
 *     holds, injection vocabulary — wrong layer for a browsing UI).
 *   git-object ('original'/'modified' blob) sides — `readMachineGitBlob`
 *     (./machine-git-blob.ts).
 *   working-tree sides — `readMachineFile` (./machine-fs.ts) against an
 *     injected `MachineHandle`.
 *
 * Like those siblings, everything here takes `GitSandboxRunDeps` +
 * `SandboxActorContext` (+ a `MachineHandle` where a working-tree side
 * exists) as injected params, so the whole service is unit-testable against a
 * scripted fake sandbox with zero real Sprite/git calls.
 *
 * MERGE-BASE: the file-list commands let git resolve the merge-base
 * internally (three-dot / `--merge-base` syntax — see the pure module), but
 * blob reads need it as a CONCRETE ref, so `resolveMachineMergeBase` runs
 * `git merge-base origin/HEAD HEAD` and validates the output is a lone SHA
 * before it is ever used as a `readMachineGitBlob` ref. The list result also
 * carries that SHA so the client can address 'original' blobs through
 * `/api/machines/git-blob` (whose contract is "a merge-base the caller
 * already computed") without re-deriving it.
 */

import { runGitInSandbox, type GitSandboxRunDeps } from './git-tool-runners';
import { readMachineGitBlob } from './machine-git-blob';
import { readMachineFile } from './machine-fs';
import type { MachineHandle } from './machine-host';
import type { SandboxActorContext } from './tool-runners';
import {
  diffScopeSides,
  parseNameStatusZ,
  parseUntrackedPorcelainZ,
  resolveDiffScope,
  DIFF_BASE_REF,
  type MachineDiffFile,
  type MachineDiffFileStatus,
  type MachineDiffScope,
  type MachineDiffSideSource,
} from './machine-diff-scope';
import { StringDecoder } from 'string_decoder';

export type MachineDiffFailure = {
  ok: false;
  reason: 'exec_failed' | 'merge_base_failed';
  detail?: string;
};

/** A full merge-base SHA (git may emit SHA-1 or SHA-256 object names). */
const MERGE_BASE_SHA_PATTERN = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;

export type ResolveMachineMergeBaseResult = { ok: true; sha: string } | MachineDiffFailure;

/**
 * Resolve the concrete merge-base SHA between the repo's default branch
 * (`origin/HEAD`) and the checked-out branch's HEAD. The output is validated
 * as a lone SHA before use — it becomes a `readMachineGitBlob` ref and a
 * client-facing value, so garbage (or a multi-line octopus result) must never
 * pass through.
 */
export async function resolveMachineMergeBase({
  cwd,
  ctx,
  deps,
}: {
  cwd: string;
  ctx: SandboxActorContext;
  deps: GitSandboxRunDeps;
}): Promise<ResolveMachineMergeBaseResult> {
  const run = await runGitInSandbox({
    cmd: 'git',
    args: ['merge-base', DIFF_BASE_REF, 'HEAD'],
    cwd,
    ctx,
    deps,
  });
  if (!run.success) return { ok: false, reason: 'exec_failed', detail: run.error };
  if (run.exitCode !== 0) {
    return { ok: false, reason: 'merge_base_failed', detail: run.stderr.trim() || undefined };
  }
  const sha = run.stdout.trim();
  if (!MERGE_BASE_SHA_PATTERN.test(sha)) {
    return { ok: false, reason: 'merge_base_failed', detail: 'merge-base did not resolve to a single commit' };
  }
  return { ok: true, sha };
}

export type ListMachineDiffFilesResult =
  | { ok: true; notApplicable: true }
  | {
      ok: true;
      notApplicable: false;
      files: MachineDiffFile[];
      /** True when the file list was cut by the sandbox output cap — the list is a prefix, not the whole diff. */
      truncated: boolean;
      /** The concrete merge-base SHA for 'committed'/'branch' scopes (a git-blob ref for 'original' sides); null for 'uncommitted'. */
      mergeBase: string | null;
    }
  | MachineDiffFailure;

/**
 * Produce the changed-file list for a scope — `{ notApplicable: true }` when
 * the pure resolution says the scope is meaningless on the main branch (no
 * git is run at all in that case).
 */
export async function listMachineDiffFiles({
  branchName,
  isMainBranch,
  scope,
  cwd,
  ctx,
  deps,
}: {
  branchName: string;
  isMainBranch: boolean;
  scope: MachineDiffScope;
  cwd: string;
  ctx: SandboxActorContext;
  deps: GitSandboxRunDeps;
}): Promise<ListMachineDiffFilesResult> {
  const resolution = resolveDiffScope(branchName, isMainBranch, scope);
  if ('notApplicable' in resolution) return { ok: true, notApplicable: true };

  const run = await runGitInSandbox({ cmd: 'git', args: resolution.gitArgs, cwd, ctx, deps });
  if (!run.success) return { ok: false, reason: 'exec_failed', detail: run.error };
  if (run.exitCode !== 0) {
    return { ok: false, reason: 'exec_failed', detail: run.stderr.trim() || undefined };
  }
  const files = parseNameStatusZ(run.stdout);
  let truncated = run.truncated;

  // uncommitted / branch scopes: their `git diff` lists only tracked
  // differences, so append the untracked working-tree files (a second run) —
  // otherwise a brand-new never-added file is invisible in a scope documented
  // to include untracked working-tree changes. Untracked paths normally can't
  // collide with the diff's tracked paths, but a path deleted from the index
  // yet still present untracked on disk can appear in both; dedup so the
  // tracked diff entry always wins and no path is listed twice.
  if (resolution.untrackedArgs) {
    const untracked = await runGitInSandbox({ cmd: 'git', args: resolution.untrackedArgs, cwd, ctx, deps });
    if (!untracked.success) return { ok: false, reason: 'exec_failed', detail: untracked.error };
    if (untracked.exitCode !== 0) {
      return { ok: false, reason: 'exec_failed', detail: untracked.stderr.trim() || undefined };
    }
    const trackedPaths = new Set(files.map((f) => f.path));
    for (const file of parseUntrackedPorcelainZ(untracked.stdout)) {
      if (!trackedPaths.has(file.path)) files.push(file);
    }
    truncated = truncated || untracked.truncated;
  }

  let mergeBase: string | null = null;
  if (scope !== 'uncommitted') {
    const resolved = await resolveMachineMergeBase({ cwd, ctx, deps });
    if (!resolved.ok) return resolved;
    mergeBase = resolved.sha;
  }
  return { ok: true, notApplicable: false, files, truncated, mergeBase };
}

export interface MachineDiffSideContent {
  content: string;
  truncated: boolean;
}

export type ReadMachineDiffPairResult =
  | { ok: true; notApplicable: true }
  | {
      ok: true;
      notApplicable: false;
      /** null = the file has no content on that side (added file's original, deleted file's modified). */
      original: MachineDiffSideContent | null;
      modified: MachineDiffSideContent | null;
    }
  | MachineDiffFailure;

/**
 * Working-tree sides are capped at the same 2 MB the Files route uses — a
 * blob side inherits `runGitInSandbox`'s smaller 256 KB stdout cap instead
 * (see machine-git-blob.ts's KNOWN TRUNCATION TRADEOFF note for why that
 * asymmetry stands).
 */
const MAX_WORKING_TREE_READ_BYTES = 2 * 1024 * 1024;

/**
 * Read ONE changed file's original/modified content pair for a scope, each
 * side from the source `diffScopeSides` resolved (merge-base blob, HEAD blob,
 * or working tree). A side that does not exist (`not_found`) is `null` — an
 * added file legitimately has no original and a deleted file no modified —
 * only a real execution failure is an error.
 *
 * RENAMES: `path` is the file's CURRENT location (the rename target — where it
 * lives in HEAD/working tree), but its ORIGINAL side lives at the pre-rename
 * source. So the 'original' blob side reads from `previousPath` when given; the
 * 'modified' side (HEAD blob or working tree) always uses `path`. Without this,
 * a pure rename's original blob would not resolve at `path` in the old ref and
 * the file would be mis-presented as an add.
 *
 * STATUS HINT: when the list `status` is provided, a 'deleted' file's modified
 * side and an 'added' file's original side are forced to `null` WITHOUT reading
 * the backend. This is load-bearing for the working-tree modified side: a file
 * deleted from the index can still sit on disk as an UNTRACKED file at the same
 * path (e.g. `git rm --cached f`), so blindly reading the working tree would
 * surface that masquerading file as the deletion's modified content and render
 * a deletion as unchanged. The list status is authoritative; honor it.
 */
export async function readMachineDiffPair({
  branchName,
  isMainBranch,
  scope,
  path,
  previousPath,
  status,
  workingTreePath,
  cwd,
  handle,
  ctx,
  deps,
}: {
  branchName: string;
  isMainBranch: boolean;
  scope: MachineDiffScope;
  /** Repo-relative path — the file's CURRENT location; addresses the 'modified' blob side inside a ref's own git tree. */
  path: string;
  /**
   * Repo-relative rename/copy SOURCE, when the file list reported one. The
   * 'original' blob side reads from here (the file's pre-rename location);
   * absent for non-renamed files, where the original side falls back to `path`.
   */
  previousPath?: string;
  /**
   * The file's status from the changed-file list. When given, a 'deleted' file
   * skips its (modified) side and an 'added' file skips its (original) side —
   * see the STATUS HINT note above. Omit to read both sides unconditionally.
   */
  status?: MachineDiffFileStatus;
  /** Absolute working-tree path, ALREADY confined under the checkout root by the caller. */
  workingTreePath: string;
  cwd: string;
  handle: MachineHandle;
  ctx: SandboxActorContext;
  deps: GitSandboxRunDeps;
}): Promise<ReadMachineDiffPairResult> {
  const resolution = resolveDiffScope(branchName, isMainBranch, scope);
  if ('notApplicable' in resolution) return { ok: true, notApplicable: true };

  const sides = diffScopeSides(scope);
  // A 'deleted' file has no modified side and an 'added' file no original side.
  const readOriginal = status !== 'added';
  const readModified = status !== 'deleted';

  let mergeBase: string | null = null;
  const needsMergeBase =
    (readOriginal && sides.original === 'merge-base-blob') ||
    (readModified && sides.modified === 'merge-base-blob');
  if (needsMergeBase) {
    const resolved = await resolveMachineMergeBase({ cwd, ctx, deps });
    if (!resolved.ok) return resolved;
    mergeBase = resolved.sha;
  }

  const readSide = async (
    source: MachineDiffSideSource,
    /** Repo-relative path for a blob side (rename source for 'original', target for 'modified'). */
    blobPath: string,
  ): Promise<{ ok: true; content: MachineDiffSideContent | null } | MachineDiffFailure> => {
    if (source === 'working-tree') {
      const result = await readMachineFile({ handle, path: workingTreePath });
      if (!result.ok) return { ok: true, content: null };
      const truncated = result.content.length > MAX_WORKING_TREE_READ_BYTES;
      const bytes = truncated ? result.content.subarray(0, MAX_WORKING_TREE_READ_BYTES) : result.content;
      // StringDecoder withholds a trailing partial UTF-8 sequence at the cap
      // instead of emitting U+FFFD — same decode the Files route uses.
      return { ok: true, content: { content: new StringDecoder('utf8').write(bytes), truncated } };
    }
    // mergeBase is always resolved above when a side needs it; the fallback
    // 'HEAD' is unreachable but keeps the ref a plain string for the compiler.
    const ref = source === 'head-blob' ? 'HEAD' : (mergeBase ?? 'HEAD');
    const result = await readMachineGitBlob({ ref, path: blobPath, cwd, ctx, deps });
    if (result.ok) return { ok: true, content: { content: result.content, truncated: result.truncated } };
    if (result.reason === 'not_found') return { ok: true, content: null };
    return { ok: false, reason: 'exec_failed', detail: result.detail };
  };

  // The original side lives at the pre-rename source when the list reported
  // one; the modified side is always the file's current path. A working-tree
  // side ignores its blobPath argument (it reads `workingTreePath`). A side the
  // status says can't exist is forced null without any read (see STATUS HINT).
  const original = readOriginal
    ? await readSide(sides.original, previousPath ?? path)
    : { ok: true as const, content: null };
  if (!original.ok) return original;
  const modified = readModified
    ? await readSide(sides.modified, path)
    : { ok: true as const, content: null };
  if (!modified.ok) return modified;

  return { ok: true, notApplicable: false, original: original.content, modified: modified.content };
}
