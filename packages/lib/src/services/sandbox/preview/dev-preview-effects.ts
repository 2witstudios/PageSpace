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

/**
 * The store surface the effects layer needs: the holder-keyed write (a
 * compare-and-set on the user's stop intent — see `dev-preview-store.ts`)
 * and the read that confirms that intent still stands before the one
 * destructive effect that writes nothing (`stop-relay`).
 */
export interface DevPreviewRowWriter {
  upsert(intent: DevPreviewRowIntent): Promise<boolean>;
  findByHolder(holder: DevPreviewHolderRef): Promise<{ stoppedByUserAt: Date | null } | null>;
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
  | { action: 'start-relay'; via: 'create' | 'start' | 'already-running'; targetPort: number; recorded: boolean }
  | { action: 'replace-relay'; previousTargetPort: number; targetPort: number; recorded: boolean }
  | { action: 'record-direct'; removedRelay: boolean; recorded: boolean }
  /**
   * The port was recorded so the UI can name it and offer the decision, and
   * NOTHING was started — an unlisted port is not shared until a person says
   * so (`requiresPreviewApproval`). Any relay for a PREVIOUS target was taken
   * down, because that relay is exposure nobody asked to keep.
   */
  | { action: 'await-approval'; targetPort: number; removedRelay: boolean; recorded: boolean }
  | { action: 'stop-relay'; relayServiceName: string }
  | { action: 'none'; reason: string; staleRowIgnored: boolean }
  | { action: 'refuse'; reason: string; targetPort?: number }
  /**
   * The plan was refused by the USER'S OWN INTENT, which changed between the
   * read it was planned from and this write: a row write the intent guard
   * turned down (`intent-changed`), or a `stop-relay` for a stop the user has
   * since cleared (`resumed`). Not an error — the next reconcile plans from
   * the row that won.
   */
  | {
      action: 'skipped';
      reason: 'intent-changed' | 'resumed';
      /**
       * What was done to the SPRITE before the refusal. Always `'none'`, and
       * that is the point: the row is written before any service call, so a
       * refused plan cannot leave a relay behind. The field exists so the
       * type has to be changed before the ordering can be — a future
       * re-ordering would make this a lie, and lies should not typecheck.
       */
      mutated: 'none';
    }
  /**
   * Another writer holds this holder's lock and the retry budget is spent.
   * Nothing was read, planned or done. The next frame — or the backstop
   * sweep — converges; see `dev-preview-lock.ts`.
   */
  | { action: 'deferred'; reason: 'reconcile-in-progress' };

/**
 * Carry out one plan: **the row first, then the service calls.**
 *
 * THE ORDER IS THE CORRECTNESS PROPERTY, and it used to be the other way
 * round. The two failure shapes are not symmetric:
 *
 *  - ROW AHEAD OF SPRITE (the row is written, the service call then fails):
 *    `describeServiceState` folds row + live relay and reports `down` — "the
 *    preview relay for port N is not defined on this sandbox" — and the next
 *    plan is `start-relay via create`. **It converges**, and it never lies in
 *    the meantime.
 *  - SPRITE AHEAD OF ROW (service-first, and the row write is then refused by
 *    the intent guard): a relay is left RUNNING that no future plan can see,
 *    because `relayServiceName` was never written. `planDevServerService`
 *    reads the row, sees a user-stopped preview with no relay recorded, and
 *    answers `user-stopped` forever. **It never converges** — the relay is
 *    orphaned for the life of the sprite.
 *
 * So a refused write must cost nothing, which it can only do if nothing has
 * been done yet. The accepted price is a worse SECOND rather than a worse
 * forever: between the row write and the service call the proxy may forward
 * to 8080 with nothing listening, which reads as `down` and self-heals.
 *
 * Compensating service calls on refusal are deliberately NOT built: a
 * compensation is a second effect that can itself fail, needing its own error
 * taxonomy, and row-first removes the need for one entirely.
 *
 * USER INTENT WINS EVERY RACE. A plan is made from a row read moments
 * earlier; a user's stop or resume can land in between. Both places where
 * carrying the plan out would UNDO that click are guarded by the intent the
 * plan was made against: the row write is a compare-and-set in SQL
 * (`basedOnStoppedByUserAt`), and `stop-relay` — destructive without
 * writing — re-reads the row and stops nothing if the stop has been cleared.
 * A refusal is reported as `skipped`, never thrown.
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
      const recorded = await store.upsert(plan.row);
      if (!recorded) return { action: 'skipped', reason: 'intent-changed', mutated: 'none' };
      if (plan.via === 'create') {
        await services.create({ name: plan.service.name, command: plan.service.command, args: plan.service.args });
      } else if (plan.via === 'start') {
        await services.start(plan.service.name);
      }
      return { action: 'start-relay', via: plan.via, targetPort: plan.service.targetPort, recorded };
    }
    case 'replace-relay': {
      // Row first (see the docblock). A refusal here leaves the OLD relay
      // running and the row still naming it — which is exactly right: the
      // refusal means the user's stop landed, and the next reconcile plans
      // `stop-relay` against a row that can still find the relay to stop.
      const recorded = await store.upsert(plan.row);
      if (!recorded) return { action: 'skipped', reason: 'intent-changed', mutated: 'none' };
      // Remove-then-create, never an in-place PUT with a different command:
      // what the platform does with a DIFFERENT command under the same name is
      // unverified (`relayServiceMatches`'s doc), and the core plans around it.
      await services.remove(plan.service.name);
      await services.create({ name: plan.service.name, command: plan.service.command, args: plan.service.args });
      return { action: 'replace-relay', previousTargetPort: plan.previousTargetPort, targetPort: plan.service.targetPort, recorded };
    }
    case 'record-direct': {
      const recorded = await store.upsert(plan.row);
      if (!recorded) return { action: 'skipped', reason: 'intent-changed', mutated: 'none' };
      if (plan.removeRelay) await services.remove(PREVIEW_RELAY_SERVICE_NAME);
      return { action: 'record-direct', removedRelay: plan.removeRelay, recorded };
    }
    case 'await-approval': {
      // Row first, like every other arm. A refusal means the user's stop
      // landed in between, and a stopped preview needs no approval prompt.
      const recorded = await store.upsert(plan.row);
      if (!recorded) return { action: 'skipped', reason: 'intent-changed', mutated: 'none' };
      if (plan.removeRelay) await services.remove(PREVIEW_RELAY_SERVICE_NAME);
      return { action: 'await-approval', targetPort: plan.targetPort, removedRelay: plan.removeRelay, recorded };
    }
    case 'stop-relay': {
      // The mirror of the row guard, for the effect that writes nothing: a
      // frame planned before the user's RESUME must not stop the relay after
      // it. Re-read the intent at the last possible moment; gone ⇒ do
      // nothing (the resume's own reconcile has the relay in hand).
      const current = await store.findByHolder(plan.holder);
      if (current === null || current.stoppedByUserAt === null) return { action: 'skipped', reason: 'resumed', mutated: 'none' };
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
