/**
 * build-source-retention-core — the pure decision half of the build-source
 * disk sweep (item 6 of the publish-surface hardening round).
 *
 * Every publish extracts a fresh source tree under `APP_BUILD_SOURCE_ROOT`
 * (`apps/processor/src/api/app-build.ts`), and nothing ever deleted the old
 * ones — an app published a hundred times leaves a hundred full source trees
 * on disk forever. The sweep keeps the newest N per app and deletes the rest,
 * with ONE hard exception: the build reconciler's `resolveLastBuildSource`
 * (`apps/processor/src/workers/app-build-worker.ts`) can name a source ref
 * that is not among the newest N (a stuck app recovered long after later
 * publishes moved on) — that ref must never be deleted, because it is the
 * only thing a stuck-app recovery can rebuild from.
 */

export interface PlanRetentionInput {
  /** This app's source refs, newest first (caller sorts — this function makes no assumption about the string format beyond order). */
  sourceRefsNewestFirst: string[];
  /** How many of the newest to keep unconditionally. */
  keepNewest: number;
  /** The reconciler's last-known-good ref for this app, if any — never deleted even if older than the keep-newest cutoff. */
  mustKeep: string | null;
}

export interface PlanRetentionResult {
  keep: string[];
  remove: string[];
}

export function planBuildSourceRetention(input: PlanRetentionInput): PlanRetentionResult {
  const keepSet = new Set(input.sourceRefsNewestFirst.slice(0, Math.max(0, input.keepNewest)));
  if (input.mustKeep !== null && input.sourceRefsNewestFirst.includes(input.mustKeep)) {
    keepSet.add(input.mustKeep);
  }

  const keep: string[] = [];
  const remove: string[] = [];
  for (const ref of input.sourceRefsNewestFirst) {
    (keepSet.has(ref) ? keep : remove).push(ref);
  }
  return { keep, remove };
}
