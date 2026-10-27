/**
 * build-reconciler — recovery for builds and deploys whose worker died.
 *
 * The gap it closes is the same one `stuck-page-reconciler` closes for uploads, and
 * it is worse here: a published app in `building` or `deploying` is a row nothing
 * will ever touch again on its own. pg-boss retries a job that THROWS, but a worker
 * that is SIGKILLed — a deploy, an OOM, a host that went away — never throws, and
 * its job expires quietly while the app sits mid-pipeline forever. The user sees a
 * publish that simply never finishes.
 *
 * WHY THE CLAIM IS THE SAME CLAIM, not a private query: `claimPublishedAppsForWork`
 * already implements FOR UPDATE SKIP LOCKED plus a DURABLE lease write, and both
 * halves matter here. Two processors run this on a schedule, so without the lease
 * they would both "recover" the same app and enqueue two builds for it — a race the
 * row lock alone does not prevent, because it dies at commit and the enqueue
 * happens after.
 *
 * WHY STALENESS IS A QUERY PARAMETER: claiming WRITES the row, which bumps
 * `updatedAt`. Filtering for "building for more than twenty minutes" after the claim
 * would be filtering on a timestamp the claim itself just reset — so the age lives
 * in the claim query (`staleForMs`) and is read before it can be destroyed.
 *
 * The default action is RE-QUEUE, not fail. A stuck row is nearly always a dead
 * worker, and re-running is safe: the push is content-addressed, the machine create
 * is keyed on a name derived from the digest, and the old machine keeps serving
 * until a new one passes a health check. Only two things stop the loop — an app
 * whose build input cannot be resolved (nothing to re-run) and one that has burned
 * its attempts (a build retrying will not fix).
 *
 * WHERE THE RE-RUN'S SOURCE COMES FROM: `resolveSource`, injected, and never a
 * column on `published_apps`. The row records no source pointer by design — the
 * environment is what answers "what is published", and a copy on the hosting row
 * would be a second answer that drifts. Re-resolving also makes the recovery
 * correct rather than merely possible: a re-queued build picks up whatever the env
 * currently offers, instead of rebuilding a stale ref the dead worker happened to
 * have written. The promotion contract this dependency will be bound to (build
 * input = the artifact promoted from the drive's staging/dev env, epic decision D1)
 * is not settled yet; this is the seam it lands behind.
 */

import {
  planStuckAppRecovery,
  resolveBuildReconcilerPolicy,
  type BuildReconcilerPolicy,
} from './build-core';
import type { PublishedApp } from '@pagespace/db/schema/published-apps';
import type { PublishedAppClaim, TransitionResult } from './provisioner';

/** One row as the claim hands it back. */
type ClaimedApp = PublishedApp;

export interface BuildReconcilerDeps {
  isEnabled(): boolean;
  claim(args: {
    statuses: ('building' | 'deploying')[];
    limit: number;
    staleForMs: number;
  }): Promise<PublishedAppClaim>;
  release(publishedAppIds: string[], token: string): Promise<number>;
  transition(
    publishedAppId: string,
    to: 'failed',
    patch: { lastError: string },
  ): Promise<TransitionResult>;
  /**
   * How many times THIS app has already been re-queued by a reconciler. Read from
   * the queue's own history (the `reconcileAttempt` tag on past job payloads), the
   * same trick `stuck-page-reconciler` uses to bound attempts without a schema
   * column.
   */
  countPriorAttempts(publishedAppId: string): Promise<number>;
  /**
   * The build input to re-run this app from — the artifact source seam. Null when
   * nothing is currently promoted for the app's env, which is the one honest
   * reason to stop retrying rather than to keep re-queueing a build that cannot
   * be assembled.
   */
  resolveSource(app: ClaimedApp): Promise<string | null>;
  enqueueBuild(data: {
    publishedAppId: string;
    sourceRef: string;
    reconcileAttempt: number;
  }): Promise<string>;
  log(level: 'info' | 'warn' | 'error', message: string, context: Record<string, unknown>): void;
  policy?: BuildReconcilerPolicy;
}

export interface BuildReconcilerSummary {
  claimed: number;
  requeued: number;
  failed: number;
  enqueueErrors: number;
  transitionErrors: number;
}

const STUCK_STATUSES: ('building' | 'deploying')[] = ['building', 'deploying'];

export async function runAppBuildReconciler(
  deps: BuildReconcilerDeps,
): Promise<BuildReconcilerSummary> {
  const summary: BuildReconcilerSummary = {
    claimed: 0,
    requeued: 0,
    failed: 0,
    enqueueErrors: 0,
    transitionErrors: 0,
  };
  if (!deps.isEnabled()) return summary;

  const policy = deps.policy ?? resolveBuildReconcilerPolicy(process.env);
  const { token, apps } = await deps.claim({
    statuses: STUCK_STATUSES,
    limit: policy.batchLimit,
    staleForMs: policy.staleThresholdMs,
  });
  summary.claimed = apps.length;
  if (apps.length === 0) return summary;

  // Rows this pass finished with, released together at the end. A row whose
  // enqueue FAILED is deliberately absent: leaving it claimed means the next pass
  // waits out the lease instead of retrying immediately against whatever is broken.
  const settled: string[] = [];

  for (const app of apps) {
    // A resolver that THROWS is an unknown, not a "nothing promoted": treat it as
    // a transient failure of this pass and leave the row claimed-then-retried
    // rather than failing an app whose artifact may well be fine.
    let resolvedSource: string | null;
    try {
      resolvedSource = await deps.resolveSource(app);
    } catch (error) {
      summary.enqueueErrors += 1;
      deps.log('warn', 'app-build reconciler: could not resolve a build source', {
        publishedAppId: app.id,
        error: error instanceof Error ? error.message : 'unknown source resolution error',
      });
      continue;
    }

    const recovery = planStuckAppRecovery(
      {
        publishedAppId: app.id,
        status: app.status,
        sourceRef: resolvedSource,
        priorAttempts: await deps.countPriorAttempts(app.id),
      },
      policy,
    );

    if (recovery.action === 'fail') {
      const result = await deps.transition(app.id, 'failed', { lastError: recovery.message });
      if (result.ok) {
        summary.failed += 1;
        settled.push(app.id);
        deps.log('error', 'app-build reconciler: gave up on a stuck app', {
          publishedAppId: app.id,
          flyAppName: app.flyAppName,
          status: app.status,
          reason: recovery.reason,
        });
      } else {
        summary.transitionErrors += 1;
        deps.log('warn', 'app-build reconciler: could not fail a stuck app', {
          publishedAppId: app.id,
          reason: result.reason,
        });
      }
      continue;
    }

    try {
      const jobId = await deps.enqueueBuild({
        publishedAppId: app.id,
        sourceRef: recovery.sourceRef,
        reconcileAttempt: recovery.attempt,
      });
      summary.requeued += 1;
      settled.push(app.id);
      deps.log('warn', 'app-build reconciler: re-queued a stuck build', {
        publishedAppId: app.id,
        status: app.status,
        attempt: recovery.attempt,
        jobId,
      });
    } catch (error) {
      summary.enqueueErrors += 1;
      deps.log('warn', 'app-build reconciler: re-queue failed', {
        publishedAppId: app.id,
        error: error instanceof Error ? error.message : 'unknown enqueue error',
      });
    }
  }

  if (settled.length > 0) await deps.release(settled, token);

  deps.log('info', 'app-build reconciler pass complete', { ...summary });
  return summary;
}
