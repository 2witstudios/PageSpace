/**
 * Dev-preview EFFECTS — the seam `dev-preview-core.ts` defined, carried out.
 *
 * The decision core (`planDevServerService`) says WHAT to do to the relay and
 * WHAT row to record; this module DOES it, through the merged service surface
 * (`SandboxHandle.services`) and the holder-keyed store, and adds NO decision
 * of its own. Every branch below is a `switch` on a plan the core produced —
 * if a case needs a judgement call, the judgement belongs in the core, where
 * it is pure and mutation-tested, not here.
 *
 * MIGRATION SEAM — delete cleanly if the platform ships real httpPort routing
 * ---------------------------------------------------------------------------
 * This is the effect site the relay contract's docblock (`preview-relay.ts`)
 * points at. If Sprites ever makes a service's `httpPort` the URL's routing
 * target (re-verify spike §3/§8 first — the docs already claim it and it is
 * not so), the relay service stops being needed: `applyDevServerServicePlan`
 * would create the user's dev server itself as the service (the core would
 * plan that instead of a relay), `probeRelayRuntime` and every `'start-relay'`
 * / `'replace-relay'` arm would go, and `record-direct` would become the only
 * write. Nothing outside `preview/` names the relay, so the deletion is local.
 *
 * RUNTIME CHOICE: `socat` is PREFERRED WHEN PRESENT, `node` is the verified
 * default. The relay contract verified `node` (present under `/.sprite/bin`,
 * spike §1) and only ASSUMED `socat`; this module never assumes — it probes
 * (`command -v socat`) inside the sprite and picks `socat` only on a clean
 * exit. The probe is an exec, and an exec wakes a paused sprite; it therefore
 * runs ONLY on the effect path (a port was just detected, so the sprite is
 * awake by definition) and never to render or reconcile. Callers cache the
 * answer per instance.
 */

import type { RunCommandArgs, SandboxRunResult } from '../sandbox-client/types';
import type { SandboxServicesApi } from '../sandbox-host';
import type { DevPreviewHolderRef, DevPreviewRowIntent, DevServerServicePlan } from './dev-preview-core';
import { PREVIEW_RELAY_SERVICE_NAME, type PreviewRelayRuntime } from './preview-relay';

/** The holder-keyed write the effects layer needs — the store's upsert (see `dev-preview-store.ts`). */
export interface DevPreviewRowWriter {
  upsert(intent: DevPreviewRowIntent): Promise<void>;
}

/** Bounded so a hung probe cannot hold the detection loop. */
const RUNTIME_PROBE_TIMEOUT_MS = 10_000;

/**
 * Which relay runtime to plan with, decided by PROBING the sprite: `socat`
 * only when `command -v socat` exits 0, `node` otherwise (including on a
 * probe failure — the verified default is the safe answer to "not sure").
 */
export async function probeRelayRuntime(exec: (args: RunCommandArgs) => Promise<SandboxRunResult>): Promise<PreviewRelayRuntime> {
  try {
    const result = await exec({ cmd: 'sh', args: ['-c', 'command -v socat'], timeoutMs: RUNTIME_PROBE_TIMEOUT_MS });
    return result.exitCode === 0 ? 'socat' : 'node';
  } catch {
    return 'node';
  }
}

export type AppliedDevServerServicePlan =
  | { action: 'start-relay'; via: 'create' | 'start' | 'already-running'; targetPort: number }
  | { action: 'replace-relay'; previousTargetPort: number; targetPort: number }
  | { action: 'record-direct'; removedRelay: boolean }
  | { action: 'stop-relay'; relayServiceName: string }
  | { action: 'none'; reason: string; staleRowIgnored: boolean }
  | { action: 'refuse'; reason: string; targetPort?: number };

/**
 * Carry out one plan: service calls first (so a row is never written for a
 * relay that failed to start — a thrown service call aborts before the
 * upsert), then the holder-keyed upsert exactly as the core's row intent
 * specifies (every field, `stoppedByUserAt: null` included — see
 * `DevPreviewRowIntent`).
 */
export async function applyDevServerServicePlan({
  plan,
  services,
  store,
}: {
  plan: DevServerServicePlan;
  services: SandboxServicesApi;
  store: DevPreviewRowWriter;
}): Promise<AppliedDevServerServicePlan> {
  switch (plan.action) {
    case 'start-relay': {
      if (plan.via === 'create') {
        await services.create({ name: plan.service.name, command: plan.service.command, args: plan.service.args });
      } else if (plan.via === 'start') {
        await services.start(plan.service.name);
      }
      await store.upsert(plan.row);
      return { action: 'start-relay', via: plan.via, targetPort: plan.service.targetPort };
    }
    case 'replace-relay': {
      // Remove-then-create, never an in-place PUT with a different command:
      // what the platform does with a DIFFERENT command under the same name is
      // unverified (`relayServiceMatches`'s doc), and the core plans around it.
      await services.remove(plan.service.name);
      await services.create({ name: plan.service.name, command: plan.service.command, args: plan.service.args });
      await store.upsert(plan.row);
      return { action: 'replace-relay', previousTargetPort: plan.previousTargetPort, targetPort: plan.service.targetPort };
    }
    case 'record-direct': {
      if (plan.removeRelay) await services.remove(PREVIEW_RELAY_SERVICE_NAME);
      await store.upsert(plan.row);
      return { action: 'record-direct', removedRelay: plan.removeRelay };
    }
    case 'stop-relay': {
      await services.stop(plan.relayServiceName);
      return { action: 'stop-relay', relayServiceName: plan.relayServiceName };
    }
    case 'none':
      return { action: 'none', reason: plan.reason, staleRowIgnored: plan.staleRowIgnored };
    case 'refuse':
      return { action: 'refuse', reason: plan.reason, ...(plan.targetPort !== undefined ? { targetPort: plan.targetPort } : {}) };
  }
}

/** Re-exported for callers that key caches by holder without importing the core. */
export type { DevPreviewHolderRef };
