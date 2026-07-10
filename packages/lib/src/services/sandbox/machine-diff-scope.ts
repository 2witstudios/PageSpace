/**
 * Machine Diff scope resolution — the PURE core of the Diff tab's 3-way scope
 * service (Machine page rebuild, Phase 1). Zero I/O: every function here is a
 * plain data transformation, unit-testable with no sandbox, no mocks, no DI.
 * The imperative shell that actually runs git / reads blobs lives in
 * `./machine-diff.ts`; keep it that way — this split is the repo's
 * pure-functions-plus-DI build mandate, not a style preference.
 *
 * The three scopes and their exact semantics:
 *
 *   uncommitted — working tree vs the last commit.
 *     File list: `git status --porcelain -z -uall` (see STATUS_PORCELAIN_ARGS
 *     for why `-uall`).
 *     original = blob at HEAD, modified = working-tree file.
 *
 *   committed — the branch's own commits vs where it forked from the main
 *     branch.
 *     File list: `git diff --name-status -z <base>...HEAD` (git's three-dot
 *     form IS merge-base(<base>, HEAD)..HEAD — git computes the merge-base
 *     itself, which is what keeps this resolvable without I/O).
 *     original = blob at the merge-base, modified = blob at HEAD.
 *
 *   branch — everything the branch differs from the main branch, INCLUDING
 *     uncommitted working-tree changes.
 *     File list: `git diff --name-status -z --merge-base <base>` (one ref, no
 *     second side — `--merge-base <commit>` compares the WORKING TREE against
 *     merge-base(<commit>, HEAD)) UNIONED with the untracked working-tree
 *     files from `git status --porcelain -z -uall`. `git diff` lists only TRACKED
 *     differences, so a brand-new never-added file would otherwise be missing
 *     from a scope that is documented to include all uncommitted working-tree
 *     changes; `untrackedArgs` on the resolution below supplies exactly that
 *     gap. Untracked paths normally cannot collide with the diff's tracked
 *     paths, but the shell dedups by path anyway (tracked entry wins) to cover
 *     the pathological deleted-from-index-yet-present-untracked case.
 *     original = blob at the merge-base, modified = working-tree file.
 *
 * On the main branch itself, 'committed' and 'branch' are meaningless — the
 * merge-base of the main branch with itself is its own tip, so both scopes
 * would always diff to nothing. `resolveDiffScope` returns
 * `{ notApplicable: true }` for those two, NOT empty gitArgs the caller would
 * have to interpret, so the route can tell the client to disable the toggle
 * instead of rendering an empty diff.
 *
 * The diff BASE is `origin/HEAD`, not a guessed 'master'/'main' literal: a
 * branch terminal's checkout is a full `git clone`
 * (`machine-branches.ts`'s `cloneAndCheckoutBranch`), and a full clone always
 * carries `origin/HEAD` as a symref to the remote's actual default branch —
 * so the base is correct whether the repo's default is master, main, or
 * anything else. The 'master'/'main' literal comparison
 * (`isMainBranchName`) answers a DIFFERENT question — "is this terminal ON
 * the main branch?" — matching the default-branch naming convention used
 * elsewhere in this codebase; there is deliberately no schema flag for it.
 *
 * Both file-list commands use `-z` (NUL-separated) output: with `-z` git never
 * C-quotes pathnames, so the parsers below handle spaces, quotes, and
 * non-ASCII filenames with one code path instead of a C-unquoting fallback.
 */

export type MachineDiffScope = 'uncommitted' | 'committed' | 'branch';

export const MACHINE_DIFF_SCOPES: readonly MachineDiffScope[] = ['uncommitted', 'committed', 'branch'];

export function isMachineDiffScope(value: string): value is MachineDiffScope {
  return (MACHINE_DIFF_SCOPES as readonly string[]).includes(value);
}

/**
 * The ref the 'committed'/'branch' scopes diff against — the remote's default
 * branch, as recorded by the full clone. See the module docstring for why
 * this is `origin/HEAD` and not a 'master'/'main' guess.
 */
export const DIFF_BASE_REF = 'origin/HEAD';

/**
 * The `git status` argv shared by the uncommitted scope's file list and the
 * branch scope's untracked supplement. `-uall` (`--untracked-files=all`) is
 * REQUIRED, not cosmetic: the default (`normal`) mode collapses a brand-new
 * untracked directory into a single `dir/` entry, which the per-file pair
 * route would then try to `readMachineFile` as a file (→ null/404) instead of
 * showing the files inside. `-uall` expands the directory into its individual
 * untracked files. `-z` keeps NUL framing so paths are never C-quoted.
 */
const STATUS_PORCELAIN_ARGS: readonly string[] = ['status', '--porcelain', '-z', '-uall'];

/**
 * Is this branch name the repo's main branch? Compared against the literal
 * default-branch names ('master'/'main', case-sensitive) — the convention this
 * codebase already uses for default-branch naming; deliberately NOT a new DB
 * column.
 */
export function isMainBranchName(branchName: string): boolean {
  return branchName === 'master' || branchName === 'main';
}

export type MachineDiffScopeResolution =
  | {
      /** The git argv whose stdout is the scope's primary changed-file list. */
      gitArgs: string[];
      /**
       * Present ONLY for 'branch' scope: a second git argv whose untracked
       * (`??`) entries are appended to the list (parsed via
       * `parseUntrackedPorcelainZ`), because `gitArgs`' `git diff` omits
       * untracked working-tree files. See the module docstring.
       */
      untrackedArgs?: string[];
    }
  | { notApplicable: true };

/**
 * Resolve a requested Diff scope to the exact `git` argv that produces its
 * changed-file list — or `{ notApplicable: true }` when the scope is
 * meaningless on the main branch.
 *
 * `isMainBranch` is the caller's own derivation (from `isMainBranchName`),
 * kept explicit in the signature so the decision is visible at the call site;
 * `branchName` is still re-checked here so a caller passing a stale or wrong
 * flag can never get a self-merge-base diff for a main-branch terminal.
 */
export function resolveDiffScope(
  branchName: string,
  isMainBranch: boolean,
  requestedScope: MachineDiffScope,
): MachineDiffScopeResolution {
  const onMainBranch = isMainBranch || isMainBranchName(branchName);
  if (onMainBranch && requestedScope !== 'uncommitted') {
    return { notApplicable: true };
  }
  switch (requestedScope) {
    case 'uncommitted':
      return { gitArgs: [...STATUS_PORCELAIN_ARGS] };
    case 'committed':
      return { gitArgs: ['diff', '--name-status', '-z', `${DIFF_BASE_REF}...HEAD`] };
    case 'branch':
      return {
        gitArgs: ['diff', '--name-status', '-z', '--merge-base', DIFF_BASE_REF],
        untrackedArgs: [...STATUS_PORCELAIN_ARGS],
      };
  }
}

/** Where each side of a file's diff pair is read from, per scope. */
export type MachineDiffSideSource = 'merge-base-blob' | 'head-blob' | 'working-tree';

export interface MachineDiffSides {
  original: MachineDiffSideSource;
  modified: MachineDiffSideSource;
}

/**
 * The original/modified content source for each scope — the pure counterpart
 * of the file-list resolution above, consumed by `machine-diff.ts`'s
 * `readMachineDiffPair`. Blob sides go through the git object store
 * (`machine-git-blob.ts`), working-tree sides through the live filesystem
 * (`machine-fs.ts`) — see those modules' scope-boundary notes.
 */
export function diffScopeSides(scope: MachineDiffScope): MachineDiffSides {
  switch (scope) {
    case 'uncommitted':
      return { original: 'head-blob', modified: 'working-tree' };
    case 'committed':
      return { original: 'merge-base-blob', modified: 'head-blob' };
    case 'branch':
      return { original: 'merge-base-blob', modified: 'working-tree' };
  }
}

export type MachineDiffFileStatus = 'added' | 'modified' | 'deleted' | 'renamed';

export const MACHINE_DIFF_FILE_STATUSES: readonly MachineDiffFileStatus[] = [
  'added',
  'modified',
  'deleted',
  'renamed',
];

export function isMachineDiffFileStatus(value: string): value is MachineDiffFileStatus {
  return (MACHINE_DIFF_FILE_STATUSES as readonly string[]).includes(value);
}

export interface MachineDiffFile {
  /** Repo-relative path (the rename/copy TARGET for renamed entries). */
  path: string;
  status: MachineDiffFileStatus;
  /** The rename/copy SOURCE path, present only for renamed/copied entries. */
  previousPath?: string;
}

function statusFromPorcelainXY(x: string, y: string): MachineDiffFileStatus {
  if (x === '?' && y === '?') return 'added';
  if (x === 'D' || y === 'D') return 'deleted';
  if (x === 'R' || y === 'R') return 'renamed';
  // 'C' (copy): the target is a NEW file — the source still exists.
  if (x === 'A' || y === 'A' || x === 'C') return 'added';
  return 'modified';
}

/**
 * Every complete `-z` entry ends in NUL, so complete output always splits to
 * a trailing '' — a non-empty final token is a field the 256 KB
 * `runGitInSandbox` output cap cut mid-way, and is dropped rather than parsed
 * as a bogus short path (the caller surfaces the run's `truncated` flag
 * alongside the parsed list).
 */
function splitZDroppingTruncatedTail(stdout: string): string[] {
  const tokens = stdout.split('\0');
  tokens.pop();
  return tokens;
}

/**
 * Parse `git status --porcelain -z` output into the uncommitted-scope file
 * list. Entry format: `XY<SP><path>NUL`, and for a rename/copy the SOURCE
 * path follows as its own NUL-terminated field: `XY<SP><target>NUL<source>NUL`
 * (note: target FIRST — the reverse of `git diff --name-status -z`).
 *
 * A malformed or partial trailing entry (see `splitZDroppingTruncatedTail`)
 * is dropped rather than guessed at.
 */
export function parseStatusPorcelainZ(stdout: string): MachineDiffFile[] {
  const tokens = splitZDroppingTruncatedTail(stdout);
  const files: MachineDiffFile[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    // Shortest valid entry is 'XY p' (4 chars); anything shorter is the empty
    // trailing split or a truncated tail.
    if (token.length < 4 || token[2] !== ' ') continue;
    const x = token[0];
    const y = token[1];
    const path = token.slice(3);
    let previousPath: string | undefined;
    if (x === 'R' || x === 'C') {
      previousPath = tokens[i + 1];
      i++;
      if (previousPath === undefined || previousPath.length === 0) continue; // truncated tail
    }
    files.push({
      path,
      status: statusFromPorcelainXY(x, y),
      ...(previousPath !== undefined ? { previousPath } : {}),
    });
  }
  return files;
}

/**
 * Parse ONLY the untracked (`?? <path>`) entries from `git status
 * --porcelain -z`, each as an 'added' file. This is the 'branch' scope's
 * untracked-file supplement: `git diff --merge-base` lists every TRACKED
 * difference from the merge-base but omits untracked working-tree files, so
 * these are appended to complete the scope (see the module docstring).
 *
 * Tracked entries (modified/deleted/added/renamed) are skipped — they are
 * already covered by the diff. A rename/copy entry (never untracked) carries a
 * trailing source field, so its second token is stepped over to keep the
 * source path from being mis-read as a standalone entry. A truncated trailing
 * entry is dropped via `splitZDroppingTruncatedTail`.
 */
export function parseUntrackedPorcelainZ(stdout: string): MachineDiffFile[] {
  const tokens = splitZDroppingTruncatedTail(stdout);
  const files: MachineDiffFile[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (token.length < 4 || token[2] !== ' ') continue;
    const x = token[0];
    const y = token[1];
    // Rename/copy entries carry a NUL-separated source path as the next token.
    if (x === 'R' || x === 'C') {
      i++;
      continue;
    }
    if (x === '?' && y === '?') {
      files.push({ path: token.slice(3), status: 'added' });
    }
  }
  return files;
}

function statusFromNameStatusLetter(letter: string): MachineDiffFileStatus {
  if (letter === 'A') return 'added';
  if (letter === 'D') return 'deleted';
  // T (type change), M, U (unmerged) all render as a content diff.
  return 'modified';
}

/**
 * Parse `git diff --name-status -z` output into the committed/branch-scope
 * file list. Entry format: `<status>NUL<path>NUL`, and for a rename/copy
 * (`R<score>`/`C<score>`): `<status>NUL<source>NUL<target>NUL` (source FIRST —
 * the reverse of `git status --porcelain -z`).
 */
export function parseNameStatusZ(stdout: string): MachineDiffFile[] {
  const tokens = splitZDroppingTruncatedTail(stdout);
  const files: MachineDiffFile[] = [];
  let i = 0;
  while (i < tokens.length) {
    const status = tokens[i];
    if (status === undefined || status.length === 0) {
      i++;
      continue;
    }
    const letter = status[0];
    if (letter === 'R' || letter === 'C') {
      const source = tokens[i + 1];
      const target = tokens[i + 2];
      if (source === undefined || source.length === 0 || target === undefined || target.length === 0) break; // truncated tail
      files.push({
        path: target,
        // A copy's target is a new file; a rename's target replaced its source.
        status: letter === 'R' ? 'renamed' : 'added',
        previousPath: source,
      });
      i += 3;
      continue;
    }
    const path = tokens[i + 1];
    if (path === undefined || path.length === 0) break; // truncated tail
    files.push({ path, status: statusFromNameStatusLetter(letter) });
    i += 2;
  }
  return files;
}
