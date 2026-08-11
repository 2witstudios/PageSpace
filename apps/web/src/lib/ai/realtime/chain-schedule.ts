/**
 * When to chain a live call into a fresh one.
 *
 * A realtime call has a hard server-enforced ceiling (`REALTIME_MAX_SESSION_SECONDS`,
 * plus the socket's own hour) after which the realtime server hangs it up. That
 * ceiling exists to bound a call nobody ended; it is not a limit on how long a
 * CONVERSATION may last, and the two must not be confused. So shortly before it
 * lands, the client mints a NEW call bound to the same conversation, which the
 * server reseeds from that conversation's thread — the transcript is the durable
 * layer, so the new session picks up knowing what was already said. The
 * conversation id never changes; only the transport underneath it does.
 *
 * The ceiling is server-owned and env-tunable, which is why it is READ FROM THE
 * HANDSHAKE RESPONSE rather than restated here. A client-side copy of a server
 * env var is a copy that drifts, and the failure mode of drift is a user cut off
 * mid-sentence on the one deployment that tuned it.
 *
 * Pure: no I/O, no clock, no randomness, no module-level mutable state. The
 * caller owns the timer; this module only says how long it should be.
 */

/**
 * Headroom before the cap. It covers a whole handshake — mint, relay to OpenAI,
 * the internal attach — whose own upstream timeout is 15s, plus the moment of
 * swapping which stream feeds the speaker.
 */
export const CHAIN_LEAD_MS = 20_000;

/**
 * A floor on how often calls may be churned. Below this, chaining costs more
 * than it buys: every chain is two concurrent calls, a fresh seed replay, and a
 * new hold against the credit gate.
 */
export const MIN_CHAIN_DELAY_MS = 30_000;

/**
 * How long after connecting to start the next call, or `undefined` for "do not
 * chain this one".
 *
 * `undefined` is returned for a cap that is absent, nonsensical, or too short to
 * get ahead of. That last case is deliberate: when the ceiling is tighter than
 * the headroom a handshake needs, the honest outcome is to let the call end at
 * its cap and report it, not to spend the entire session handing off.
 */
export const chainDelayMs = (
  maxDurationMs: number | undefined,
  leadMs: number = CHAIN_LEAD_MS,
  minDelayMs: number = MIN_CHAIN_DELAY_MS,
): number | undefined => {
  if (maxDurationMs === undefined) return undefined;
  if (!Number.isFinite(maxDurationMs) || maxDurationMs <= 0) return undefined;

  const delay = maxDurationMs - leadMs;
  return delay >= minDelayMs ? delay : undefined;
};
