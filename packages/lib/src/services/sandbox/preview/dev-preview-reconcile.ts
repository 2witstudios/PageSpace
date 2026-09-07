/**
 * The dev-preview BACKSTOP SWEEP — the one gap the per-holder lock cannot
 * close.
 *
 * A user's Stop is durable the moment it is written: `applyDevPreviewUserAction`
 * records the intent even when the holder's lock is contended or the lock pool
 * is degraded, and then defers the relay work. Deferring is safe only if
 * something later re-plans, and normally something does — the realtime
 * detector's next `ports/watch` frame. But a holder nobody is watching
 * generates no frames at all, and a stop is exactly the moment a dev server
 * tends to go quiet. Left alone, that row says "switched off" while the relay
 * keeps serving until the sprite dies.
 *
 * So: every few minutes, take the rows that claim to be switched off while
 * still naming a relay, and converge them.
 *
 * THE SWEEP CAN ONLY EVER STOP, NEVER START. Two independent things make
 * that true, and the first is the load-bearing one:
 *
 *  1. It re-reads the row UNDER THE LOCK and does nothing unless that row
 *     still carries a stop intent and still names a relay. The core answers a
 *     stopped row with `stop-relay` or `none` and nothing else, so no plan
 *     this module can produce starts anything. The re-read is also what makes
 *     a resume that landed since the listing query win.
 *  2. Belt and braces: it plans with `listenersKnown: false`, so even if (1)
 *     were ever loosened, a plan that would START a relay is refused
 *     (`slot-unknown`) rather than made against an assumed-empty listener
 *     set. No `ports/watch` snapshot reaches this process, and "unknown" must
 *     never be read as "8080 is free".
 *
 * NEVER WAKES A SPRITE. `attach` is a control-plane read; a paused sprite
 * stays paused, and a relay inside a paused sprite is serving nobody anyway —
 * it will be stopped on the next sweep after the sprite wakes.
 *
 * NO CRON-LEVEL LOCK, and a per-holder try-lock with NO retries: busy means a
 * live path already owns this holder and is doing the same work, so skipping
 * is the whole point. Every write underneath is a compare-and-set, so
 * overlapping runs converge (the `reconcile-orphaned-sprites` posture).
 */

import { planDevServerService, type DevPreviewHolderRef } from './dev-preview-core';
import { applyDevServerServicePlan } from './dev-preview-effects';
import { unlocked, type DevPreviewLock } from './dev-preview-lock';
import type { DevPreviewStore } from './dev-preview-store';
import type { SandboxHandle } from '../sandbox-host';
import { PREVIEW_RELAY_SERVICE_NAME } from './preview-relay';

/** A candidate row: a holder whose stop intent has outlived its relay. */
export interface DevPreviewStopCandidate {
  holder: DevPreviewHolderRef;
  sandboxId: string;
}

export interface DevPreviewReconcileDeps {
  /**
   * Rows with `stoppedByUserAt IS NOT NULL AND relayServiceName IS NOT NULL`
   * that have not been touched for `staleAfterMs`, oldest first, capped at
   * `limit`. The age bound is what keeps the sweep off rows a live path is
   * still working through.
   */
  findStoppedWithRelay(input: { staleAfterMs: number; limit: number }): Promise<DevPreviewStopCandidate[]>;
  /** A control-plane attach; null when the platform no longer has the sprite. MUST NOT wake. */
  attach(sandboxId: string): Promise<SandboxHandle | null>;
  previewStore: DevPreviewStore;
  lock?: DevPreviewLock;
  /** Dark deployments do no work at all. */
  featureEnabled(): boolean;
  now(): Date;
  log?: { warn(message: string, context?: Record<string, unknown>): void };
}

export interface DevPreviewReconcileRun {
  /** Candidates considered. */
  processed: number;
  /** Relays actually stopped. */
  stopped: number;
  /** Nothing to do, the holder was locked by a live path, or the sprite is gone. */
  skipped: number;
  /** An attach or a service call threw. The row keeps its intent and the next sweep retries. */
  failed: number;
}

/** Two minutes: long enough that a click's own reconcile has finished or plainly failed. */
export const DEV_PREVIEW_SWEEP_STALE_AFTER_MS = 2 * 60 * 1000;
/** Bounded so one tick cannot hold the control plane open indefinitely. */
export const DEV_PREVIEW_SWEEP_LIMIT = 50;

export async function reconcileStoppedDevPreviews(deps: DevPreviewReconcileDeps): Promise<DevPreviewReconcileRun> {
  const run: DevPreviewReconcileRun = { processed: 0, stopped: 0, skipped: 0, failed: 0 };
  if (!deps.featureEnabled()) return run;

  const lock = deps.lock ?? unlocked;
  const candidates = await deps.findStoppedWithRelay({ staleAfterMs: DEV_PREVIEW_SWEEP_STALE_AFTER_MS, limit: DEV_PREVIEW_SWEEP_LIMIT });

  for (const candidate of candidates) {
    run.processed += 1;
    try {
      const outcome = await lock(candidate.holder, async () => {
        // Re-read under the lock: the intent may have been cleared by a resume
        // between the listing query and now, and the sweep must never act on a
        // row it has not just seen.
        const row = await deps.previewStore.findByHolder(candidate.holder);
        if (row === null || row.stoppedByUserAt === null || row.relayServiceName === null) return 'skipped' as const;

        const handle = await deps.attach(row.sandboxId);
        if (handle === null) return 'skipped' as const;
        const relay = await handle.services.get(PREVIEW_RELAY_SERVICE_NAME);
        const plan = planDevServerService({
          liveInstanceId: handle.spriteInstanceId,
          sandboxId: handle.sandboxId,
          row,
          holder: candidate.holder,
          detected: null,
          relay,
          listeners: [],
          // Belt and braces beside the re-read above; see the module doc.
          listenersKnown: false,
          now: deps.now(),
        });
        const applied = await applyDevServerServicePlan({ plan, services: handle.services, store: deps.previewStore });
        return applied.action === 'stop-relay' ? ('stopped' as const) : ('skipped' as const);
      });
      if (outcome.outcome === 'busy') run.skipped += 1;
      else if (outcome.result === 'stopped') run.stopped += 1;
      else run.skipped += 1;
    } catch (error) {
      run.failed += 1;
      deps.log?.warn('dev-preview: backstop sweep failed for a holder', {
        holderKind: candidate.holder.kind,
        holderId: candidate.holder.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return run;
}
