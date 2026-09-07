/**
 * Dev-preview DETECTION — the loop that turns `ports/watch` frames into
 * relay effects and rows, for ONE holder's sprite.
 *
 *   frame ──► listeners (bookkeeping) ──► classifyDetectedDevServer
 *         ──► planDevServerService (the core, pure)
 *         ──► applyDevServerServicePlan (the effects) ──► holder-keyed upsert
 *
 * Every decision is the core's. This module only gathers the core's inputs —
 * the row for the holder, the relay as the services API reports it, the
 * live instance id the handle carries, the listener snapshot it has
 * accumulated — and carries out the plan. In particular it does NOT decide
 * whether an unlisted port should displace a working preview (the core's
 * thrash guard), whether a user-stopped preview may be restarted (the core
 * honours `stoppedByUserAt`), or whether a row for a dead instance means
 * anything (the core ignores it). If any of those look wrong, the fix is in
 * `dev-preview-core.ts`, where it is pure and mutation-tested.
 *
 * WHEN IT RUNS. The detector is attached by the realtime tier for a sprite
 * that is known to be AWAKE — a shell just opened on it, or the web tier just
 * ensured it — and it lives as long as the watch channel does (plus the
 * caller's bounded reconnects). It never wakes a sprite to look: the only
 * exec it ever issues is the relay-runtime probe, and that is issued only on
 * the effect path, right after a port was observed to open (so the sprite is
 * awake by definition), and cached for the instance.
 *
 * SERIALIZED. Frames are processed one at a time in arrival order: a plan is
 * computed against the state the previous plan left behind, never against a
 * snapshot two frames old. A failed frame is logged and dropped; the next
 * frame plans afresh from the database and the services API (both of which
 * the failed effect may have partly changed — the core handles a relay that
 * is defined but whose row is missing, and vice versa).
 */

import type { SandboxHandle } from '../sandbox-host';
import {
  classifyDetectedDevServer,
  planDevServerService,
  KNOWN_DEV_SERVER_PORTS,
  type DevPreviewHolderRef,
  type DevServerClassification,
  type ListeningPort,
} from './dev-preview-core';
import { applyDevServerServicePlan, probeRelayRuntime, type AppliedDevServerServicePlan } from './dev-preview-effects';
import { unlocked, type DevPreviewLock } from './dev-preview-lock';
import type { DevPreviewStore } from './dev-preview-store';
import { PREVIEW_RELAY_SERVICE_NAME, type PreviewRelayRuntime } from './preview-relay';
import type { PortsWatchFrame } from './ports-watch';

export interface DevPreviewDetectorLog {
  info(message: string, context?: Record<string, unknown>): void;
  warn(message: string, context?: Record<string, unknown>): void;
  error(message: string, error?: Error, context?: Record<string, unknown>): void;
}

export interface DevPreviewDetectorDeps {
  holder: DevPreviewHolderRef;
  /** The handle for the holder's LIVE sprite: instance identity, the services API, and exec (for the one runtime probe). */
  handle: Pick<SandboxHandle, 'sandboxId' | 'spriteInstanceId' | 'services' | 'exec'>;
  store: DevPreviewStore;
  now: () => Date;
  log: DevPreviewDetectorLog;
  /** Test seam; production probes with `probeRelayRuntime`. */
  probeRuntime?: (exec: SandboxHandle['exec']) => Promise<PreviewRelayRuntime>;
  /**
   * Serializes this holder's read → plan → apply against the WEB tier's user
   * actions. Defaults to no serialization so the pure unit surface needs no
   * Postgres; the realtime binding supplies the real advisory lock.
   */
  lock?: DevPreviewLock;
}

export interface DevPreviewDetector {
  /** Feed one watch frame. Resolves when its effects (if any) have landed; never rejects. */
  onFrame(frame: PortsWatchFrame): Promise<void>;
  /**
   * The listener set as accumulated by the CURRENT connection, or `null`
   * when no `port_list` has been APPLIED since the last
   * {@link DevPreviewDetector.invalidateSnapshot} — before the first
   * snapshot, and between a socket drop and the next connection's snapshot.
   * Only an applied snapshot describes the connection; a frame that has
   * arrived but sits behind the serialized chain does not, and handing the
   * pre-snapshot set out as known would let a render call 8080 free (or a
   * resume start a relay onto an occupied port). `null` renders as "slot
   * unknown", never as "free".
   */
  listeners(): ListeningPort[] | null;
  /**
   * The watch connection dropped: the accumulated set no longer describes a
   * live connection. Takes effect IMMEDIATELY — a `listeners()` between the
   * close and the next connection's snapshot must not be answered from the
   * dead connection's set, so this cannot wait behind queued frame work.
   * Frames already enqueued are tagged with the epoch they arrived in, so a
   * `port_list` from the closed connection that applies afterwards cannot
   * mark the NEXT connection's snapshot known either.
   */
  invalidateSnapshot(): void;
}

type Detected = Extract<DevServerClassification, { kind: 'dev-server' }>;

export function createDevPreviewDetector(deps: DevPreviewDetectorDeps): DevPreviewDetector {
  const { holder, handle, store, now, log } = deps;
  const probe = deps.probeRuntime ?? probeRelayRuntime;
  const lock = deps.lock ?? unlocked;
  const listeners = new Map<number, ListeningPort>();
  /** True once a `port_list` has been applied and no invalidation has landed since. */
  let snapshotKnown = false;
  /**
   * Bumped by every invalidation. A frame carries the epoch it ARRIVED in, so
   * work that applies after its connection died cannot claim the snapshot.
   */
  let epoch = 0;
  let runtime: PreviewRelayRuntime | undefined;
  let chain: Promise<void> = Promise.resolve();

  const context = () => ({ holderKind: holder.kind, holderId: holder.id, spriteInstanceId: handle.spriteInstanceId });

  /**
   * The authoritative read → plan → apply, serialized per holder against the
   * web tier's stop/resume (`dev-preview-lock.ts`). Only this is locked: the
   * listener bookkeeping and `classifyDetectedDevServer` above are pure and
   * in-process, and holding a Postgres connection across them would pin it to
   * work that changes nothing.
   *
   * A bounded retry rather than a bare try-lock, because frames are not
   * guaranteed to recur — a `port_opened` for a server that then sits quiet is
   * often the last frame for minutes, so dropping one can mean the preview
   * silently never appears. Past the budget the frame is DEFERRED, which the
   * next frame or the backstop sweep converges.
   */
  async function reconcile(detected: Detected | null): Promise<AppliedDevServerServicePlan> {
    const outcome = await lock(holder, () => reconcileLocked(detected));
    if (outcome.outcome === 'acquired') return outcome.result;
    return { action: 'deferred', reason: 'reconcile-in-progress' };
  }

  async function reconcileLocked(detected: Detected | null): Promise<AppliedDevServerServicePlan> {
    const [relay, row] = await Promise.all([handle.services.get(PREVIEW_RELAY_SERVICE_NAME), store.findByHolder(holder)]);
    const input = {
      liveInstanceId: handle.spriteInstanceId,
      sandboxId: handle.sandboxId,
      row,
      holder,
      detected,
      relay,
      listeners: [...listeners.values()],
      // UNKNOWN IS NEVER 'FREE', here too. The accumulated set is only a
      // current picture of the sprite once THIS connection's `port_list` has
      // landed; before that — or after `invalidateSnapshot` on a drop, while
      // a frame is still queued on the chain — it is a dead connection's
      // leftovers. Handing it over as if it were current is exactly what
      // `slot-unknown` was added to prevent: the core would read 8080 as free
      // and start a relay that cannot bind.
      listenersKnown: snapshotKnown,
      now: now(),
    };
    let plan = planDevServerService({ ...input, relayRuntime: runtime });
    // The runtime is probed lazily: only when a plan is about to START a
    // relay and no runtime has been chosen for this instance yet. Re-planning
    // with the answer is pure and cheap; probing on every frame is an exec on
    // every frame.
    const startsRelay = (plan.action === 'start-relay' && plan.via === 'create') || plan.action === 'replace-relay';
    if (startsRelay && runtime === undefined) {
      runtime = await probe(handle.exec);
      plan = planDevServerService({ ...input, relayRuntime: runtime });
    }
    return applyDevServerServicePlan({ plan, services: handle.services, store });
  }

  async function handle_(frame: PortsWatchFrame, frameEpoch: number): Promise<void> {
    if (frame.type === 'port_list') {
      listeners.clear();
      for (const port of frame.ports) listeners.set(port.port, port);
      // Only this connection's own snapshot may mark the set known.
      if (frameEpoch === epoch) snapshotKnown = true;
      // A snapshot is every port bound BEFORE we attached. Classify each
      // against the current relay and plan ONE candidate: the row's own
      // target if it is still listening (a reconnect must never re-point a
      // working preview), else the lowest known dev port, else the lowest
      // unlisted one. Planning every candidate in turn would let a second
      // KNOWN port displace the first — the core's thrash guard only shields
      // a known target from UNLISTED newcomers. With no candidate, the core
      // converges the relay on the row's target (or does nothing).
      const [relay, row] = await Promise.all([handle.services.get(PREVIEW_RELAY_SERVICE_NAME), store.findByHolder(holder)]);
      const candidates = frame.ports
        .map((port) => classifyDetectedDevServer({ event: { type: 'port_opened', ...port }, relay }))
        .filter((c): c is Detected => c.kind === 'dev-server')
        .sort((a, b) => Number(KNOWN_DEV_SERVER_PORTS.has(b.port)) - Number(KNOWN_DEV_SERVER_PORTS.has(a.port)) || a.port - b.port);
      const current = row === null ? undefined : candidates.find((c) => c.port === row.targetPort);
      const chosen = current ?? candidates[0] ?? null;
      const applied = await reconcile(chosen);
      log.info('dev-preview: snapshot reconciled', { ...context(), ...(chosen ? { port: chosen.port } : {}), applied: applied.action });
      return;
    }

    if (frame.type === 'port_closed') {
      // Best-effort on the wire (spike §5, §9): bookkeeping only, never a teardown.
      listeners.delete(frame.port);
      return;
    }

    listeners.set(frame.port, { port: frame.port, ...(frame.pid !== undefined ? { pid: frame.pid } : {}) });
    const relay = await handle.services.get(PREVIEW_RELAY_SERVICE_NAME);
    const classified = classifyDetectedDevServer({ event: frame, relay });
    if (classified.kind === 'ignored') return;
    const applied = await reconcile(classified);
    log.info('dev-preview: port planned', { ...context(), port: classified.port, likelihood: classified.likelihood, applied: applied.action, ...('reason' in applied ? { reason: applied.reason } : {}) });
  }

  return {
    onFrame(frame) {
      // The epoch is captured at ARRIVAL, not at apply time: that is what
      // makes a frame belong to the connection it came from.
      const frameEpoch = epoch;
      const next = chain.then(() => handle_(frame, frameEpoch)).catch((error: unknown) => {
        log.error('dev-preview: frame failed', error instanceof Error ? error : new Error(String(error)), { ...context(), frame: frame.type });
      });
      chain = next;
      return next;
    },
    listeners: () => (snapshotKnown ? [...listeners.values()] : null),
    invalidateSnapshot() {
      snapshotKnown = false;
      epoch += 1;
    },
  };
}
