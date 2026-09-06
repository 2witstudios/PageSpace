/**
 * Ask the realtime tier for the listener snapshot it already holds for a
 * holder's sprite — the ONLY listener source a status render may use.
 *
 * Detection runs on `WSS …/ports/watch`, a socket only the realtime process
 * holds, so the web tier can never see a sprite's bound ports without asking
 * it — and it must not ask the SPRITE instead (an exec probe wakes a paused
 * sprite, and a wake is billed: the never-probe-to-render rule). This call is
 * signed like the watch trigger, carries only the holder (realtime re-derives
 * the sprite from the holder's own row), is bounded by a short timeout, and
 * answers `null` for every failure: no snapshot, realtime down, feature dark,
 * `INTERNAL_REALTIME_URL` unset. `null` renders as "slot unknown, last-known
 * state" — never as "free" and never as an error the user has to see.
 */

import { createSignedBroadcastHeaders } from '@pagespace/lib/auth/broadcast-auth';
import { loggers } from '@pagespace/lib/logging/logger-config';
import { isDevPreviewConfigured } from '@pagespace/lib/services/sandbox/preview/dev-preview-env';
import type { DevPreviewHolderRef, ListeningPort } from '@pagespace/lib/services/sandbox/preview/dev-preview-core';

const DEV_PREVIEW_LISTENERS_ROUTE = '/api/dev-preview/listeners';
/** A status render must stay cheap: a slow realtime answer is a null answer. */
const LISTENERS_TIMEOUT_MS = 2_500;

function isListeningPort(value: unknown): value is ListeningPort {
  if (typeof value !== 'object' || value === null) return false;
  const { port, pid } = value as { port?: unknown; pid?: unknown };
  return Number.isInteger(port) && (pid === undefined || Number.isInteger(pid));
}

export async function readDevPreviewListeners(holder: DevPreviewHolderRef, fetchImpl: typeof fetch = fetch): Promise<ListeningPort[] | null> {
  if (!isDevPreviewConfigured()) return null;
  const realtimeUrl = process.env.INTERNAL_REALTIME_URL;
  if (!realtimeUrl) return null;
  const body = JSON.stringify({ holder });
  try {
    const response = await fetchImpl(`${realtimeUrl}${DEV_PREVIEW_LISTENERS_ROUTE}`, {
      method: 'POST',
      headers: createSignedBroadcastHeaders(body),
      body,
      // A signed internal call never follows a redirect (same as the watch trigger).
      redirect: 'error',
      signal: AbortSignal.timeout(LISTENERS_TIMEOUT_MS),
    });
    if (!response.ok) return null;
    const parsed: unknown = await response.json();
    const listeners = (parsed as { listeners?: unknown } | null)?.listeners;
    if (!Array.isArray(listeners)) return null;
    return listeners.filter(isListeningPort).map(({ port, pid }) => ({ port, ...(pid !== undefined ? { pid } : {}) }));
  } catch (error) {
    loggers.realtime.warn('dev-preview: listeners read failed', {
      holderKind: holder.kind,
      holderId: holder.id,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}
