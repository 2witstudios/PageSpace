/**
 * app-build-worker — the processor's binding of the published-app build pipeline.
 *
 * All the decisions live in `@pagespace/lib/services/app-hosting/*`; this file
 * supplies the three things only the processor has: a Docker runner, a filesystem
 * to resolve a source ref against, and pg-boss (to enqueue a recovery build, to
 * count how many recoveries an app has already had, and to recover WHAT that app
 * was building).
 *
 * ATTEMPT COUNTING NEEDS NO SCHEMA COLUMN, the same trick `stuck-page-reconciler`
 * uses: every reconciler-driven enqueue tags its job payload with
 * `reconcileAttempt`, and the next pass reads the max tag back out of
 * `pgboss.job` UNION `pgboss.archive`. Archive retention (7 days) comfortably
 * outlasts a build's twenty-minute staleness horizon.
 */

import { loggers } from '@pagespace/lib/logging/logger-config';
import {
  runAppBuildJob,
  type AppBuildOutcome,
} from '@pagespace/lib/services/app-hosting/build-job';
import { runAppBuildReconciler } from '@pagespace/lib/services/app-hosting/build-reconciler';
import {
  createAppBuildDeps,
  createBuildReconcilerDeps,
} from '@pagespace/lib/services/app-hosting/build-wiring';
import { getPoolForWorker } from '../db';
import { createBuilderRunner, materializeBuildSource } from './app-build-runner';
import type { AppBuildJobData } from '../types';

const log = (
  level: 'info' | 'warn' | 'error',
  message: string,
  context: Record<string, unknown>,
): void => {
  loggers.processor[level](message, context);
};

export async function runAppBuild(data: AppBuildJobData): Promise<AppBuildOutcome> {
  return runAppBuildJob(
    { publishedAppId: data.publishedAppId, sourceRef: data.sourceRef },
    createAppBuildDeps({
      runner: createBuilderRunner(),
      materializeSource: materializeBuildSource,
      log,
      region: process.env.APP_HOSTING_REGION || undefined,
    }),
  );
}

/**
 * How many times a reconciler has already re-queued this app's build.
 *
 * Both `pgboss.job` and `pgboss.archive` are read: a completed recovery build moves
 * to the archive within the retention window, and counting only the live table
 * would forget every attempt that finished — turning a bounded three-attempt budget
 * into an unbounded loop.
 */
async function countPriorAttempts(publishedAppId: string): Promise<number> {
  const client = await getPoolForWorker().connect();
  try {
    const result = await client.query(
      `SELECT COALESCE(MAX((data->>'reconcileAttempt')::int), 0) AS attempts
         FROM (SELECT name, data FROM pgboss.job
               UNION ALL
               SELECT name, data FROM pgboss.archive) jobs
        WHERE name = 'app-build'
          AND data->>'reconcileAttempt' IS NOT NULL
          AND data->>'publishedAppId' = $1`,
      [publishedAppId],
    );
    return Number(result.rows[0]?.attempts ?? 0);
  } finally {
    client.release();
  }
}

/**
 * What to re-run a stuck build from — the artifact-source seam, bound to the queue.
 *
 * `published_apps` records no source pointer on purpose: the environment is what
 * answers "what is published", and a column here would be a second answer that
 * drifts from it. The promotion contract that will answer this properly (build
 * input = the artifact promoted from the drive's staging/dev env) is epic decision
 * D1 and is not settled, so today the binding reads the LAST `app-build` payload
 * for this app back out of pg-boss — the same `job` UNION `archive` read attempt
 * counting already does, and the one place that genuinely records what a build was
 * asked to build.
 *
 * Newest-first, and null when there is none: an app with no job in the retention
 * window has nothing this process can honestly rebuild, and the reconciler is right
 * to stop retrying it rather than to keep re-queueing a build it cannot assemble.
 * When the promotion contract lands, only this function changes.
 */
async function resolveLastBuildSource(publishedAppId: string): Promise<string | null> {
  const client = await getPoolForWorker().connect();
  try {
    const result = await client.query(
      `SELECT data->>'sourceRef' AS source_ref
         FROM (SELECT name, data, created_on FROM pgboss.job
               UNION ALL
               SELECT name, data, created_on FROM pgboss.archive) jobs
        WHERE name = 'app-build'
          AND data->>'publishedAppId' = $1
          AND data->>'sourceRef' IS NOT NULL
        ORDER BY created_on DESC
        LIMIT 1`,
      [publishedAppId],
    );
    const sourceRef = result.rows[0]?.source_ref;
    return typeof sourceRef === 'string' && sourceRef.length > 0 ? sourceRef : null;
  } finally {
    client.release();
  }
}

export async function runAppBuildReconcilerPass(
  enqueueBuild: (data: AppBuildJobData) => Promise<string>,
): Promise<void> {
  await runAppBuildReconciler(
    createBuildReconcilerDeps({
      enqueueBuild: (data) =>
        enqueueBuild({
          publishedAppId: data.publishedAppId,
          sourceRef: data.sourceRef,
          reconcileAttempt: data.reconcileAttempt,
        }),
      countPriorAttempts,
      resolveSource: (app) => resolveLastBuildSource(app.id),
      log,
    }),
  );
}
