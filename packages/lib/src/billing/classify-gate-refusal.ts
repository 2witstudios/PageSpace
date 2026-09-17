/**
 * classifyGateRefusal — does a credit-gate denial clear on its own?
 *
 * `transient`: the same call can succeed later without anyone acting — a
 * concurrent call finishes (too_many_in_flight) or the UTC day rolls over
 * (daily_cap_exceeded). A scheduled run retries it on the next tick.
 * `terminal`: nothing changes until a human acts — add credits
 * (out_of_credits), claim the agent (requires_funding), or the account itself
 * is unusable (needs_init, which a missing users row maps to). A scheduled run
 * records it once, visibly.
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
    case 'daily_cap_exceeded':
      return 'transient';
    case 'out_of_credits':
    case 'requires_funding':
    case 'needs_init':
      return 'terminal';
  }
}
