/**
 * Timeouts for a granted request, resolved purely.
 *
 * The desktop MCP bridge's request correlator defaults to 30 s, which is fine
 * for a tool lookup and fatal for the bridge: agent commands routinely run for
 * minutes, and a PTY is open for as long as the terminal is. This resolver is
 * the single place those numbers come from, so the correlator can never fall
 * back to a fixed default for an exec or a PTY:
 *
 * - `exec` / `fs_*`: the command's own timeout (or the documented default when
 *   absent or bogus — never 0/NaN, which `child_process` treats as disabled),
 *   and a correlator deadline of that plus a margin for transport.
 * - `pty_open`: the OPEN handshake is bounded, but the channel it opens is
 *   `unbounded` — its liveness is the heartbeat's job, not a deadline's.
 */
import type { GrantOp } from './grant';

export interface TimeoutDefaults {
  /** Exec/fs timeout when the request carries none (or a bogus one). */
  readonly execTimeoutMs: number;
  /** Transport slack added on top of the exec timeout for the correlator. */
  readonly correlatorMarginMs: number;
  /** Bound on the pty_open handshake itself; the channel is unbounded. */
  readonly ptyOpenHandshakeMs: number;
}

export const DEFAULT_TIMEOUT_DEFAULTS: TimeoutDefaults = {
  execTimeoutMs: 120_000,
  correlatorMarginMs: 5_000,
  ptyOpenHandshakeMs: 30_000,
};

export interface TimeoutRequest {
  readonly op: GrantOp;
  readonly timeoutMs?: number;
}

export interface ResolvedTimeouts {
  readonly execTimeoutMs: number;
  readonly correlatorTimeoutMs: number | 'unbounded';
}

const isPositiveInt = (value: unknown): value is number => typeof value === 'number' && Number.isInteger(value) && value > 0;

/** @returns the exec deadline and the correlator deadline (`'unbounded'` for a PTY channel). */
export function resolveTimeout(request: TimeoutRequest, defaults: TimeoutDefaults = DEFAULT_TIMEOUT_DEFAULTS): ResolvedTimeouts {
  if (request.op === 'pty_open') return { execTimeoutMs: defaults.ptyOpenHandshakeMs, correlatorTimeoutMs: 'unbounded' };
  const execTimeoutMs = isPositiveInt(request.timeoutMs) ? request.timeoutMs : defaults.execTimeoutMs;
  return { execTimeoutMs, correlatorTimeoutMs: execTimeoutMs + defaults.correlatorMarginMs };
}
