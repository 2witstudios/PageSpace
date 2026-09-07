/**
 * Ask the realtime tier for the listener snapshot it already holds for a
 * holder's sprite — the ONLY listener source a status render may use.
 *
 * Detection runs on `WSS …/ports/watch`, a socket only the realtime process
 * holds, so the web tier can never see a sprite's bound ports without asking
 * it — and it must not ask the SPRITE instead (an exec probe wakes a paused
 * sprite, and a wake is billed: the never-probe-to-render rule). The call is
 * the shared signed envelope (`postSignedDevPreviewCall`), carries only the
 * holder (realtime re-derives the sprite from the holder's own row), is
 * bounded by a short timeout, and answers `null` for every failure: no
 * snapshot, realtime down, feature dark, `INTERNAL_REALTIME_URL` unset.
 * `null` renders as "slot unknown, last-known state" — never as "free" and
 * never as an error the user has to see. The answer is parsed with the same
 * reader the watch channel itself uses (`readPortsWatchFrame`), so "a valid
 * listener" means one thing on both tiers.
 */

import { loggers } from '@pagespace/lib/logging/logger-config';
import type { DevPreviewHolderRef, ListeningPort } from '@pagespace/lib/services/sandbox/preview/dev-preview-core';
import { readPortsWatchFrame } from '@pagespace/lib/services/sandbox/preview/ports-watch';
import { postSignedDevPreviewCall } from './realtime-call';

/** A status render must stay cheap: a slow realtime answer is a null answer. */
const LISTENERS_TIMEOUT_MS = 2_500;

export async function readDevPreviewListeners(holder: DevPreviewHolderRef, fetchImpl: typeof fetch = fetch): Promise<ListeningPort[] | null> {
  const call = postSignedDevPreviewCall('/api/dev-preview/listeners', JSON.stringify({ holder }), { timeoutMs: LISTENERS_TIMEOUT_MS, fetchImpl });
  if (call === null) return null;
  try {
    const response = await call;
    if (!response.ok) return null;
    const parsed: unknown = await response.json();
    const listeners = (parsed as { listeners?: unknown } | null)?.listeners;
    if (!Array.isArray(listeners)) return null;
    const frame = readPortsWatchFrame({ type: 'port_list', ports: listeners });
    return frame?.type === 'port_list' ? frame.ports : null;
  } catch (error) {
    loggers.realtime.warn('dev-preview: listeners read failed', {
      holderKind: holder.kind,
      holderId: holder.id,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}
