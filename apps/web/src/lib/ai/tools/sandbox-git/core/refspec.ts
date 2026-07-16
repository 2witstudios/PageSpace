/**
 * Pure refspec parsing + the git_push safety guard.
 *
 * This is the injection-adjacent security core of the sandbox git toolkit:
 * it decides whether a push is a destructive operation against a protected
 * default branch. No effects, no imports — every branch is exhaustively tested
 * in `__tests__/refspec.test.ts`.
 */

// Default branch names we refuse to force-push to. Heuristic: only these common
// names are auto-protected (a custom default branch is not).
export const DEFAULT_BRANCHES: ReadonlySet<string> = new Set(['main', 'master']);

/**
 * The ref a push actually writes on the remote. A push target is a refspec
 * `[+]<src>:<dst>` (or `[+]<branch>`), so the destination is the segment after
 * the last ':' — a bare-name check misses `HEAD:main` or `feature:refs/heads/master`.
 * Returns the lowercased short branch name for comparison against DEFAULT_BRANCHES.
 */
export function pushDestinationBranch(refspec: string): string {
  const spec = refspec.startsWith('+') ? refspec.slice(1) : refspec;
  const dst = spec.includes(':') ? spec.slice(spec.lastIndexOf(':') + 1) : spec;
  return dst.replace(/^refs\/heads\//, '').trim().toLowerCase();
}

/**
 * A delete refspec has an empty source: `:dst` (or `+:dst`). `git push origin
 * :main` deletes the remote default branch — as destructive as a force-push, so
 * the same guard must catch it.
 */
export function isDeleteRefspec(refspec: string): boolean {
  const spec = refspec.startsWith('+') ? refspec.slice(1) : refspec;
  return spec.includes(':') && spec.slice(0, spec.lastIndexOf(':')).trim() === '';
}

export interface PushGuardInput {
  force?: boolean;
  branch?: string;
}

export type PushGuardResult = { ok: true } | { ok: false; error: string };

/**
 * Decide whether a push is allowed. Force-push is fine for a feature/PR branch,
 * but never the default branch. A push forces when the `force` flag is set OR
 * the refspec is `+`-prefixed (per-refspec force), so both are guarded. Under
 * force an explicit branch is required so the target can be verified — the
 * sandbox's current branch is not visible here. Destructive = force (rewrites
 * history) or delete (`:branch`); either against a default branch is refused,
 * a normal fast-forward push is not.
 */
export function evaluatePushGuard({ force, branch }: PushGuardInput): PushGuardResult {
  const forcing = force === true || (branch?.startsWith('+') ?? false);
  if (forcing && !branch) {
    return {
      ok: false,
      error:
        'Force-push requires an explicit branch so the target can be verified. Name the feature/PR branch to push to.',
    };
  }
  const destructive = forcing || (branch ? isDeleteRefspec(branch) : false);
  if (destructive && branch && DEFAULT_BRANCHES.has(pushDestinationBranch(branch))) {
    return {
      ok: false,
      error:
        'Refusing to force-push or delete the default branch (main/master). These are allowed on feature/PR branches only.',
    };
  }
  return { ok: true };
}
