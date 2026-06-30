/**
 * Outbound egress throttle decision (pure).
 *
 * With full egress, a hijacked sandbox could be used as an outbound abuse platform
 * (scanning, spam, DDoS participation, crypto mining, C2). Fly documents NO
 * automated outbound-abuse protection and a SHARED NAT egress IP, so an abusive
 * sandbox can blast-radius onto production IP reputation and trigger whole-account
 * AUP suspension. This is our own backstop: a sliding-window cap on outbound
 * bytes/connections per session.
 *
 * Pure and clock-free: the caller passes the current window's accumulated usage and
 * how far into the window it is (`elapsedMs`), so the decision is deterministic and
 * unit-testable. The IO — accounting usage and applying the throttle at the egress
 * boundary — lives in the runner shell.
 */

/** Accumulated outbound usage within the current window. */
export interface OutboundUsageWindow {
  bytes: number;
  connections: number;
  /** Total window length in ms. */
  windowMs: number;
  /** How far into the current window we are, in ms (clock passed in by the caller). */
  elapsedMs: number;
}

/** Per-window outbound ceilings. */
export interface OutboundThrottleLimits {
  maxBytesPerWindow: number;
  maxConnectionsPerWindow: number;
}

export type OutboundThrottleDecision =
  | { action: 'allow' }
  | { action: 'throttle'; retryAfterMs: number };

/**
 * Decide whether outbound traffic for a session should proceed or be throttled.
 * EXCEEDING either ceiling (strictly greater than) throttles until the window
 * resets; usage at-or-under both ceilings is allowed. `retryAfterMs` is the time
 * remaining in the current window, clamped to ≥ 0.
 */
// A finite, non-negative number. NaN/Infinity/negative accounting input is treated
// as malformed and forces a fail-closed throttle (this is an abuse backstop, so an
// invalid counter must never silently read as under-limit).
function isValidCounter(n: number): boolean {
  return Number.isFinite(n) && n >= 0;
}

export function outboundThrottleDecision({
  usage,
  limits,
}: {
  usage: OutboundUsageWindow;
  limits: OutboundThrottleLimits;
}): OutboundThrottleDecision {
  // Fail closed on malformed accounting: any NaN/Infinity/negative usage counter
  // throttles, with a safe (finite, non-negative) retry hint derived only from
  // valid window/elapsed values.
  const countersValid =
    isValidCounter(usage.bytes) &&
    isValidCounter(usage.connections) &&
    isValidCounter(usage.windowMs) &&
    isValidCounter(usage.elapsedMs) &&
    // The limits are operator config, but a malformed limit (e.g. NaN) would make
    // `usage > limit` read false → silent allow, defeating the backstop. Validate
    // them too: an invalid limit fail-closes to throttle.
    isValidCounter(limits.maxBytesPerWindow) &&
    isValidCounter(limits.maxConnectionsPerWindow);

  const safeRetryAfterMs = (): number => {
    if (!isValidCounter(usage.windowMs) || !isValidCounter(usage.elapsedMs)) return 0;
    return Math.max(0, usage.windowMs - usage.elapsedMs);
  };

  if (!countersValid) {
    return { action: 'throttle', retryAfterMs: safeRetryAfterMs() };
  }

  const over =
    usage.bytes > limits.maxBytesPerWindow ||
    usage.connections > limits.maxConnectionsPerWindow;

  if (!over) return { action: 'allow' };

  return { action: 'throttle', retryAfterMs: safeRetryAfterMs() };
}
