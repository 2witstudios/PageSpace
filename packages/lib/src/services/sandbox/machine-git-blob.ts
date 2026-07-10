/**
 * Machine git-object read primitive (pure, DI'd).
 *
 * `readMachineGitBlob` reads ONE file's content as it existed at a given git
 * ref — via `git show <ref>:<path>` run through the hardened `runGitInSandbox`
 * path (./git-tool-runners.ts) — NOT `MachineHandle.readFile`, which only ever
 * reads the CURRENT working tree (see machine-fs.ts's scope-boundary note).
 * This is the git-object-store counterpart to machine-fs.ts's working-tree
 * `readMachineFile`: a DIFFERENT backend (git's object store vs. the live
 * filesystem), so it is kept a separate primitive rather than folded into a
 * single "read a file" function.
 *
 * SCOPE BOUNDARY: the Diff tab's 'Uncommitted' scope is the one exception —
 * its modified side IS the working tree, so that caller reuses machine-fs.ts's
 * `readMachineFile` directly rather than routing an implicit `git show
 * HEAD:path` through here.
 *
 * Takes `GitSandboxRunDeps` + `SandboxActorContext` as injected params — the
 * same DI shape `runGitInSandbox` itself takes, mirroring how
 * `machine-branches.ts` drives clone/checkout — so this is unit-testable
 * against a fake deps object with zero real Sprite/git calls.
 */

import { runGitInSandbox, type GitSandboxRunDeps } from './git-tool-runners';
import type { SandboxActorContext } from './tool-runners';

export type ReadMachineGitBlobResult =
  | { ok: true; content: string; truncated: boolean }
  | { ok: false; reason: 'not_found' | 'invalid_ref' | 'exec_failed'; detail?: string };

/** Git's own "missing object/path" messages, across the ref-missing and path-missing cases. */
const NOT_FOUND_PATTERN =
  /does not exist in|exists on disk, but not in|invalid object name|unknown revision|bad revision/i;

/**
 * Read `path` as it existed at `ref`, inside the repo checked out at `cwd`.
 *
 * `ref` and `path` are combined into ONE `<ref>:<path>` argument — git's own
 * blob-addressing syntax — rather than passed as separate argv elements. Git
 * resolves that argument against `ref`'s own tree, so a `path` (even one
 * containing `../` or a leading `/`) can never escape onto the host
 * filesystem the way a raw fs path could; it just fails to resolve inside the
 * tree, surfaced below as `not_found`.
 *
 * A leading `-` on `ref` is rejected outright rather than passed through: git
 * parses a `-`-leading token as an OPTION, not an object name, and this is not
 * a cosmetic parse failure — `git show "--output=/tmp/x:path"` genuinely
 * writes `/tmp/x:path` to disk (verified against a real repo) instead of
 * erroring, making an unsanitized leading-dash `ref` an arbitrary-file-write
 * primitive. Every valid git ref/branch/tag/SHA is already barred from a
 * leading `-` by git's own `check-ref-format` rules, so this excludes no
 * legitimate ref.
 */
export async function readMachineGitBlob({
  ref,
  path,
  cwd,
  ctx,
  deps,
}: {
  ref: string;
  path: string;
  cwd: string;
  ctx: SandboxActorContext;
  deps: GitSandboxRunDeps;
}): Promise<ReadMachineGitBlobResult> {
  if (ref.length === 0 || ref.startsWith('-')) {
    return { ok: false, reason: 'invalid_ref' };
  }

  const run = await runGitInSandbox({
    cmd: 'git',
    args: ['show', `${ref}:${path}`],
    cwd,
    ctx,
    deps,
  });
  if (!run.success) return { ok: false, reason: 'exec_failed', detail: run.error };
  if (run.exitCode !== 0) {
    const reason = NOT_FOUND_PATTERN.test(run.stderr) ? 'not_found' : 'exec_failed';
    return { ok: false, reason, detail: run.stderr.trim() || undefined };
  }
  return { ok: true, content: run.stdout, truncated: run.truncated };
}
