/**
 * Ask the realtime tier to watch a sprite for dev servers.
 *
 * Detection runs on `WSS …/ports/watch`, a long-lived socket only the
 * realtime process can hold (a Next route handler cannot). The web tier
 * knows the moment a sprite comes up — a session ensure just returned — so
 * it tells realtime, the same signed, fire-and-forget way it broadcasts
 * workspace events (`websocket/agent-workspace-events.ts`). Realtime
 * refcounts watchers per sprite, so telling it twice is free, and telling it
 * about a sprite it is already watching is a no-op.
 *
 * Fire-and-forget on purpose: a missed trigger costs a preview until the next
 * ensure or shell open (realtime hooks its own shell path too), never a
 * failed provision. Dark unless the feature is configured — realtime would
 * refuse anyway, but the request is not even made (`postSignedDevPreviewCall`).
 */

import { loggers } from '@pagespace/lib/logging/logger-config';
import type { DevPreviewHolderRef } from '@pagespace/lib/services/sandbox/preview/dev-preview-core';
import { postSignedDevPreviewCall } from './realtime-call';

interface DevPreviewWatchRequest {
  /** Only the holder travels; realtime re-derives the sprite from the holder's row. */
  holder: DevPreviewHolderRef;
}

const WATCH_TIMEOUT_MS = 5_000;

export function requestDevPreviewWatch(input: DevPreviewWatchRequest, fetchImpl: typeof fetch = fetch): void {
  const call = postSignedDevPreviewCall('/api/dev-preview/watch', JSON.stringify(input), { timeoutMs: WATCH_TIMEOUT_MS, fetchImpl });
  if (call === null) return;
  call.catch((error: unknown) => {
    loggers.realtime.warn('dev-preview: watch trigger failed', {
      holderKind: input.holder.kind,
      holderId: input.holder.id,
      error: error instanceof Error ? error.message : String(error),
    });
  });
}
