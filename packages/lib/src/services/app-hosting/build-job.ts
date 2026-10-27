/**
 * build-job — one published app, from workspace source to a running Fly machine.
 *
 * This is the imperative shell of Phase 2. It sequences steps that each live
 * elsewhere (`build-core` decides, `image-builder` builds, `deployer` swaps,
 * `provisioner` persists) and owns the one thing none of them can: WHAT THE ROW
 * SAYS AT EVERY MOMENT, including every moment the process might die.
 *
 * THE STATE CONTRACT, which is the whole of this file's correctness:
 *
 *   building → (build + push) → deploying(+digest,+size) → running(+machineId)
 *
 *  - `deploying` is entered ONLY once a digest is verified in the registry, because
 *    the database's CHECK constraint says a deploying row has an image and we would
 *    rather refuse than pin something a push only claimed to have written.
 *  - A failure after that point RESTORES THE PREVIOUS DIGEST as it fails. The
 *    moment we stamp the new digest, the row is describing an image the serving
 *    machine is not running; if the deploy then fails and the old machine keeps
 *    serving (which it does — see `deployer`), a row left pointing at the new digest
 *    is a lie about live code that nothing later would ever correct.
 *  - THE BUILDER BEING UNAVAILABLE IS NOT A FAILED APP. No Docker on the host is
 *    our problem, not the user's: the row stays `building` with the reason
 *    recorded, and the reconciler re-queues it. Marking it `failed` would both
 *    misattribute the fault and cost the user the automatic retry, since `failed`
 *    only re-enters through an explicit provisioning retry.
 *
 * Every entry point is gated on `isAppHostingEnabled()` and returns a value rather
 * than throwing, matching `provisioner.ts`.
 */

import {
  buildMachineConfig,
  machineNameForDigest,
  planBuildStart,
  type BuildStartRefusal,
} from './build-core';
import { deployBlueGreen, type DeployerFlaps, type DeployResult } from './deployer';
import {
  buildAndPush,
  probeBuilder,
  registryLogin,
  type BuilderRunner,
  type BuiltImage,
} from './image-builder';
import type { PublishedApp } from '@pagespace/db/schema/published-apps';
import type { TransitionResult } from './provisioner';

/**
 * A prepared build context on local disk.
 *
 * `sourceRef` is opaque to this module ON PURPOSE. The promotion contract — build
 * input is the artifact promoted from the drive's staging/dev environment, and
 * what exactly that artifact captures (epic decision D1) — is still open, so the
 * ref is resolved by an injected artifact source and this pipeline only requires
 * that SOMETHING hands it a directory and a Dockerfile. Nothing about the ref is
 * persisted on `published_apps`: the environment already answers "what is
 * published", and a second copy on the hosting row would be an unsynchronised
 * answer to the same question. That also keeps `@pagespace/lib` free of `fs`.
 */
export interface MaterializedSource {
  contextDir: string;
  dockerfile: string;
  /** Always invoked, on success and on failure — build contexts are large. */
  cleanup(): Promise<void>;
}

export interface AppBuildDeps {
  isEnabled(): boolean;
  loadApp(publishedAppId: string): Promise<PublishedApp | null>;
  transition(
    publishedAppId: string,
    to: 'building' | 'deploying' | 'running' | 'failed',
    patch?: {
      machineId?: string | null;
      imageDigest?: string | null;
      imageSizeBytes?: number | null;
      lastError?: string | null;
    },
  ): Promise<TransitionResult>;
  /** Write `lastError` without moving the status. */
  annotate(publishedAppId: string, fields: { lastError?: string | null }): Promise<void>;
  /** An app-scoped Fly deploy token for the registry push. */
  mintBuildToken(publishedAppId: string): Promise<string | null>;
  materializeSource(sourceRef: string): Promise<MaterializedSource>;
  runner: BuilderRunner;
  /** Flaps operations bound to this app. */
  flapsFor(flyAppName: string): DeployerFlaps;
  region?: string;
  log(level: 'info' | 'warn' | 'error', message: string, context: Record<string, unknown>): void;
}

export interface AppBuildJobInput {
  publishedAppId: string;
  sourceRef: string;
}

export type AppBuildOutcome =
  | { ok: true; digest: string; machineId: string; imageSizeBytes: number | null }
  /** Nothing was built and nothing was broken — the app was not in a buildable state. */
  | { ok: false; reason: 'disabled' | 'not_found' | BuildStartRefusal }
  /** Our builder is missing. The row stays `building`; the reconciler will re-queue. */
  | { ok: false; reason: 'builder_unavailable'; error: string }
  /** The build or deploy failed. The row is `failed`; the old machine still serves. */
  | { ok: false; reason: 'build_failed' | 'deploy_failed'; error: string };

export async function runAppBuildJob(
  input: AppBuildJobInput,
  deps: AppBuildDeps,
): Promise<AppBuildOutcome> {
  if (!deps.isEnabled()) return { ok: false, reason: 'disabled' };

  const app = await deps.loadApp(input.publishedAppId);
  if (app === null) return { ok: false, reason: 'not_found' };

  const start = planBuildStart(app.status);
  if (start.action === 'refuse') return { ok: false, reason: start.reason };

  if (start.action === 'promote') {
    // A redeploy of a live app: into `building` before anything is spent, so a
    // worker that dies from here on leaves a row the reconciler finds and re-runs.
    const promoted = await deps.transition(app.id, 'building', { lastError: null });
    if (!promoted.ok) {
      // The row moved underneath us (a park, a teardown, another deploy). Nothing
      // has been touched, so this is a no-op, not a failure.
      deps.log('warn', 'app-build: could not move app to building', {
        publishedAppId: app.id,
        from: app.status,
        reason: promoted.reason,
      });
      return { ok: false, reason: 'deploy_in_flight' };
    }
  }

  // THE BUILDER PROBE COMES BEFORE ANY STATE MOVES OR ANY CREDENTIAL IS MINTED.
  // A missing Docker is the one failure that is ours rather than the user's, and it
  // is cheap to detect — so detect it while nothing has been spent.
  const builder = await probeBuilder(deps.runner);
  if (!builder.available) {
    const message = `Build blocked: no usable Docker BuildKit builder (${builder.detail})`;
    await deps.annotate(app.id, { lastError: message });
    deps.log('error', 'app-build: builder unavailable, leaving app queued', {
      publishedAppId: app.id,
      detail: builder.detail,
    });
    return { ok: false, reason: 'builder_unavailable', error: message };
  }

  const previousDigest = app.imageDigest;
  const previousSize = app.imageSizeBytes;

  let built: BuiltImage;
  let source: MaterializedSource | null = null;
  try {
    const token = await deps.mintBuildToken(app.id);
    if (token === null) {
      return await failBuild(deps, app, previousDigest, previousSize, 'build_failed',
        'Could not mint a Fly deploy token for the registry push');
    }
    await registryLogin(deps.runner, token);

    source = await deps.materializeSource(input.sourceRef);
    built = await buildAndPush(deps.runner, {
      flyAppName: app.flyAppName,
      contextDir: source.contextDir,
      dockerfile: source.dockerfile,
      sourceRef: input.sourceRef,
    });
  } catch (error) {
    return await failBuild(
      deps,
      app,
      previousDigest,
      previousSize,
      'build_failed',
      error instanceof Error ? error.message : 'unknown build error',
    );
  } finally {
    if (source !== null) {
      await source.cleanup().catch((error: unknown) => {
        deps.log('warn', 'app-build: build context cleanup failed', {
          publishedAppId: app.id,
          error: error instanceof Error ? error.message : 'unknown cleanup error',
        });
      });
    }
  }

  // The digest is verified in the registry by here, so the row may legally say
  // `deploying` — and the size travels in the same statement as the digest it
  // measures.
  const deploying = await deps.transition(app.id, 'deploying', {
    imageDigest: built.digest,
    imageSizeBytes: built.sizeBytes,
    lastError: null,
  });
  if (!deploying.ok) {
    deps.log('warn', 'app-build: app left building state before deploy', {
      publishedAppId: app.id,
      reason: deploying.reason,
    });
    return { ok: false, reason: 'deploy_in_flight' };
  }

  const config = buildMachineConfig({
    flyAppName: app.flyAppName,
    digest: built.digest,
    guestPreset: app.guestPreset,
    publishedAppId: app.id,
    // Read from the row, never assumed: the tier decides `min_machines_running`,
    // and a deploy that guessed it would quietly re-create a paid always-on app as
    // scale-to-zero on its very next build.
    tier: app.tier,
  });
  if (config === null) {
    return await failBuild(deps, app, previousDigest, previousSize, 'deploy_failed',
      `Unknown guest preset '${app.guestPreset}'`);
  }

  const result: DeployResult = await deployBlueGreen({
    flaps: deps.flapsFor(app.flyAppName),
    machineName: machineNameForDigest(built.digest),
    config,
    region: deps.region,
    oldMachineId: app.machineId,
    promote: async (newMachineId) => {
      const running = await deps.transition(app.id, 'running', {
        machineId: newMachineId,
        imageDigest: built.digest,
        imageSizeBytes: built.sizeBytes,
        lastError: null,
      });
      return running.ok;
    },
  });

  if (!result.ok) {
    if (!result.rolledBack) {
      // A machine we created and could not destroy: billable, serving nothing.
      deps.log('error', 'app-build: rollback left an orphan machine on Fly', {
        publishedAppId: app.id,
        flyAppName: app.flyAppName,
        stage: result.stage,
        rollbackError: result.rollbackError,
      });
    }
    return await failBuild(
      deps,
      app,
      previousDigest,
      previousSize,
      'deploy_failed',
      `Deploy failed at ${result.stage}: ${result.error}`,
    );
  }

  if (!result.oldMachineDestroyed) {
    deps.log('error', 'app-build: old machine survived the swap and is still billing', {
      publishedAppId: app.id,
      flyAppName: app.flyAppName,
      oldMachineId: app.machineId,
      error: result.oldMachineError,
    });
  }

  deps.log('info', 'app-build: published app deployed', {
    publishedAppId: app.id,
    digest: built.digest,
    machineId: result.machineId,
    imageSizeBytes: built.sizeBytes,
  });
  return {
    ok: true,
    digest: built.digest,
    machineId: result.machineId,
    imageSizeBytes: built.sizeBytes,
  };
}

/**
 * Mark the app failed, putting the PREVIOUSLY SERVED digest back.
 *
 * The restore is the load-bearing half. The old machine is still serving (nothing
 * in this pipeline destroys it before a new machine passes its health check), so
 * the row must go on describing what that machine runs. Leaving the new digest on a
 * failed row would claim the app serves code it has never booted — and since the
 * next successful build overwrites the field anyway, nothing would ever notice.
 */
async function failBuild(
  deps: AppBuildDeps,
  app: PublishedApp,
  previousDigest: string | null,
  previousSize: number | null,
  reason: 'build_failed' | 'deploy_failed',
  error: string,
): Promise<AppBuildOutcome> {
  const failed = await deps.transition(app.id, 'failed', {
    imageDigest: previousDigest,
    imageSizeBytes: previousSize,
    lastError: error,
  });
  if (!failed.ok) {
    deps.log('error', 'app-build: could not record the failure on the app row', {
      publishedAppId: app.id,
      reason: failed.reason,
      error,
    });
  }
  deps.log('error', 'app-build: build/deploy failed; previous machine keeps serving', {
    publishedAppId: app.id,
    flyAppName: app.flyAppName,
    reason,
    error,
  });
  return { ok: false, reason, error };
}
