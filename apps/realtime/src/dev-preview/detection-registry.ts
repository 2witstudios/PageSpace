/**
 * One `ports/watch` watcher per live sprite, for as long as the channel
 * lives — the realtime tier's half of dev-server detection.
 *
 * `ensure({ holder })` is idempotent: a sprite already being watched is
 * left alone (the web tier's trigger and the shell bridge both
 * call it freely). A watcher attaches to the sprite (a control-plane read —
 * the caller has just ensured or opened a shell on it, so it is awake),
 * opens the watch channel, and feeds every frame to a detector
 * (`dev-preview-detection.ts`), which plans and applies relay effects
 * through the core.
 *
 * FAIL CLOSED, BOUNDED — AND RECOVERABLE. When the channel closes it is
 * reopened with backoff up to a small budget; past the budget the watcher is
 * dropped and the fact is logged. Nothing falls back to the TTY channel or to
 * an exec probe (both would miss or wake — see `ports-watch.ts`).
 *
 * Every drop is terminal FOR THAT CHANNEL, deliberately: recovery never
 * resurrects a timer that might outlive the sprite, it re-derives the holder's
 * live sandbox from its ROW. What makes a drop survivable is that the status
 * READ re-arms a missing watcher (`read`, below) — which also covers the case
 * no reconnect can: this process restarting and losing every watcher it had.
 * Without that, a dropped watcher meant detection was over for that sprite
 * until somebody happened to open a shell or provision a session again.
 *
 * The re-arm is throttled, because the read happens on every status render:
 * an unattachable or hibernated sprite must not be re-attacked several times a
 * minute. One holder nobody is looking at and nobody shells into still gets no
 * watcher — that costs one poll interval of relay-start latency the moment
 * someone does look, and nothing else.
 */

import type { SandboxHandle } from '@pagespace/lib/services/sandbox/sandbox-host';
import type { DevPreviewHolderRef, ListeningPort } from '@pagespace/lib/services/sandbox/preview/dev-preview-core';
import { createDevPreviewDetector, type DevPreviewDetector, type DevPreviewDetectorLog } from '@pagespace/lib/services/sandbox/preview/dev-preview-detection';
import type { DevPreviewLock } from '@pagespace/lib/services/sandbox/preview/dev-preview-lock';
import type { DevPreviewStore } from '@pagespace/lib/services/sandbox/preview/dev-preview-store';
import { buildPortsWatchUrl, openPortsWatch, type PortsWatchHandle, type PortsWatchSocketFactory } from '@pagespace/lib/services/sandbox/preview/ports-watch';

export interface DetectionRegistryDeps {
  featureEnabled(): boolean;
  /** The holder's LIVE sprite name from its own row (session or env), or null — the caller's claim is never trusted. */
  resolveHolderSandboxId(holder: DevPreviewHolderRef): Promise<string | null>;
  attach(sandboxId: string): Promise<SandboxHandle | null>;
  store: DevPreviewStore;
  createSocket: PortsWatchSocketFactory;
  spritesToken(): string;
  spritesApiBaseUrl(): string;
  log: DevPreviewDetectorLog;
  /**
   * Serializes a frame's read → plan → apply against the web tier's stop and
   * resume. Optional so the unit surface needs no Postgres; `index.ts` binds
   * the real advisory lock.
   */
  lock?: DevPreviewLock;
  now(): Date;
  /** Test seam for the reconnect delay. */
  wait?: (ms: number) => Promise<void>;
  maxReconnects?: number;
  /** The non-resetting ceiling for one watcher; a flapping channel is dropped and the read path re-arms it. */
  maxTotalReconnects?: number;
}

/**
 * Whether detection is actually running for a holder right now — a fact the
 * old `listeners()` could not express, because `null` meant both "no snapshot
 * yet" and "nobody is watching at all".
 */
export type DevPreviewDetection = 'watching' | 'arming' | 'unavailable';

export interface DevPreviewDetectionRead {
  detection: DevPreviewDetection;
  listeners: ListeningPort[] | null;
}

export interface DetectionRegistry {
  /** Watch the holder's live sprite (re-derived from the holder's row). Idempotent per sprite. */
  ensure(input: { holder: DevPreviewHolderRef }): Promise<void>;
  /**
   * What this process knows about the holder's ports, and whether it is
   * watching at all — plus the re-arm that makes a lost watcher recoverable.
   *
   * `listeners` is the snapshot for the CURRENT connection, or `null` when
   * there is no such snapshot: no watcher, a connection that has not yet
   * delivered its `port_list`, or a dropped connection waiting out the
   * backoff. In those windows the detector's array is stale or merely empty,
   * and handing it out as KNOWN would let a render call 8080 free (and a
   * resume start a relay onto an occupied port). This is the ONLY listener
   * source a status render may use — it is already in hand, so answering
   * costs the sprite nothing (the never-probe-to-render rule).
   *
   * `detection` separates the two meanings `null` used to conflate, so the UI
   * can say "the ports are not known right now" instead of implying the
   * sandbox is idle. When nothing is watching a holder that HAS a live
   * sprite, this fires a throttled re-arm and answers `'arming'`; the caller
   * is never made to wait for it.
   */
  read(input: { holder: DevPreviewHolderRef }): Promise<DevPreviewDetectionRead>;
  /** Sprites currently watched — for tests and for a status line. */
  watching(): string[];
  stopAll(): void;
}

const DEFAULT_MAX_RECONNECTS = 5;
const BACKOFF_MS = [1_000, 2_000, 5_000, 10_000, 30_000];
/** Roughly an hour of the longest backoff — long past "a blip", short of "forever". */
const DEFAULT_MAX_TOTAL_RECONNECTS = 120;
/**
 * How long a read-driven re-arm waits before trying a sprite again. The status
 * read fires every few seconds per viewer; without this, a sprite that cannot
 * be attached (hibernated, gone) would be retried on every render.
 */
export const REARM_COOLDOWN_MS = 30_000;

export function createDetectionRegistry(deps: DetectionRegistryDeps): DetectionRegistry {
  const wait = deps.wait ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const maxReconnects = deps.maxReconnects ?? DEFAULT_MAX_RECONNECTS;
  const maxTotalReconnects = deps.maxTotalReconnects ?? DEFAULT_MAX_TOTAL_RECONNECTS;
  /**
   * One entry per watched sprite: how to close it, and its detector — the
   * snapshot source for `listeners()`, null while the slot is only reserved.
   * Snapshot VALIDITY is the detector's own (`DevPreviewDetector.listeners`
   * is null until a `port_list` has been applied since the last
   * `invalidateSnapshot`, which this registry queues on every close); the
   * registry keeps no bookkeeping of its own about it. One map, one
   * lifetime: an entry is created by the reservation, replaced when the
   * channel opens, and deleted on every exit.
   */
  interface Watcher {
    close(): void;
    detector: DevPreviewDetector | null;
    /**
     * The Sprite INSTANCE this watcher's detector holds a handle to, or null
     * while the reservation is still resolving. A sprite NAME is reused across
     * re-creates, so this is the only way to notice that the VM behind the
     * name has been replaced — see {@link armIfMissing}.
     */
    spriteInstanceId: string | null;
  }
  const watchers = new Map<string, Watcher>();
  /** sandboxId → when a re-arm was last attempted, so the read path cannot storm a sick sprite. */
  const lastArmAt = new Map<string, number>();

  async function start(holder: DevPreviewHolderRef, sandboxId: string): Promise<void> {
    const reservation = watchers.get(sandboxId);
    const handle = await deps.attach(sandboxId);
    // `stopAll` (or a close) released the reservation while `attach` was
    // pending: nothing could stop a channel opened now, so open none.
    if (watchers.get(sandboxId) !== reservation) return;
    if (handle === null) {
      deps.log.warn('dev-preview: sprite not attachable, not watching', { holderKind: holder.kind, holderId: holder.id });
      watchers.delete(sandboxId);
      return;
    }
    const detector = createDevPreviewDetector({ holder, handle, store: deps.store, now: deps.now, log: deps.log, lock: deps.lock });
    const url = buildPortsWatchUrl(deps.spritesApiBaseUrl(), sandboxId);
    let stopped = false;
    let current: PortsWatchHandle | null = null;
    let attempts = 0;
    // A SECOND, NON-RESETTING budget. `attempts` is reset by any connection
    // that opens, which is right for a channel that drops once and recovers —
    // but a channel that opens and dies immediately, over and over, resets it
    // every time and reconnects forever, which the docblock's "past the budget
    // the watcher is dropped" does not describe. Dropping such a watcher is
    // cheap now: a status read re-arms it within a poll interval, so the
    // ceiling costs at most that, and a flap that has survived it is a sprite
    // problem rather than a connection problem.
    let totalAttempts = 0;

    const entry: Watcher = {
      detector,
      spriteInstanceId: handle.spriteInstanceId,
      close() {
        stopped = true;
        current?.close();
        watchers.delete(sandboxId);
      },
    };

    const open = () => {
      current = openPortsWatch({
        url,
        token: deps.spritesToken(),
        createSocket: deps.createSocket,
        onFrame: (frame) => { void detector.onFrame(frame); },
        onClose: (info) => {
          current = null;
          // The accumulated set no longer describes a live connection. Takes
          // effect immediately — a reader between this close and the next
          // connection's snapshot must not be answered from the dead one —
          // while the detector's arrival epoch stops a frame still applying
          // from claiming the NEXT connection's snapshot.
          detector.invalidateSnapshot();
          if (stopped) return;
          if (info.opened) attempts = 0;
          if (info.reason === 'no-token' || attempts >= maxReconnects || totalAttempts >= maxTotalReconnects) {
            deps.log.warn('dev-preview: watch channel gone, detection stopped for this sprite', { holderKind: holder.kind, holderId: holder.id, reason: info.reason, attempts, totalAttempts });
            stopped = true;
            watchers.delete(sandboxId);
            return;
          }
          const delay = BACKOFF_MS[Math.min(attempts, BACKOFF_MS.length - 1)];
          attempts += 1;
          totalAttempts += 1;
          void wait(delay).then(() => { if (!stopped) open(); });
        },
      });
    };

    watchers.set(sandboxId, entry);
    open();
    deps.log.info('dev-preview: watching sprite', { holderKind: holder.kind, holderId: holder.id });
  }

  /**
   * Start a watcher for a sprite that has none. `throttled` is for the read
   * path, which runs on every status render; explicit triggers (a shell open,
   * a provision, the signed watch call) are never throttled — they mean
   * something just happened.
   */
  async function armIfMissing(holder: DevPreviewHolderRef, sandboxId: string, { throttled }: { throttled: boolean }): Promise<void> {
    const existing = watchers.get(sandboxId);
    if (existing !== undefined) {
      // A NAME IS NOT AN IDENTITY. A rebuild re-creates the sprite under the
      // same name, so a watcher armed against the old VM still answers
      // `watchers.has` — and its detector holds a handle whose instance id is
      // dead. It would then write rows naming a VM that no longer exists while
      // its service calls land on the new one: every render says `stale`, the
      // proxy 409s, and nothing recovers it short of a process restart. That
      // is the ABA case `spriteInstanceId` exists for.
      //
      // Only an EXPLICIT trigger checks: those are the moments a VM can have
      // just been replaced (a provision, a shell open, the signed watch call),
      // and the check costs one control-plane attach, which never wakes a
      // sprite. The throttled read path keeps its cheap short-circuit.
      if (throttled || existing.spriteInstanceId === null) return;
      const live = await deps.attach(sandboxId).catch(() => null);
      if (live === null || live.spriteInstanceId === existing.spriteInstanceId) return;
      deps.log.info('dev-preview: sprite replaced under the same name, re-watching', {
        holderKind: holder.kind,
        holderId: holder.id,
      });
      existing.close();
    }
    const now = deps.now().getTime();
    // Sweep as we go: the map only ever holds sprites armed within the
    // cool-down, so it cannot grow with the number of sprites ever seen.
    for (const [key, at] of lastArmAt) if (now - at >= REARM_COOLDOWN_MS) lastArmAt.delete(key);
    if (throttled) {
      const last = lastArmAt.get(sandboxId);
      if (last !== undefined && now - last < REARM_COOLDOWN_MS) return;
    }
    lastArmAt.set(sandboxId, now);
    // Reserve the slot synchronously so two concurrent arms start one watcher.
    const reservation: Watcher = { detector: null, spriteInstanceId: null, close() { watchers.delete(sandboxId); } };
    watchers.set(sandboxId, reservation);
    try {
      await start(holder, sandboxId);
    } catch (error) {
      // Whatever `start` had registered goes with the failure — but only if it
      // is still OURS. A `stopAll` and a fresh arm can both have happened while
      // this one was failing, and deleting blindly would drop a live entry
      // without closing it, leaking its reconnecting socket.
      if (watchers.get(sandboxId) === reservation) watchers.delete(sandboxId);
      deps.log.error('dev-preview: watcher failed to start', error instanceof Error ? error : new Error(String(error)), { holderKind: holder.kind, holderId: holder.id });
    }
  }

  return {
    async ensure({ holder }) {
      if (!deps.featureEnabled()) return;
      // The sprite is re-derived from the holder's ROW, never taken from the
      // caller: a signed trigger names a holder, and the row says which VM (if
      // any) that holder is on right now.
      const sandboxId = await deps.resolveHolderSandboxId(holder);
      if (sandboxId === null) return;
      await armIfMissing(holder, sandboxId, { throttled: false });
    },
    async read({ holder }) {
      if (!deps.featureEnabled()) return { detection: 'unavailable', listeners: null };
      // Same rule as `ensure`: the sprite is the holder's ROW's, never a claim.
      const sandboxId = await deps.resolveHolderSandboxId(holder);
      if (sandboxId === null) return { detection: 'unavailable', listeners: null };
      const entry = watchers.get(sandboxId);
      if (entry === undefined) {
        // Nothing is watching a holder that HAS a live sprite — a restart, an
        // exhausted budget, an unattachable moment that has passed. Re-arm and
        // tell the caller so; never await it inside a render.
        void armIfMissing(holder, sandboxId, { throttled: true });
        return { detection: 'arming', listeners: null };
      }
      if (entry.detector === null) return { detection: 'arming', listeners: null };
      return { detection: 'watching', listeners: entry.detector.listeners() };
    },
    watching: () => [...watchers.keys()],
    stopAll() {
      for (const watcher of [...watchers.values()]) watcher.close();
    },
  };
}

/** The runtime `WebSocket` (Node ≥ 24 honours `{ headers }`, the same fact the Sprites SDK's exec path relies on). */
export const nodeWebSocketFactory: PortsWatchSocketFactory = (url, headers) =>
  new WebSocket(url, { headers } as unknown as string[]) as unknown as ReturnType<PortsWatchSocketFactory>;
