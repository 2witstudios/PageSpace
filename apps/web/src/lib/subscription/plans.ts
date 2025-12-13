import { Crown, Zap, Shield, Star } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { stripeConfig } from '../stripe-config';

export type SubscriptionTier = 'free' | 'pro' | 'founder' | 'business';

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
    aiCalls: number;
    pro: number;
    storage: {
      bytes: number;
      formatted: string;
    };
    maxFileSize: {
      bytes: number;
      formatted: string;
    };
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

export const PLANS: Record<SubscriptionTier, PlanDefinition> = {
  free: {
    id: 'free',
    name: 'Free',
    displayName: 'Free Plan',
    price: {
      monthly: 0,
      currency: 'USD',
      formatted: 'Free',
    },
    icon: Zap,
    iconColor: 'text-blue-500',
    accentColor: 'border-zinc-200 bg-zinc-50/50 dark:border-zinc-800 dark:bg-zinc-900/50',
    description: 'Perfect for getting started with PageSpace',
    limits: {
      aiCalls: 50,
      pro: 0,
      storage: {
        bytes: 500 * 1024 * 1024, // 500MB
        formatted: '500MB',
      },
      maxFileSize: {
        bytes: 20 * 1024 * 1024, // 20MB
        formatted: '20MB',
      },
    },
    features: [
      { name: '50 AI calls per day', included: true },
      { name: '500MB storage', included: true },
      { name: '20MB max file size', included: true },
      { name: 'Basic processing', included: true },
      { name: 'Community support', included: true },
      { name: 'Pro AI calls', included: false },
      { name: 'Priority processing', included: false },
      { name: 'Advanced AI models', included: false },
      { name: 'Priority support', included: false },
      { name: 'Enterprise features', included: false },
    ],
  },
  pro: {
    id: 'pro',
    name: 'Pro',
    displayName: 'Pro Plan',
    price: {
      monthly: 15,
      currency: 'USD',
      formatted: '$15',
    },
    badge: {
      text: 'Most Popular',
      variant: 'default',
      className: 'bg-zinc-900 text-white border-zinc-900 dark:bg-zinc-100 dark:text-zinc-900 dark:border-zinc-100',
    },
    icon: Crown,
    iconColor: 'text-amber-500',
    accentColor: 'border-zinc-300 bg-zinc-100/80 dark:border-zinc-700 dark:bg-zinc-800/80',
    description: 'Best for professionals and growing teams',
    highlighted: true,
    stripePriceId: STRIPE_PRICE_ID_PRO,
    limits: {
      aiCalls: 200,
      pro: 50,
      storage: {
        bytes: 2 * 1024 * 1024 * 1024, // 2GB
        formatted: '2GB',
      },
      maxFileSize: {
        bytes: 50 * 1024 * 1024, // 50MB
        formatted: '50MB',
      },
    },
    features: [
      { name: '200 AI calls per day', included: true, description: '4x more than Free' },
      { name: '50 Pro AI calls', included: true, description: 'Advanced AI reasoning' },
      { name: '2GB storage', included: true, description: '4x more than Free' },
      { name: '50MB max file size', included: true, description: '2.5x larger files' },
      { name: 'Priority processing', included: true },
      { name: 'Advanced AI models', included: true },
      { name: 'Priority support', included: true },
      { name: 'Pro AI calls', included: true },
      { name: 'Community support', included: true },
      { name: 'Enterprise features', included: false },
    ],
  },
  founder: {
    id: 'founder',
    name: 'Founder',
    displayName: 'Founder Plan',
    price: {
      monthly: 50,
      currency: 'USD',
      formatted: '$50',
    },
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
    limits: {
      aiCalls: 500,
      pro: 100,
      storage: {
        bytes: 10 * 1024 * 1024 * 1024, // 10GB
        formatted: '10GB',
      },
      maxFileSize: {
        bytes: 50 * 1024 * 1024, // 50MB
        formatted: '50MB',
      },
    },
    features: [
      { name: '500 AI calls per day', included: true, description: '10x more than Free' },
      { name: '100 Pro AI calls', included: true, description: 'Advanced AI reasoning' },
      { name: '10GB storage', included: true, description: '20x more than Free' },
      { name: '50MB max file size', included: true, description: '2.5x larger files' },
      { name: 'Priority processing', included: true },
      { name: 'Advanced AI models', included: true },
      { name: 'Priority support', included: true },
      { name: 'Pro AI calls', included: true },
      { name: 'Community support', included: true },
      { name: 'Enterprise features', included: false },
    ],
  },
  business: {
    id: 'business',
    name: 'Business',
    displayName: 'Business Plan',
    price: {
      monthly: 100,
      currency: 'USD',
      formatted: '$100',
    },
    icon: Shield,
    iconColor: 'text-violet-500',
    accentColor: 'border-zinc-200 bg-zinc-50/50 dark:border-zinc-800 dark:bg-zinc-900/50',
    description: 'Enterprise-grade features for large teams',
    stripePriceId: STRIPE_PRICE_ID_BUSINESS,
    limits: {
      aiCalls: 1000,
      pro: 500,
      storage: {
        bytes: 50 * 1024 * 1024 * 1024, // 50GB
        formatted: '50GB',
      },
      maxFileSize: {
        bytes: 100 * 1024 * 1024, // 100MB
        formatted: '100MB',
      },
    },
    features: [
      { name: '1000 AI calls per day', included: true, description: '20x more than Free' },
      { name: '500 Pro AI calls', included: true, description: 'Maximum AI reasoning' },
      { name: '50GB storage', included: true, description: '100x more than Free' },
      { name: '100MB max file size', included: true, description: '5x larger files' },
      { name: 'Enterprise processing', included: true },
      { name: 'Advanced AI models', included: true },
      { name: 'Priority support', included: true },
      { name: 'Enterprise features', included: true },
      { name: 'Pro AI calls', included: true },
      { name: 'Community support', included: true },
    ],
  },
};

export const PLAN_ORDER: SubscriptionTier[] = ['free', 'pro', 'founder', 'business'];

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