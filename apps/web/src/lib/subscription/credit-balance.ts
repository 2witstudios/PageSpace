/**
 * Re-export shim. The prepaid credit-balance read model and the live `credits:updated`
 * emitter now live in @pagespace/lib/billing so the billing primitives (credit-consume,
 * credit-gate, credit-backfill) can recompute and broadcast a fresh balance at EVERY
 * mutation — not just the few AI routes that used to call the emitter by hand.
 *
 * Kept here so existing imports (`GET /api/credits`, the Stripe webhook) keep resolving
 * `@/lib/subscription/credit-balance`. New code should import from @pagespace/lib directly.
 */

export {
  getCreditBalance,
  resolveTier,
  type CreditBalanceSummary,
} from '@pagespace/lib/billing/credit-balance';

export {
  emitCreditsUpdated,
  type EmitCreditsOptions,
} from '@pagespace/lib/billing/credit-emit';
