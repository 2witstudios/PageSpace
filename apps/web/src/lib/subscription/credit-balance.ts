/**
 * credit-balance — read-only view of a user's prepaid AI-credit balance for the
 * dashboard widget and the `GET /api/credits` endpoint, plus the live-update emitter.
 *
 * This is the DISPLAY layer; it never mutates. The authoritative spend decision and
 * the monthly reset live in `@pagespace/lib/billing/credit-gate` (the imperative
 * shell that owns the clock and the row lock). Here we only mirror the gate's
 * semantics for presentation:
 *   - free tier whose monthly window has lapsed is shown its full allowance (the gate
 *     will reset it on the next call) rather than a stale, pessimistic remainder;
 *   - paid tier whose window has lapsed is shown 0 monthly (use-it-or-lose-it — the
 *     gate excludes the expired allowance until the renewal invoice refills it);
 *   - spendable nets out the sum of the user's still-active holds (reservations on
 *     calls currently in flight), clamped at 0.
 *
 * Money is always whole cents of customer-facing credit value, matching credit-core.
 */

import { db } from '@pagespace/db/db';
import { creditBalances, creditHolds } from '@pagespace/db/schema/credits';
import { users } from '@pagespace/db/schema/auth';
import { and, eq, gt, sql } from '@pagespace/db/operators';
import { isBillingEnabled } from '@pagespace/lib/deployment-mode';
import { TIER_MONTHLY_ALLOWANCE_CENTS } from '@pagespace/lib/billing/credit-pricing';
import type { SubscriptionTier } from '@pagespace/lib/services/subscription-utils';
import { broadcastCreditsEvent } from '@/lib/websocket/socket-utils';
import { loggers } from '@pagespace/lib/logging/logger-config';

export interface CreditBalanceSummary {
  /** false on billing-disabled deployments (tenant/onprem); the widget then hides. */
  billingEnabled: boolean;
  monthly: {
    remaining: number;
    allowance: number;
    /** ISO string of the current period end, or null if never stamped. */
    periodEnd: string | null;
  };
  topup: {
    remaining: number;
  };
  /** monthly + topup remaining, minus active holds, clamped to >= 0. */
  spendable: number;
  /** Sum of this user's non-expired holds (estimated spend on in-flight calls). */
  reserved: number;
}

function allowanceFor(tier: SubscriptionTier): number {
  return TIER_MONTHLY_ALLOWANCE_CENTS[tier] ?? TIER_MONTHLY_ALLOWANCE_CENTS.free;
}

/** The unlimited/hidden summary used when prepaid billing is disabled. */
function disabledSummary(): CreditBalanceSummary {
  return {
    billingEnabled: false,
    monthly: { remaining: 0, allowance: 0, periodEnd: null },
    topup: { remaining: 0 },
    spendable: 0,
    reserved: 0,
  };
}

/**
 * Read a user's current prepaid credit balance for display. Pure read: no lazy-init,
 * no reset — those are owned by the gate. A user with no balance row yet is shown the
 * tier's monthly allowance (what the gate will lazy-init on their first call).
 */
export async function getCreditBalance(
  userId: string,
  tier: SubscriptionTier = 'free',
): Promise<CreditBalanceSummary> {
  if (!isBillingEnabled()) return disabledSummary();

  const now = new Date();

  const [rows, holdAgg] = await Promise.all([
    db
      .select({
        monthlyRemainingCents: creditBalances.monthlyRemainingCents,
        monthlyAllowanceCents: creditBalances.monthlyAllowanceCents,
        topupRemainingCents: creditBalances.topupRemainingCents,
        monthlyPeriodEnd: creditBalances.monthlyPeriodEnd,
      })
      .from(creditBalances)
      .where(eq(creditBalances.userId, userId))
      .limit(1),
    db
      .select({ reserved: sql<number>`coalesce(sum(${creditHolds.estCents}), 0)` })
      .from(creditHolds)
      .where(and(eq(creditHolds.userId, userId), gt(creditHolds.expiresAt, now))),
  ]);

  const reserved = Number(holdAgg[0]?.reserved ?? 0);
  const row = rows[0] ?? null;

  // No row yet: the gate will lazy-init from the tier allowance on the first call,
  // so present that as the spendable monthly balance.
  if (!row) {
    const allowance = allowanceFor(tier);
    const spendable = Math.max(0, allowance - reserved);
    return {
      billingEnabled: true,
      monthly: { remaining: allowance, allowance, periodEnd: null },
      topup: { remaining: 0 },
      spendable,
      reserved,
    };
  }

  const allowance = row.monthlyAllowanceCents || allowanceFor(tier);
  const periodEnd = row.monthlyPeriodEnd;
  const expired = periodEnd === null || periodEnd < now;

  // Mirror the gate's window semantics for display (see file header).
  let monthlyRemaining: number;
  if (tier === 'free' && expired) {
    monthlyRemaining = allowance; // gate resets free tiers on next call
  } else if (tier !== 'free' && expired && periodEnd !== null) {
    monthlyRemaining = 0; // paid use-it-or-lose-it: expired allowance is forfeit
  } else {
    monthlyRemaining = row.monthlyRemainingCents;
  }

  const topupRemaining = row.topupRemainingCents;
  const spendable = Math.max(0, monthlyRemaining + topupRemaining - reserved);

  return {
    billingEnabled: true,
    monthly: {
      remaining: monthlyRemaining,
      allowance,
      periodEnd: periodEnd ? periodEnd.toISOString() : null,
    },
    topup: { remaining: topupRemaining },
    spendable,
    reserved,
  };
}

/** The user's stored subscription tier, defaulting to free if unknown. */
async function resolveTier(userId: string): Promise<SubscriptionTier> {
  const rows = await db
    .select({ subscriptionTier: users.subscriptionTier })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  return (rows[0]?.subscriptionTier as SubscriptionTier) ?? 'free';
}

export interface EmitCreditsOptions {
  /** Pre-resolved tier to avoid an extra users lookup when the caller already has it. */
  tier?: SubscriptionTier;
  /** Optional scoping hints so the per-conversation usage monitor refreshes the right view. */
  conversationId?: string;
  pageId?: string;
}

/**
 * Recompute the user's balance and push it to their notifications channel as a
 * `credits:updated` event. Best-effort and never throws — called from AI-stream
 * onFinish handlers and the Stripe webhook, where a failed broadcast must not break
 * the request. A no-op when billing is disabled.
 */
export async function emitCreditsUpdated(
  userId: string,
  opts: EmitCreditsOptions = {},
): Promise<void> {
  if (!isBillingEnabled()) return;
  try {
    const tier = opts.tier ?? (await resolveTier(userId));
    const summary = await getCreditBalance(userId, tier);
    await broadcastCreditsEvent({
      userId,
      operation: 'updated',
      billingEnabled: summary.billingEnabled,
      monthly: summary.monthly,
      topup: summary.topup,
      spendable: summary.spendable,
      reserved: summary.reserved,
      ...(opts.conversationId ? { conversationId: opts.conversationId } : {}),
      ...(opts.pageId ? { pageId: opts.pageId } : {}),
    });
  } catch (error) {
    // Best-effort: a failed balance read/broadcast must never turn into an unhandled
    // rejection on the fire-and-forget call path. Log defensively so a partial logger
    // (e.g. in a unit-test mock) can't escalate a swallowed error.
    loggers?.api?.debug?.('emitCreditsUpdated failed', {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
