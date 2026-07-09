/**
 * Machine filesystem browsing primitives (pure, DI'd).
 *
 * Two functions the human-facing Machine page uses to browse a Machine's
 * WORKING TREE — the live files on a Sprite's persistent filesystem, e.g. a
 * branch-terminal's checkout at `/workspace/repo`:
 *
 *   listMachineDirectory — one directory's immediate children ({ name, type }).
 *   readMachineFile      — one file's bytes.
 *
 * Both take a `MachineHandle` (./machine-host.ts) as an INJECTED dependency
 * rather than constructing a Sprite host themselves, mirroring the DI shape of
 * `runGitInSandbox` (./git-tool-runners.ts). That keeps them unit-testable
 * against a fake handle with zero real Sprite calls, per the repo's
 * pure-functions-plus-DI build mandate.
 *
 * SCOPE BOUNDARY: this reads the working tree ONLY — it is filesystem-level and
 * takes no git ref. A diff tab's "before" content needs git-object reads, a
 * separate git-ref-aware service that depends on this one; do NOT add a ref
 * parameter here.
 *
 * This runs commands through `MachineHandle.exec`/`readFile`, deliberately NOT
 * through the AI-agent tool-runner orchestration (billing holds, injection
 * screening, LLM-facing denial vocabulary) — that layer is shaped for an agent,
 * not a browsing UI.
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
