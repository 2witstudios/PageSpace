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
 * never as an error the user has to see.
 *
 * The answer also carries whether realtime is WATCHING this holder at all.
 * Every failure path here reports `detection: 'unavailable'`, which is the
 * honest fact in each case: realtime could not be asked, so nothing is known
 * to be watching. That is a different statement from "no ports are bound",
 * and the UI is allowed to say so. The answer is parsed with the same
 * reader the watch channel itself uses (`readPortsWatchFrame`), so "a valid
 * listener" means one thing on both tiers.
 */

import { loggers } from '@pagespace/lib/logging/logger-config';
import type { DevPreviewHolderRef } from '@pagespace/lib/services/sandbox/preview/dev-preview-core';
import type { DevPreviewDetection, DevPreviewListenersRead } from '@pagespace/lib/services/sandbox/preview/dev-preview-status';
import { readPortsWatchFrame } from '@pagespace/lib/services/sandbox/preview/ports-watch';
import { postSignedDevPreviewCall } from './realtime-call';

/** A status render must stay cheap: a slow realtime answer is a null answer. */
const LISTENERS_TIMEOUT_MS = 2_500;

/** Nothing known, nothing watching — the answer for every failure path below. */
const UNKNOWN: DevPreviewListenersRead = { detection: 'unavailable', listeners: null };

/** Pure: narrow realtime's answer onto the union, treating anything unrecognised as unavailable. */
function readDetection(value: unknown): DevPreviewDetection {
  return value === 'watching' || value === 'arming' ? value : 'unavailable';
}

export async function readDevPreviewListeners(holder: DevPreviewHolderRef, fetchImpl: typeof fetch = fetch): Promise<DevPreviewListenersRead> {
  const call = postSignedDevPreviewCall('/api/dev-preview/listeners', JSON.stringify({ holder }), { timeoutMs: LISTENERS_TIMEOUT_MS, fetchImpl });
  if (call === null) return UNKNOWN;
  try {
    const response = await call;
    if (!response.ok) return UNKNOWN;
    const parsed = (await response.json()) as { listeners?: unknown; detection?: unknown } | null;
    const detection = readDetection(parsed?.detection);
    const listeners = parsed?.listeners;
    if (!Array.isArray(listeners)) return { detection, listeners: null };
    const frame = readPortsWatchFrame({ type: 'port_list', ports: listeners });
    return { detection, listeners: frame?.type === 'port_list' ? frame.ports : null };
  } catch (error) {
    loggers.realtime.warn('dev-preview: listeners read failed', {
      holderKind: holder.kind,
      holderId: holder.id,
      error: error instanceof Error ? error.message : String(error),
    });
    return UNKNOWN;
  }
}
