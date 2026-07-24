/**
 * THE canonical subscription-tier vocabulary and plan-limits table.
 *
 * Every tier union, validator, ordering, and plan-limit number in the monorepo
 * derives from this module — apps/web plans + routes, apps/admin tier types,
 * apps/marketing pricing copy, apps/control-plane tenant validation, apps/e2e
 * seeding, and the lib storage/billing enforcement paths. Do NOT re-declare
 * `'free' | 'pro' | 'founder' | 'business'` (or any limit number below)
 * anywhere else; import from here instead.
 *
 * Deliberately dependency-free and side-effect-free so it is safe in client
 * bundles (plan cards, the marketing site) and in services with their own
 * deploys (control-plane, admin).
 */

/** Canonical tier vocabulary, in ascending plan order (lowest → highest). */
export const TIERS = ['free', 'pro', 'founder', 'business'] as const;

export type SubscriptionTier = (typeof TIERS)[number];

/**
 * Upgrade/downgrade ordering. Identical to TIERS — the vocabulary is declared
 * in rank order — exported under the name the plan UIs historically used.
 */
export const PLAN_ORDER: readonly SubscriptionTier[] = TIERS;

export function isSubscriptionTier(value: unknown): value is SubscriptionTier {
  return typeof value === 'string' && (TIERS as readonly string[]).includes(value);
}

/**
 * Coerce an untrusted/stored value (e.g. the untyped users.subscriptionTier
 * text column) to a member of the vocabulary, falling back to 'free'.
 */
export function toSubscriptionTier(value: string | null | undefined): SubscriptionTier {
  return isSubscriptionTier(value) ? value : 'free';
}

/** Position of a tier in PLAN_ORDER — higher rank = higher plan. */
export function tierRank(tier: SubscriptionTier): number {
  return PLAN_ORDER.indexOf(tier);
}

/**
 * Compile-time exhaustiveness guard: `default: assertNeverTier(tier)` in a
 * switch over SubscriptionTier fails `tsc` the moment TIERS gains a member the
 * switch doesn't handle (e.g. at the web→control-plane provisioning bridge).
 */
export function assertNeverTier(tier: never): never {
  throw new Error(`Unhandled subscription tier: ${String(tier)}`);
}

const MB = 1024 * 1024;
const GB = 1024 * MB;

export interface TierPlanLimits {
  /** Display name ("Free", "Pro", …). */
  name: string;
  /** Monthly list price in whole USD. Display only — Stripe prices are authoritative for billing. */
  priceMonthlyUsd: number;
  /** Total storage quota in bytes. */
  quotaBytes: number;
  /** Per-file upload ceiling in bytes. */
  maxFileSize: number;
  /** Concurrent upload slots. */
  maxConcurrentUploads: number;
  /** Total stored-file count ceiling (0 = unlimited). */
  maxFileCount: number;
  /** Custom domains per drive (0 = feature unavailable). */
  maxCustomDomains: number;
  /** Whether the user may pick a custom published-site subdomain. */
  canChooseSubdomain: boolean;
  /** Whether the tier can use premium "Pro" AI models. */
  proModels: boolean;
}

/**
 * The ONE plan-limits table. Enforcement (storage quota, upload validation,
 * custom domains), in-app plan copy, and the marketing pricing page all derive
 * from these rows — previously three hand-synced copies that had already
 * diverged once (see the reconciliation note that used to live on
 * STORAGE_TIERS: "limits reflect the higher of the previously-divergent
 * tables").
 */
export const TIER_PLAN_LIMITS: Record<SubscriptionTier, TierPlanLimits> = {
  free: {
    name: 'Free',
    priceMonthlyUsd: 0,
    quotaBytes: 500 * MB,
    maxFileSize: 50 * MB,
    maxConcurrentUploads: 3,
    maxFileCount: 100,
    maxCustomDomains: 0,
    canChooseSubdomain: false,
    proModels: false,
  },
  pro: {
    name: 'Pro',
    priceMonthlyUsd: 15,
    quotaBytes: 2 * GB,
    maxFileSize: 250 * MB,
    maxConcurrentUploads: 5,
    maxFileCount: 500,
    maxCustomDomains: 1,
    canChooseSubdomain: true,
    proModels: true,
  },
  founder: {
    name: 'Founder',
    priceMonthlyUsd: 50,
    quotaBytes: 10 * GB,
    maxFileSize: 500 * MB,
    maxConcurrentUploads: 5,
    maxFileCount: 500,
    maxCustomDomains: 3,
    canChooseSubdomain: true,
    proModels: true,
  },
  business: {
    name: 'Business',
    priceMonthlyUsd: 100,
    quotaBytes: 50 * GB,
    maxFileSize: 1 * GB,
    maxConcurrentUploads: 10,
    maxFileCount: 5000,
    maxCustomDomains: 10,
    canChooseSubdomain: true,
    proModels: true,
  },
};

/**
 * Format a tier limit byte value the way plan copy displays it ("500MB",
 * "2GB", "1.5GB"). `separator` inserts a space for marketing style ("500 MB").
 * Values ≥ 1GB render in GB, below that in MB — matching every existing plan
 * surface. Not a general byte formatter; see formatBytes in storage-limits for
 * arbitrary usage numbers.
 */
export function formatTierBytes(bytes: number, separator = ''): string {
  const inGb = bytes / GB;
  const value = inGb >= 1 ? inGb : bytes / MB;
  const unit = inGb >= 1 ? 'GB' : 'MB';
  const rounded = Math.round(value * 100) / 100;
  return `${rounded}${separator}${unit}`;
}
