import { Crown, Zap, Shield, Star } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import {
  PLAN_ORDER as CANONICAL_PLAN_ORDER,
  TIER_PLAN_LIMITS,
  formatTierBytes,
  type SubscriptionTier,
} from '@pagespace/lib/billing/subscription-tiers';
import { stripeConfig } from '../stripe-config';
import { MONTHLY_CREDIT_CENTS, monthlyCreditsPhrase } from './credits';

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
const STRIPE_PRICE_ID_FOUNDER = stripeConfig.priceIds.founder;
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
    accentColor: 'border-zinc-200 bg-zinc-50/50 dark:border-zinc-800 dark:bg-zinc-900/50',
    description: 'Perfect for getting started with PageSpace',
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
    accentColor: 'border-zinc-300 bg-zinc-100/80 dark:border-zinc-600 dark:bg-zinc-900/90',
    description: 'Best for professionals and growing teams',
    highlighted: true,
    stripePriceId: STRIPE_PRICE_ID_PRO,
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
  founder: {
    id: 'founder',
    name: 'Founder',
    displayName: 'Founder Plan',
    price: planPrice('founder'),
    badge: {
      text: 'Best Value',
      variant: 'outline',
      className: 'bg-zinc-700 text-white border-zinc-700 dark:bg-zinc-300 dark:text-zinc-900 dark:border-zinc-300',
    },
    icon: Star,
    iconColor: 'text-emerald-500',
    accentColor: 'border-zinc-200 bg-zinc-50/50 dark:border-zinc-800 dark:bg-zinc-900/50',
    description: 'For power users who want maximum value',
    stripePriceId: STRIPE_PRICE_ID_FOUNDER,
    limits: planLimits('founder'),
    features: [
      { name: monthlyCreditsPhrase('founder'), included: true, description: '10x more than Free' },
      { name: 'Buy more credits anytime', included: true },
      { name: 'Standard + Pro AI models', included: true, description: 'Advanced AI reasoning' },
      { name: storagePhrase('founder'), included: true, description: '20x more than Free' },
      { name: maxFilePhrase('founder'), included: true, description: '10x larger files' },
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
    accentColor: 'border-zinc-200 bg-zinc-50/50 dark:border-zinc-800 dark:bg-zinc-900/50',
    description: 'Enterprise-grade features for large teams',
    stripePriceId: STRIPE_PRICE_ID_BUSINESS,
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