/**
 * build-source-retention — the I/O half of the build-source disk sweep. Pure
 * decision logic lives in `@pagespace/lib/services/app-hosting/build-source-retention-core`
 * (`planBuildSourceRetention`); this file only enumerates the filesystem,
 * asks the reconciler's own `resolveLastBuildSource` what it must not
 * delete, and removes what the plan says to remove.
 *
 * Layout assumed (matches `apps/processor/src/api/app-build.ts`'s
 * extraction and `sourceRef` shape, `<publishedAppId>/<timestamp>`):
 * `APP_BUILD_SOURCE_ROOT/<publishedAppId>/<timestamp>/`.
 */

import { readdir, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { loggers } from '@pagespace/lib/logging/logger-config';
import { planBuildSourceRetention } from '@pagespace/lib/services/app-hosting/build-source-retention-core';
import { resolveBuildSourceRoot } from './app-build-runner';
import { resolveLastBuildSource } from './app-build-worker';

/** How many of the newest source trees to keep per app, independent of what the reconciler still needs. */
export const BUILD_SOURCE_KEEP_NEWEST = 3;

async function listSubdirsNewestFirst(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const dirs = entries.filter((e) => e.isDirectory()).map((e) => e.name);
  const withMtime = await Promise.all(
    dirs.map(async (name) => ({ name, mtimeMs: (await stat(path.join(dir, name))).mtimeMs })),
  );
  withMtime.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return withMtime.map((e) => e.name);
}

export interface BuildSourceRetentionSummary {
  appsSwept: number;
  removed: number;
  failed: number;
}

export async function sweepAppBuildSourceRetention(): Promise<BuildSourceRetentionSummary> {
  const root = resolveBuildSourceRoot();
  const summary: BuildSourceRetentionSummary = { appsSwept: 0, removed: 0, failed: 0 };
  if (root.length === 0) return summary;

  const resolvedRoot = path.resolve(root);
  let appDirs: string[];
  try {
    const entries = await readdir(resolvedRoot, { withFileTypes: true });
    appDirs = entries.filter((e) => e.isDirectory()).map((e) => e.name);
  } catch (error) {
    loggers.processor.warn('[app-build-source-retention] could not list build source root', {
      root: resolvedRoot,
      error: error instanceof Error ? error.message : String(error),
    });
    return summary;
  }

  for (const publishedAppId of appDirs) {
    summary.appsSwept += 1;
    try {
      const timestamps = await listSubdirsNewestFirst(path.join(resolvedRoot, publishedAppId));
      const sourceRefsNewestFirst = timestamps.map((ts) => `${publishedAppId}/${ts}`);

      // A resolver failure must never turn into a delete — it means "I don't
      // know what the reconciler needs," not "the reconciler needs nothing."
      let mustKeep: string | null;
      try {
        mustKeep = await resolveLastBuildSource(publishedAppId);
      } catch (error) {
        loggers.processor.warn('[app-build-source-retention] could not resolve last build source; skipping app', {
          publishedAppId,
          error: error instanceof Error ? error.message : String(error),
        });
        continue;
      }

      const plan = planBuildSourceRetention({ sourceRefsNewestFirst, keepNewest: BUILD_SOURCE_KEEP_NEWEST, mustKeep });

      for (const ref of plan.remove) {
        const dirPath = path.resolve(resolvedRoot, ref);
        // The ref is our own construction (`<appDir>/<subdir>` from a listing
        // of the root itself), but resolving-and-checking before an `rm
        // -rf`-equivalent costs nothing and rules out a path ever escaping
        // `resolvedRoot` through a symlink or an unexpected directory name.
        if (!dirPath.startsWith(resolvedRoot + path.sep)) continue;
        try {
          await rm(dirPath, { recursive: true, force: true });
          summary.removed += 1;
        } catch (error) {
          summary.failed += 1;
          loggers.processor.warn('[app-build-source-retention] failed to remove old build source', {
            dirPath,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
    } catch (error) {
      summary.failed += 1;
      loggers.processor.warn('[app-build-source-retention] failed to sweep app', {
        publishedAppId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return summary;
}
