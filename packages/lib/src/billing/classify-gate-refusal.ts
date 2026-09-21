/**
 * classifyGateRefusal — does a credit-gate denial clear on its own?
 *
 * `transient`: the same call can succeed seconds later without anyone acting —
 * a concurrent call finishes and frees its in-flight slot (too_many_in_flight).
 * A scheduled run retries it on the next tick.
 * `terminal`: it will not clear within the retry cadence — a human must add
 * credits (out_of_credits) or claim the agent (requires_funding), the account
 * itself is unusable (needs_init, which a missing users row maps to), or the
 * per-user daily cap is spent (daily_cap_exceeded), which holds until the UTC
 * day rolls. Retrying that every tick would keep a bulk burst (e.g. dozens of
 * completion triggers) at the head of the due batch, starving other users'
 * triggers for the rest of the day. A scheduled run records it once, visibly,
 * and its source settles (a recurring workflow advances to its next slot).
 *
 * Pure.
 *
 * @module @pagespace/lib/billing/classify-gate-refusal
 */

import type { GateReason } from './credit-core';

/** Every reason a gate can deny with; `ok` and `unlimited` are allow reasons. */
export type DeniedGateReason = Exclude<GateReason, 'ok' | 'unlimited'>;

export type GateRefusalKind = 'transient' | 'terminal';

export function classifyGateRefusal(reason: DeniedGateReason): GateRefusalKind {
  switch (reason) {
    case 'too_many_in_flight':
      return 'transient';
    case 'daily_cap_exceeded':
    case 'out_of_credits':
    case 'requires_funding':
    case 'needs_init':
      return 'terminal';
  }
}
