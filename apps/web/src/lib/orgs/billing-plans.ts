export type OrgBillingTier = 'free' | 'pro' | 'business' | 'enterprise';

export interface OrgPlanDefinition {
  id: OrgBillingTier;
  name: string;
  pricePerSeat: number; // monthly USD
  description: string;
  limits: {
    maxMembers: number; // -1 for unlimited
    maxDrives: number;
    storagePerSeatBytes: number;
    aiCallsPerSeatPerDay: number;
  };
  features: string[];
}

export const ORG_PLANS: Record<OrgBillingTier, OrgPlanDefinition> = {
  free: {
    id: 'free',
    name: 'Free',
    pricePerSeat: 0,
    description: 'For small teams getting started',
    limits: {
      maxMembers: 3,
      maxDrives: 2,
      storagePerSeatBytes: 500 * 1024 * 1024, // 500MB
      aiCallsPerSeatPerDay: 50,
    },
    features: [
      'Up to 3 members',
      '500MB storage per seat',
      '50 AI calls per seat/day',
      'Basic collaboration',
    ],
  },
  pro: {
    id: 'pro',
    name: 'Pro',
    pricePerSeat: 14,
    description: 'For growing teams that need more',
    limits: {
      maxMembers: 25,
      maxDrives: 20,
      storagePerSeatBytes: 5 * 1024 * 1024 * 1024, // 5GB
      aiCallsPerSeatPerDay: 200,
    },
    features: [
      'Up to 25 members',
      '5GB storage per seat',
      '200 AI calls per seat/day',
      'Priority support',
      'Custom roles',
      'Domain restrictions',
    ],
  },
  business: {
    id: 'business',
    name: 'Business',
    pricePerSeat: 28,
    description: 'For teams that need advanced controls',
    limits: {
      maxMembers: 100,
      maxDrives: -1,
      storagePerSeatBytes: 20 * 1024 * 1024 * 1024, // 20GB
      aiCallsPerSeatPerDay: 500,
    },
    features: [
      'Up to 100 members',
      '20GB storage per seat',
      '500 AI calls per seat/day',
      'SSO & MFA enforcement',
      'Audit logs',
      'AI provider restrictions',
      'Advanced guardrails',
    ],
  },
  enterprise: {
    id: 'enterprise',
    name: 'Enterprise',
    pricePerSeat: 0, // custom pricing
    description: 'Custom solutions for large organizations',
    limits: {
      maxMembers: -1,
      maxDrives: -1,
      storagePerSeatBytes: 100 * 1024 * 1024 * 1024, // 100GB
      aiCallsPerSeatPerDay: -1,
    },
    features: [
      'Unlimited members',
      '100GB storage per seat',
      'Unlimited AI calls',
      'Dedicated support',
      'Custom integrations',
      'SLA guarantees',
      'On-prem deployment option',
    ],
  },
};

export const ORG_TIER_ORDER: OrgBillingTier[] = ['free', 'pro', 'business', 'enterprise'];

export function getOrgPlan(tier: OrgBillingTier): OrgPlanDefinition {
  return ORG_PLANS[tier] || ORG_PLANS['free'];
}

export function canAddMember(tier: OrgBillingTier, currentMembers: number): boolean {
  const plan = getOrgPlan(tier);
  if (plan.limits.maxMembers === -1) return true;
  return currentMembers < plan.limits.maxMembers;
}

export function getOrgStorageLimit(tier: OrgBillingTier, seatCount: number): number {
  const plan = getOrgPlan(tier);
  return plan.limits.storagePerSeatBytes * seatCount;
}
