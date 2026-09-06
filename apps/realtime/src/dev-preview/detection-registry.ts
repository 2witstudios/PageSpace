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
import type { DevPreviewHolderRef } from '@pagespace/lib/services/sandbox/preview/dev-preview-core';
import { createDevPreviewDetector, type DevPreviewDetectorLog } from '@pagespace/lib/services/sandbox/preview/dev-preview-detection';
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
  /** Sprites currently watched — for tests and for a status line. */
  watching(): string[];
  stopAll(): void;
}

const DEFAULT_MAX_RECONNECTS = 5;
const BACKOFF_MS = [1_000, 2_000, 5_000, 10_000, 30_000];

export function createDetectionRegistry(deps: DetectionRegistryDeps): DetectionRegistry {
  const wait = deps.wait ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const maxReconnects = deps.maxReconnects ?? DEFAULT_MAX_RECONNECTS;
  const watchers = new Map<string, { close(): void }>();

  async function start(holder: DevPreviewHolderRef, sandboxId: string): Promise<void> {
    const handle = await deps.attach(sandboxId);
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

    const open = () => {
      current = openPortsWatch({
        url,
        token: deps.spritesToken(),
        createSocket: deps.createSocket,
        onFrame: (frame) => { void detector.onFrame(frame); },
        onClose: (info) => {
          current = null;
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

    watchers.set(sandboxId, {
      close() {
        stopped = true;
        current?.close();
        watchers.delete(sandboxId);
      },
    });
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
      watchers.set(sandboxId, { close() { watchers.delete(sandboxId); } });
      try {
        await start(holder, sandboxId);
      } catch (error) {
        watchers.delete(sandboxId);
        deps.log.error('dev-preview: watcher failed to start', error instanceof Error ? error : new Error(String(error)), { holderKind: holder.kind, holderId: holder.id });
      }
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
