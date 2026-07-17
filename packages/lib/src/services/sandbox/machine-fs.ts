/**
 * Machine filesystem browse + mutate primitives (pure, DI'd).
 *
 * The human-facing Machine page's Files tab drives these against a Machine's
 * WORKING TREE — the live files on a Sprite's persistent filesystem, e.g. a
 * branch-terminal's checkout at `/workspace/repo`:
 *
 *   listMachineDirectory — one directory's immediate children ({ name, type }).
 *   readMachineFile      — one file's bytes.
 *   createMachineDirectory — mkdir a new directory.
 *   writeMachineFile     — create or overwrite a file's bytes.
 *   moveMachinePath      — rename/move a path (no-clobber).
 *   copyMachinePath      — copy a path (no-clobber).
 *   deleteMachinePath    — remove a path, recursively, idempotently.
 *
 * All seven take a `MachineHandle` (./machine-host.ts) as an INJECTED
 * dependency rather than constructing a Sprite host themselves, mirroring the
 * DI shape of `runGitInSandbox` (./git-tool-runners.ts). That keeps them
 * unit-testable against a fake handle with zero real Sprite calls, per the
 * repo's pure-functions-plus-DI build mandate.
 *
 * PATH CONTRACT: every `path`/`fromPath`/`toPath` argument here MUST already be
 * an absolute, pre-confined path — confinement (resolving `..`/symlink escapes
 * against the caller's scope root) is the calling ROUTE's job, done EXACTLY
 * ONCE before it reaches this module (PR #2039 TOCTOU lesson: never re-derive
 * or re-validate a path down here from a name/fragment).
 *
 * SCOPE BOUNDARY: this operates on the working tree ONLY — it is
 * filesystem-level and takes no git ref. A diff tab's "before" content needs
 * git-object reads, a separate git-ref-aware service that depends on this one;
 * do NOT add a ref parameter here.
 *
 * This runs commands through `MachineHandle.exec`/`readFile`/`writeFiles`,
 * deliberately NOT through the AI-agent tool-runner orchestration (billing
 * holds, injection screening, LLM-facing denial vocabulary) — that layer is
 * shaped for an agent, not a browsing UI.
 */

import type { MachineHandle } from './machine-host';

export interface MachineDirectoryEntry {
  name: string;
  /** A symlink, socket, or any non-directory node is reported as 'file'. */
  type: 'file' | 'directory';
}

export type ListMachineDirectoryResult =
  | { ok: true; entries: MachineDirectoryEntry[] }
  | { ok: false; reason: 'not_found' | 'exec_failed'; detail?: string };

export type ReadMachineFileResult =
  | { ok: true; content: Buffer }
  | { ok: false; reason: 'not_found' };

export type MutateMachinePathResult =
  | { ok: true }
  | { ok: false; reason: 'not_found' | 'already_exists' | 'exec_failed'; detail?: string };

/**
 * List a directory's immediate children on a Machine.
 *
 * Uses `ls -Ap` (one name per line; a trailing `/` marks a directory) rather
 * than parsing `ls -la`'s locale-dependent long format: `-A` drops `.`/`..` but
 * keeps dotfiles, `-p` is the POSIX "append `/` to directories" indicator, and
 * one-name-per-line survives spaces in filenames. `--` stops a path that begins
 * with `-` being read as a flag; `path` is an argv element, never shell-parsed.
 */
export async function listMachineDirectory({
  handle,
  path,
}: {
  handle: MachineHandle;
  path: string;
}): Promise<ListMachineDirectoryResult> {
  const run = await handle.exec({ cmd: 'ls', args: ['-Ap', '--', path] });
  if (run.exitCode !== 0) {
    const reason = /no such file or directory/i.test(run.stderr) ? 'not_found' : 'exec_failed';
    return { ok: false, reason, detail: run.stderr.trim() || undefined };
  }

  const entries: MachineDirectoryEntry[] = run.stdout
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) =>
      line.endsWith('/')
        ? { name: line.slice(0, -1), type: 'directory' }
        : { name: line, type: 'file' },
    );
  return { ok: true, entries };
}

/**
 * Read one file's bytes from a Machine's working tree. A thin wrapper over
 * `MachineHandle.readFile`, which returns `null` for a missing file.
 */
export async function readMachineFile({
  handle,
  path,
}: {
  handle: MachineHandle;
  path: string;
}): Promise<ReadMachineFileResult> {
  const content = await handle.readFile({ path });
  if (content === null) return { ok: false, reason: 'not_found' };
  return { ok: true, content };
}

/** Maps a failed exec's stderr to a `MutateMachinePathResult`, optionally treating a caller-supplied pattern as `already_exists` first. */
function mapMutateExecFailure(
  stderr: string,
  alreadyExistsPattern?: RegExp,
): MutateMachinePathResult {
  if (alreadyExistsPattern?.test(stderr)) {
    return { ok: false, reason: 'already_exists' };
  }
  if (/no such file or directory/i.test(stderr)) {
    return { ok: false, reason: 'not_found' };
  }
  return { ok: false, reason: 'exec_failed', detail: stderr.trim() || undefined };
}

/**
 * Create one directory on a Machine.
 *
 * `path` is an argv element, never shell-parsed; `--` stops a path that begins
 * with `-` being read as a flag (mirrors `listMachineDirectory`'s `ls` call).
 */
export async function createMachineDirectory({
  handle,
  path,
}: {
  handle: MachineHandle;
  path: string;
}): Promise<MutateMachinePathResult> {
  const run = await handle.exec({ cmd: 'mkdir', args: ['--', path] });
  if (run.exitCode !== 0) {
    return mapMutateExecFailure(run.stderr, /file exists/i);
  }
  return { ok: true };
}

/**
 * Create or overwrite one file's bytes on a Machine's working tree. A thin
 * wrapper over `MachineHandle.writeFiles`, which has no stderr channel — it
 * either resolves or throws — so a throw is folded into `exec_failed`.
 */
export async function writeMachineFile({
  handle,
  path,
  content,
}: {
  handle: MachineHandle;
  path: string;
  content: string | Uint8Array;
}): Promise<MutateMachinePathResult> {
  try {
    await handle.writeFiles([{ path, content }]);
    return { ok: true };
  } catch (error) {
    return {
      ok: false,
      reason: 'exec_failed',
      detail: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * `test -e <path> -o -L <path>` (no `--`: `test` doesn't support it, and there
 * is no injection surface here — `path` is still a discrete argv element,
 * never shell-interpolated). Used by move/copy as a no-clobber guard on the
 * destination before the real op runs.
 *
 * `-L` is required alongside `-e`: every `test` file operator except `-h`/`-L`
 * follows symlinks, so `-e` alone reports `false` for a DANGLING symlink (one
 * whose target is missing) even though the symlink itself is a real directory
 * entry sitting at `path`. Without `-L`, the guard would miss that entry and
 * let `mv`/`cp` silently clobber it.
 *
 * This is a benign TOCTOU: two execs, not one atomic op. Worst case, the
 * user's own sandbox process creates something at `toPath` in the gap between
 * this check and the following `mv`/`cp`, which then clobbers it — there is no
 * cross-tenant boundary to violate here, and path confinement already happened
 * once, upstream in the route.
 */
async function machinePathExists(handle: MachineHandle, path: string): Promise<boolean> {
  const run = await handle.exec({ cmd: 'test', args: ['-e', path, '-o', '-L', path] });
  return run.exitCode === 0;
}

/** Move (rename) `fromPath` to `toPath`, refusing to clobber an existing `toPath`. */
export async function moveMachinePath({
  handle,
  fromPath,
  toPath,
}: {
  handle: MachineHandle;
  fromPath: string;
  toPath: string;
}): Promise<MutateMachinePathResult> {
  if (await machinePathExists(handle, toPath)) {
    return { ok: false, reason: 'already_exists' };
  }
  const run = await handle.exec({ cmd: 'mv', args: ['-T', '--', fromPath, toPath] });
  if (run.exitCode !== 0) {
    return mapMutateExecFailure(run.stderr);
  }
  return { ok: true };
}

/** Copy `fromPath` to `toPath` (recursively, preserving attributes), refusing to clobber an existing `toPath`. */
export async function copyMachinePath({
  handle,
  fromPath,
  toPath,
}: {
  handle: MachineHandle;
  fromPath: string;
  toPath: string;
}): Promise<MutateMachinePathResult> {
  if (await machinePathExists(handle, toPath)) {
    return { ok: false, reason: 'already_exists' };
  }
  const run = await handle.exec({ cmd: 'cp', args: ['-a', '--', fromPath, toPath] });
  if (run.exitCode !== 0) {
    return mapMutateExecFailure(run.stderr);
  }
  return { ok: true };
}

/**
 * Delete a path, recursively. `rm -rf` is idempotent by design — deleting an
 * already-missing path is a success, not a `not_found`; confirming with the
 * user before deleting is UI policy, not this lib's.
 */
export async function deleteMachinePath({
  handle,
  path,
}: {
  handle: MachineHandle;
  path: string;
}): Promise<MutateMachinePathResult> {
  const run = await handle.exec({ cmd: 'rm', args: ['-rf', '--', path] });
  if (run.exitCode !== 0) {
    return mapMutateExecFailure(run.stderr);
  }
  return { ok: true };
}
