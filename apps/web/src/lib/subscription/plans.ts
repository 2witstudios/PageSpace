import { Crown, Zap, Shield } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import {
  TIERS as CANONICAL_PLAN_ORDER,
  TIER_PLAN_LIMITS,
  formatTierBytes,
  personalTiers,
  type SubscriptionTier,
} from '@pagespace/lib/billing/subscription-tiers';
import { stripeConfig } from '../stripe-config';
import {
  MONTHLY_CREDIT_CENTS,
  monthlyCreditsPhrase,
  monthlyCreditsPhraseForCents,
  includedCreditsPhrase,
  includedCreditsPhraseForCents,
  topUpRatePhrase,
} from './credits';

export type { SubscriptionTier };

export interface PlanFeature {
  name: string;
  included: boolean;
  description?: string;
}

export interface PlanDefinition {
  id: SubscriptionTier;
  name: string;
  displayName: string;
  price: {
    monthly: number;
    currency: string;
    formatted: string;
  };
  badge?: {
    text: string;
    variant: 'default' | 'secondary' | 'destructive' | 'outline';
    className?: string;
  };
  icon: LucideIcon;
  iconColor: string;
  accentColor: string;
  description: string;
  /**
   * MON-6: the three facts a plan card states separately — the price
   * (`price`), the included credits (an integer count, never a dollar figure)
   * and the top-up rate. Both strings come from ./credits, the one in-app
   * source for credit copy.
   */
  includedCredits: string;
  topUpRate: string;
  /**
   * SEAT-2: whether this is the organization plan. An org plan is not offered
   * to a lone user — see getPersonalPlans() — and states its seat terms.
   */
  isOrgPlan: boolean;
  includedSeats: number;
  extraSeatUsd: number;
  limits: {
    /**
     * Monthly included AI-credit allowance, in whole cents of customer-facing credit
     * value. Sourced from the canonical billing constants via `./credits`. Credits
     * are the sole AI volume limiter; users can buy more top-up credits anytime.
     */
    monthlyCreditsCents: number;
    /**
     * Whether this tier can use the premium "Pro" AI models. Free tiers are confined
     * to standard models (model-tier gating is kept); paid tiers get standard + Pro.
     */
    proModels: boolean;
    storage: {
      bytes: number;
      formatted: string;
    };
    maxFileSize: {
      bytes: number;
      formatted: string;
    };
    /**
     * Maximum custom domains per drive. 0 = custom domains not available on
     * this tier. The add-domain endpoint enforces this at request time.
     */
    maxCustomDomains: number;
    /**
     * Whether the user can choose a custom subdomain for their published
     * canvas site. Free users get the auto-allocated slug; Pro+ can change it.
     */
    canChooseSubdomain: boolean;
  };
  features: PlanFeature[];
  highlighted?: boolean;
  /** Stripe Price ID for embedded checkout subscription creation */
  stripePriceId?: string;
}

// Stripe Price IDs from hardcoded config (avoids Next.js build-time env var issues)
const STRIPE_PRICE_ID_PRO = stripeConfig.priceIds.pro;
const STRIPE_PRICE_ID_BUSINESS = stripeConfig.priceIds.business;

// Storage/file-size/price/domain numbers derive from the canonical
// TIER_PLAN_LIMITS table in @pagespace/lib/billing/subscription-tiers (a pure,
// client-safe module) — the same table the server enforces, so plan copy can
// never drift from enforcement.
function planPrice(tier: SubscriptionTier): PlanDefinition['price'] {
  const usd = TIER_PLAN_LIMITS[tier].priceMonthlyUsd;
  return { monthly: usd, currency: 'USD', formatted: usd === 0 ? 'Free' : `$${usd}` };
}

function planLimits(tier: SubscriptionTier): PlanDefinition['limits'] {
  const limits = TIER_PLAN_LIMITS[tier];
  return {
    monthlyCreditsCents: MONTHLY_CREDIT_CENTS[tier],
    proModels: limits.proModels,
    storage: { bytes: limits.quotaBytes, formatted: formatTierBytes(limits.quotaBytes) },
    maxFileSize: { bytes: limits.maxFileSize, formatted: formatTierBytes(limits.maxFileSize) },
    maxCustomDomains: limits.maxCustomDomains,
    canChooseSubdomain: limits.canChooseSubdomain,
  };
}

function planTerms(tier: SubscriptionTier): Pick<PlanDefinition, 'includedCredits' | 'topUpRate' | 'isOrgPlan' | 'includedSeats' | 'extraSeatUsd'> {
  const limits = TIER_PLAN_LIMITS[tier];
  return {
    includedCredits: includedCreditsPhrase(tier),
    topUpRate: topUpRatePhrase(),
    isOrgPlan: limits.isOrgPlan,
    includedSeats: limits.includedSeats,
    extraSeatUsd: limits.extraSeatUsd,
  };
}

const storagePhrase = (tier: SubscriptionTier) =>
  `${formatTierBytes(TIER_PLAN_LIMITS[tier].quotaBytes)} storage`;
const maxFilePhrase = (tier: SubscriptionTier) =>
  `${formatTierBytes(TIER_PLAN_LIMITS[tier].maxFileSize)} max file size`;

export const PLANS: Record<SubscriptionTier, PlanDefinition> = {
  free: {
    id: 'free',
    name: 'Free',
    displayName: 'Free Plan',
    price: planPrice('free'),
    icon: Zap,
    iconColor: 'text-blue-500',
    accentColor: 'border-border bg-card/50',
    description: 'Perfect for getting started with PageSpace',
    ...planTerms('free'),
    limits: planLimits('free'),
    features: [
      { name: monthlyCreditsPhrase('free'), included: true },
      { name: 'Buy more credits anytime', included: true },
      { name: 'Standard AI models', included: true },
      { name: storagePhrase('free'), included: true },
      { name: maxFilePhrase('free'), included: true },
      { name: 'Basic processing', included: true },
      { name: 'Community support', included: true },
      { name: 'Pro AI models', included: false },
      { name: 'Priority processing', included: false },
      { name: 'Priority support', included: false },
      { name: 'Enterprise features', included: false },
    ],
  },
  pro: {
    id: 'pro',
    name: 'Pro',
    displayName: 'Pro Plan',
    price: planPrice('pro'),
    badge: {
      text: 'Most Popular',
      variant: 'default',
      className: 'bg-zinc-900 text-white border-zinc-900 dark:bg-zinc-100 dark:text-zinc-900 dark:border-zinc-100',
    },
    icon: Crown,
    iconColor: 'text-amber-500',
    accentColor: 'border-border bg-muted/80',
    description: 'Best for professionals',
    highlighted: true,
    stripePriceId: STRIPE_PRICE_ID_PRO,
    ...planTerms('pro'),
    limits: planLimits('pro'),
    features: [
      { name: monthlyCreditsPhrase('pro'), included: true, description: '3x more than Free' },
      { name: 'Buy more credits anytime', included: true },
      { name: 'Standard + Pro AI models', included: true, description: 'Advanced AI reasoning' },
      { name: storagePhrase('pro'), included: true, description: '4x more than Free' },
      { name: maxFilePhrase('pro'), included: true, description: '5x larger files' },
      { name: 'Priority processing', included: true },
      { name: 'Priority support', included: true },
      { name: 'Community support', included: true },
      { name: 'Enterprise features', included: false },
    ],
  },
  business: {
    id: 'business',
    name: 'Business',
    displayName: 'Business Plan',
    price: planPrice('business'),
    icon: Shield,
    iconColor: 'text-violet-500',
    accentColor: 'border-border bg-card/50',
    description: 'For teams: an organization with seats, a shared credit pool, and org-owned drives',
    stripePriceId: STRIPE_PRICE_ID_BUSINESS,
    ...planTerms('business'),
    limits: planLimits('business'),
    features: [
      { name: monthlyCreditsPhrase('business'), included: true, description: '20x more than Free' },
      { name: 'Buy more credits anytime', included: true },
      { name: 'Standard + Pro AI models', included: true, description: 'Maximum AI reasoning' },
      { name: storagePhrase('business'), included: true, description: '100x more than Free' },
      { name: maxFilePhrase('business'), included: true, description: '20x larger files' },
      { name: 'Enterprise processing', included: true },
      { name: 'Priority support', included: true },
      { name: 'Enterprise features', included: true },
      { name: 'Community support', included: true },
    ],
  },
};

/**
 * MON-2: patch a plan's credit-derived fields with a server-supplied cents value.
 *
 * `PLANS` is a module-level constant built once, using this module's OWN evaluation
 * of the money model (`MONTHLY_CREDIT_CENTS`, computed via `MONEY_MODEL_V2_ACTIVE`).
 * D-OW-17 made that constant identical in every process, including a `'use client'`
 * browser bundle — `PLANS`'s own build-time number is now correct there too, not
 * just on the server. This function, and the `planCredits` fetch it patches from,
 * remain correct to keep: they are simply no longer load-bearing for a client/server
 * asymmetry that no longer exists (see money-model.ts's module doc comment for why
 * an env var, and then a client mirror of one, couldn't guarantee that on their own).
 *
 * This function patches a `PlanDefinition`'s credit-derived fields with a supplied
 * number — `includedCredits`, `limits.monthlyCreditsCents`, and the credit line
 * inside `features` — without touching anything else. The credit feature is matched
 * by its CURRENT text (`monthlyCreditsPhrase(plan.id)`, exactly how `PLANS` built it
 * above) rather than assumed to be at a fixed index, so reordering a tier's
 * `features` array can never silently patch the wrong line.
 */
export function withCreditsCents(plan: PlanDefinition, cents: number): PlanDefinition {
  const creditFeatureName = monthlyCreditsPhrase(plan.id);
  return {
    ...plan,
    includedCredits: includedCreditsPhraseForCents(plan.id, cents),
    limits: { ...plan.limits, monthlyCreditsCents: cents },
    features: plan.features.map((feature) =>
      feature.name === creditFeatureName ? { ...feature, name: monthlyCreditsPhraseForCents(plan.id, cents) } : feature,
    ),
  };
}

/**
 * Apply `withCreditsCents` across a list of plans wherever `creditsCentsByTier` has
 * an entry for that plan's tier; a plan with no entry is returned unchanged (the
 * module's own build-time number, shown only for the instant before the server
 * response with `planCredits` arrives).
 */
export function withCreditOverrides(
  plans: PlanDefinition[],
  creditsCentsByTier?: Partial<Record<SubscriptionTier, number>>,
): PlanDefinition[] {
  if (!creditsCentsByTier) return plans;
  return plans.map((plan) => {
    const cents = creditsCentsByTier[plan.id];
    return cents === undefined ? plan : withCreditsCents(plan, cents);
  });
}

export const PLAN_ORDER: readonly SubscriptionTier[] = CANONICAL_PLAN_ORDER;

export function getPlan(tier: SubscriptionTier): PlanDefinition {
  return PLANS[tier] || PLANS['free'];
}

export function getNextPlan(currentTier: SubscriptionTier): PlanDefinition | null {
  const currentIndex = PLAN_ORDER.indexOf(currentTier);
  const nextIndex = currentIndex + 1;

  if (nextIndex < PLAN_ORDER.length) {
    return PLANS[PLAN_ORDER[nextIndex]];
  }

  return null;
}

export function getPreviousPlan(currentTier: SubscriptionTier): PlanDefinition | null {
  const currentIndex = PLAN_ORDER.indexOf(currentTier);
  const previousIndex = currentIndex - 1;

  if (previousIndex >= 0) {
    return PLANS[PLAN_ORDER[previousIndex]];
  }

  return null;
}

export function canUpgrade(currentTier: SubscriptionTier): boolean {
  return getNextPlan(currentTier) !== null;
}

export function canDowngrade(currentTier: SubscriptionTier): boolean {
  return getPreviousPlan(currentTier) !== null;
}

export function getAllPlans(): PlanDefinition[] {
  return PLAN_ORDER.map(tier => PLANS[tier]);
}

/**
 * SEAT-2: the plans a LONE user may be offered — every non-org plan, plus the
 * user's current plan when it is the org plan (a grandfathered $100 personal
 * Business subscriber keeps seeing, and managing, their own plan).
 */
export function getPersonalPlans(currentTier?: SubscriptionTier): PlanDefinition[] {
  return personalTiers(currentTier).map(tier => PLANS[tier]);
}

export function getTierFromPriceId(priceId: string): SubscriptionTier | null {
  for (const tier of PLAN_ORDER) {
    if (PLANS[tier].stripePriceId === priceId) {
      return tier;
    }
  }
  return null;
}

export function getPlanFromPriceId(priceId: string): PlanDefinition | null {
  const tier = getTierFromPriceId(priceId);
  return tier ? PLANS[tier] : null;
}