/**
 * The process's ONE Sprites host — the provider-neutral `SandboxHost` every
 * sandbox-touching runtime in this app provisions, attaches and kills through.
 *
 * Its own module rather than a member of `agent-workspaces-runtime.ts`, where it
 * used to live, purely to keep the import graph acyclic. Both runtimes that own
 * a Sprite HOLDER need it — sessions and drive environments — and the session
 * runtime now also needs the env runtime (an env-bound session's ensure routes
 * at its env). With the host still declared beside the sessions, that pair of
 * needs is a cycle; with it here, both runtimes depend on this module and on
 * nothing of each other's that they do not use.
 *
 * `agent-workspaces-runtime.ts` re-exports `getSandboxHost` so its existing
 * importers do not churn.
 */

import type { SandboxHost } from '@pagespace/lib/services/sandbox/sandbox-host';

// The Fly Sprites driver is loaded via a DYNAMIC import, never a static one —
// @fly/sprites is ESM-only and @pagespace/lib compiles to CJS (see
// sandbox-tools-runtime.ts for the full rationale). Fail CLOSED with an
// actionable message on a pre-Node-24 runtime, and never memoize a rejection.
const MIN_SANDBOX_NODE_MAJOR = 24;

function assertSandboxRuntime(): void {
  const major = Number.parseInt(process.versions.node.split('.')[0] ?? '0', 10);
  if (Number.isNaN(major) || major < MIN_SANDBOX_NODE_MAJOR) {
    throw new Error(
      `Agent sessions require Node.js >= ${MIN_SANDBOX_NODE_MAJOR} ` +
        `(the @fly/sprites SDK is Node ${MIN_SANDBOX_NODE_MAJOR}+ / ESM-only); ` +
        `this process is Node ${process.versions.node}.`,
    );
  }
}

let machineHostPromise: Promise<SandboxHost> | null = null;

export function getSandboxHost(): Promise<SandboxHost> {
  machineHostPromise ??= (async () => {
    assertSandboxRuntime();
    const { createProductionSandboxHost } = await import('@/lib/sandbox/sprites-client');
    return createProductionSandboxHost();
  })().catch((error) => {
    machineHostPromise = null;
    throw error;
  });
  return machineHostPromise;
}
