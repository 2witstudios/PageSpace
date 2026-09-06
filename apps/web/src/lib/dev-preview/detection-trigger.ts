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
 * refuse anyway, but the request is not even made.
 */

import { createSignedBroadcastHeaders } from '@pagespace/lib/auth/broadcast-auth';
import { loggers } from '@pagespace/lib/logging/logger-config';
import { isDevPreviewConfigured } from '@pagespace/lib/services/sandbox/preview/dev-preview-env';
import type { DevPreviewHolderRef } from '@pagespace/lib/services/sandbox/preview/dev-preview-core';

const DEV_PREVIEW_WATCH_ROUTE = '/api/dev-preview/watch';

interface DevPreviewWatchRequest {
  /** Only the holder travels; realtime re-derives the sprite from the holder's row. */
  holder: DevPreviewHolderRef;
}

export function requestDevPreviewWatch(input: DevPreviewWatchRequest, fetchImpl: typeof fetch = fetch): void {
  if (!isDevPreviewConfigured()) return;
  const realtimeUrl = process.env.INTERNAL_REALTIME_URL;
  if (!realtimeUrl) return;
  const body = JSON.stringify(input);
  void fetchImpl(`${realtimeUrl}${DEV_PREVIEW_WATCH_ROUTE}`, {
    method: 'POST',
    headers: createSignedBroadcastHeaders(body),
    body,
    // A signed internal call never follows a redirect: the signature is for
    // THIS body at THIS URL, and a redirect would replay it elsewhere.
    redirect: 'error',
    signal: AbortSignal.timeout(5000),
  }).catch((error: unknown) => {
    loggers.realtime.warn('dev-preview: watch trigger failed', {
      holderKind: input.holder.kind,
      holderId: input.holder.id,
      error: error instanceof Error ? error.message : String(error),
    });
  });
}
