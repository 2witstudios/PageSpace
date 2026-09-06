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
 * FAIL CLOSED, BOUNDED. When the channel closes it is reopened with backoff
 * up to a small budget; past the budget the watcher is dropped and the fact
 * is logged. Nothing falls back to the TTY channel or to an exec probe (both
 * would miss or wake — see `ports-watch.ts`). A sprite that hibernates drops
 * the channel; a later ensure/shell re-asserts the watcher. A watcher whose
 * sprite the platform no longer has (attach → null) is dropped at once.
 */

import type { SandboxHandle } from '@pagespace/lib/services/sandbox/sandbox-host';
import type { DevPreviewHolderRef, ListeningPort } from '@pagespace/lib/services/sandbox/preview/dev-preview-core';
import { createDevPreviewDetector, type DevPreviewDetector, type DevPreviewDetectorLog } from '@pagespace/lib/services/sandbox/preview/dev-preview-detection';
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
  now(): Date;
  /** Test seam for the reconnect delay. */
  wait?: (ms: number) => Promise<void>;
  maxReconnects?: number;
}

export interface DetectionRegistry {
  /** Watch the holder's live sprite (re-derived from the holder's row). Idempotent per sprite. */
  ensure(input: { holder: DevPreviewHolderRef }): Promise<void>;
  /**
   * The listener snapshot the holder's watcher holds for its CURRENT
   * connection, or `null` when there is no such snapshot: no watcher for the
   * holder's live sprite (never watched, dropped past the reconnect budget,
   * or the sprite is on another instance's channel), a connection that has
   * not yet delivered its initial `port_list`, or a dropped connection
   * waiting out the reconnect backoff. In those last two windows the
   * detector's array is stale or merely empty, and handing it out as a KNOWN
   * snapshot would let a render call 8080 free (and a resume start a relay
   * onto an occupied port); "unknown" is the honest answer there. This is
   * the ONLY listener source a status render may use — it is already in
   * hand, so answering costs the sprite nothing (the never-probe-to-render
   * rule). `null` renders as "slot unknown", never as "free".
   */
  listeners(input: { holder: DevPreviewHolderRef }): Promise<ListeningPort[] | null>;
  /** Sprites currently watched — for tests and for a status line. */
  watching(): string[];
  stopAll(): void;
}

const DEFAULT_MAX_RECONNECTS = 5;
const BACKOFF_MS = [1_000, 2_000, 5_000, 10_000, 30_000];

export function createDetectionRegistry(deps: DetectionRegistryDeps): DetectionRegistry {
  const wait = deps.wait ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const maxReconnects = deps.maxReconnects ?? DEFAULT_MAX_RECONNECTS;
  /**
   * One entry per watched sprite: how to close it, its detector (the snapshot
   * source for `listeners()`; null while the slot is only reserved), and
   * whether the CURRENT connection's `port_list` has been APPLIED by the
   * detector (`fresh`). `fresh` flips on only after the detector's serialized
   * chain has folded the snapshot in — flipping it on frame ARRIVAL would hand
   * out the previous connection's set as this one's for a tick — and flips
   * off on every close. One map, one lifetime: an entry is created by the
   * reservation, replaced when the channel opens, and deleted on every exit.
   */
  interface Watcher {
    close(): void;
    detector: DevPreviewDetector | null;
    fresh: boolean;
  }
  const watchers = new Map<string, Watcher>();

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
    const detector = createDevPreviewDetector({ holder, handle, store: deps.store, now: deps.now, log: deps.log });
    const url = buildPortsWatchUrl(deps.spritesApiBaseUrl(), sandboxId);
    let stopped = false;
    let current: PortsWatchHandle | null = null;
    let attempts = 0;
    // Which connection a frame belongs to: a `port_list` that finishes
    // applying after its socket has already dropped must not mark the NEXT
    // connection fresh.
    let generation = 0;

    const entry: Watcher = {
      detector,
      fresh: false,
      close() {
        stopped = true;
        current?.close();
        watchers.delete(sandboxId);
      },
    };

    const open = () => {
      generation += 1;
      const mine = generation;
      current = openPortsWatch({
        url,
        token: deps.spritesToken(),
        createSocket: deps.createSocket,
        onFrame: (frame) => {
          // The platform's first frame on a connection is the full `port_list`
          // (ports-watch.ts). The detector applies frames on a serialized
          // chain, so the set describes THIS connection only once that frame
          // has been APPLIED — hence `fresh` flips after `onFrame` resolves,
          // and only if this connection is still the live one.
          const applied = detector.onFrame(frame);
          if (frame.type === 'port_list') {
            void applied.then(() => {
              if (!stopped && mine === generation && current !== null) entry.fresh = true;
            });
          }
        },
        onClose: (info) => {
          current = null;
          entry.fresh = false;
          if (stopped) return;
          if (info.opened) attempts = 0;
          if (info.reason === 'no-token' || attempts >= maxReconnects) {
            deps.log.warn('dev-preview: watch channel gone, detection stopped for this sprite', { holderKind: holder.kind, holderId: holder.id, reason: info.reason, attempts });
            stopped = true;
            watchers.delete(sandboxId);
            return;
          }
          const delay = BACKOFF_MS[Math.min(attempts, BACKOFF_MS.length - 1)];
          attempts += 1;
          void wait(delay).then(() => { if (!stopped) open(); });
        },
      });
    };

    watchers.set(sandboxId, entry);
    open();
    deps.log.info('dev-preview: watching sprite', { holderKind: holder.kind, holderId: holder.id });
  }

  return {
    async ensure({ holder }) {
      if (!deps.featureEnabled()) return;
      // The sprite is re-derived from the holder's ROW, never taken from the
      // caller: a signed trigger names a holder, and the row says which VM (if
      // any) that holder is on right now.
      const sandboxId = await deps.resolveHolderSandboxId(holder);
      if (sandboxId === null) return;
      if (watchers.has(sandboxId)) return;
      // Reserve the slot synchronously so two concurrent ensures start one watcher.
      watchers.set(sandboxId, { detector: null, fresh: false, close() { watchers.delete(sandboxId); } });
      try {
        await start(holder, sandboxId);
      } catch (error) {
        // Whatever `start` had registered goes with the failure — the
        // reservation, or the live entry if the throw came after it was set.
        watchers.delete(sandboxId);
        deps.log.error('dev-preview: watcher failed to start', error instanceof Error ? error : new Error(String(error)), { holderKind: holder.kind, holderId: holder.id });
      }
    },
    async listeners({ holder }) {
      if (!deps.featureEnabled()) return null;
      // Same rule as `ensure`: the sprite is the holder's ROW's, never a claim.
      const sandboxId = await deps.resolveHolderSandboxId(holder);
      if (sandboxId === null) return null;
      const entry = watchers.get(sandboxId);
      return entry !== undefined && entry.fresh && entry.detector !== null ? entry.detector.listeners() : null;
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
