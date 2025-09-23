import { Crown, Zap, Shield } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';

export type SubscriptionTier = 'free' | 'pro' | 'business';

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
  stripePaymentLink?: string;
}

// Stripe Payment Links
const STRIPE_PRO_PAYMENT_LINK = 'https://buy.stripe.com/8x2fZjdczc7ffz0eF0eEo01';
const STRIPE_BUSINESS_PAYMENT_LINK = 'https://buy.stripe.com/dRm9AV1tRfjrcmOdAWeEo03';

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
    accentColor: 'border-blue-200 bg-blue-50 dark:border-blue-800 dark:bg-blue-950/20',
    description: 'Perfect for getting started with PageSpace',
    limits: {
      aiCalls: 20,
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
      { name: '20 AI calls per day', included: true },
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
      monthly: 29.99,
      currency: 'USD',
      formatted: '$29.99',
    },
    badge: {
      text: 'Most Popular',
      variant: 'default',
      className: 'bg-yellow-500 text-white border-yellow-500',
    },
    icon: Crown,
    iconColor: 'text-yellow-500',
    accentColor: 'border-yellow-200 bg-yellow-50 dark:border-yellow-800 dark:bg-yellow-950/20',
    description: 'Best for professionals and growing teams',
    highlighted: true,
    stripePaymentLink: STRIPE_PRO_PAYMENT_LINK,
    limits: {
      aiCalls: 100,
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
      { name: '100 AI calls per day', included: true, description: '5x more than Free' },
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
  business: {
    id: 'business',
    name: 'Business',
    displayName: 'Business Plan',
    price: {
      monthly: 199.99,
      currency: 'USD',
      formatted: '$199.99',
    },
    badge: {
      text: 'Best Value',
      variant: 'outline',
      className: 'bg-purple-500 text-white border-purple-500',
    },
    icon: Shield,
    iconColor: 'text-purple-500',
    accentColor: 'border-purple-200 bg-purple-50 dark:border-purple-800 dark:bg-purple-950/20',
    description: 'Enterprise-grade features for large teams',
    stripePaymentLink: STRIPE_BUSINESS_PAYMENT_LINK,
    limits: {
      aiCalls: 500,
      pro: 100,
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
      { name: '500 AI calls per day', included: true, description: '25x more than Free' },
      { name: '100 Pro AI calls', included: true, description: 'Maximum AI reasoning' },
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

export const PLAN_ORDER: SubscriptionTier[] = ['free', 'pro', 'business'];

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