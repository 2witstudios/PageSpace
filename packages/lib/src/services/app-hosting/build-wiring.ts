/**
 * build-wiring — the real dependencies for the build job and its reconciler.
 *
 * `build-job.ts` and `build-reconciler.ts` take everything as injected deps so they
 * can be tested without a database, a registry, or Docker. This is where those deps
 * are bound to the actual provisioner and the actual Machines API — one place, so
 * there is exactly one answer to "what does production wire in".
 *
 * TWO SEAMS ARE LEFT TO THE CALLER, and both for the same reason: they need Node
 * APIs (`child_process`, `fs`) that must not be imported anywhere in
 * `@pagespace/lib`, which is bundled into a Next.js app. The processor supplies
 * them.
 */

import { isAppHostingEnabled, resolveFlyMachinesToken } from './app-hosting-env';
import type { AppBuildDeps, MaterializedSource } from './build-job';
import type { BuildReconcilerDeps } from './build-reconciler';
import type { DeployerFlaps } from './deployer';
import type { BuilderRunner } from './image-builder';
import {
  createMachine,
  deleteMachine,
  execMachine,
  waitForMachineState,
  type FlapsTransport,
} from '../fly/flaps-client';
import {
  annotatePublishedApp,
  claimPublishedAppsForWork,
  getPublishedApp,
  mintDeployToken,
  releasePublishedAppClaim,
  transitionPublishedApp,
} from './provisioner';

/**
 * How long a build's registry credential lives.
 *
 * SHORT ON PURPOSE. A Fly deploy token can mint its own successor for its app
 * indefinitely, and Fly returns no token id — so the only revocation is destroying
 * the app. A leaked one is therefore permanent, and the only real mitigation is
 * that it expires before anyone finds it. One hour comfortably covers a build whose
 * own timeout is fifteen minutes.
 */
export const BUILD_TOKEN_EXPIRY = '1h';

function transport(): FlapsTransport {
  return { token: resolveFlyMachinesToken() };
}

function flapsFor(flyAppName: string): DeployerFlaps {
  return {
    createMachine: (input) =>
      createMachine(transport(), {
        appName: flyAppName,
        name: input.name,
        region: input.region,
        config: input.config,
      }),
    waitForState: (machineId, state, timeoutSeconds) =>
      waitForMachineState(transport(), flyAppName, machineId, state, timeoutSeconds),
    exec: (machineId, command, timeoutSeconds) =>
      execMachine(transport(), flyAppName, machineId, command, timeoutSeconds),
    deleteMachine: (machineId) => deleteMachine(transport(), flyAppName, machineId),
  };
}

export type BuildLogger = (
  level: 'info' | 'warn' | 'error',
  message: string,
  context: Record<string, unknown>,
) => void;

export function createAppBuildDeps({
  runner,
  materializeSource,
  log,
  region,
}: {
  runner: BuilderRunner;
  materializeSource(sourceRef: string): Promise<MaterializedSource>;
  log: BuildLogger;
  region?: string;
}): AppBuildDeps {
  return {
    isEnabled: isAppHostingEnabled,
    loadApp: (publishedAppId) => getPublishedApp(publishedAppId),
    transition: (publishedAppId, to, patch) =>
      transitionPublishedApp(publishedAppId, to, { patch }),
    annotate: (publishedAppId, fields) => annotatePublishedApp(publishedAppId, fields),
    mintBuildToken: async (publishedAppId) => {
      const result = await mintDeployToken({
        publishedAppId,
        expiry: BUILD_TOKEN_EXPIRY,
        purpose: 'build',
      });
      return result.ok ? result.token : null;
    },
    materializeSource,
    runner,
    flapsFor,
    region,
    log,
  };
}

/**
 * The artifact source the reconciler re-runs a stuck build from.
 *
 * INJECTED, and with no default binding here on purpose. The promotion contract —
 * build input is the artifact promoted from the drive's staging/dev environment,
 * and what exactly that artifact captures — is epic decision D1 and is not settled;
 * `published_apps` therefore records no source pointer, and there is nothing this
 * module could honestly resolve one from yet. Leaving the parameter required means
 * every caller states its answer rather than silently inheriting a placeholder.
 */
export function createBuildReconcilerDeps({
  enqueueBuild,
  countPriorAttempts,
  resolveSource,
  log,
}: {
  enqueueBuild: BuildReconcilerDeps['enqueueBuild'];
  countPriorAttempts: BuildReconcilerDeps['countPriorAttempts'];
  resolveSource: BuildReconcilerDeps['resolveSource'];
  log: BuildLogger;
}): BuildReconcilerDeps {
  return {
    isEnabled: isAppHostingEnabled,
    claim: ({ statuses, limit, staleForMs }) =>
      claimPublishedAppsForWork({ statuses, limit, staleForMs }),
    release: (publishedAppIds, token) => releasePublishedAppClaim(publishedAppIds, token),
    transition: (publishedAppId, to, patch) =>
      transitionPublishedApp(publishedAppId, to, { patch }),
    countPriorAttempts,
    resolveSource,
    enqueueBuild,
    log,
  };
}
