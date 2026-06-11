import { NextResponse } from 'next/server';
import { isBillingEnabled } from '@pagespace/lib/deployment-mode';
import { isModelAllowedForTier } from '@/lib/ai/core/ai-providers-config';

/** Subscription tiers that have access to paid features (voice mode, etc.). */
export const PAID_TIERS = new Set(['pro', 'founder', 'business']);

/**
 * Whether the user's subscription tier is barred from the requested model.
 * Free users are limited to the FREE_TIER_MODELS allowlist; every paid tier gets
 * the full catalog. Billing-disabled deployments (on-prem and tenant) and global
 * admins bypass the gate entirely.
 *
 * The `provider` arg is retained for signature stability with existing call sites;
 * gating is now purely model-based.
 */
export function requiresProSubscription(_provider: string, model: string | undefined, subscriptionTier: string | undefined, isAdmin = false): boolean {
  if (isAdmin) return false;
  if (!isBillingEnabled()) return false;
  return !isModelAllowedForTier(model, subscriptionTier);
}

/**
 * Create subscription required error response
 */
export function createSubscriptionRequiredResponse(): NextResponse {
  return NextResponse.json(
    {
      error: 'Subscription required',
      message: 'This model is available on paid plans. Upgrade to access the full model catalog.',
      upgradeUrl: '/settings/plan',
    },
    { status: 403 }
  );
}

/**
 * Create an admin-only provider rejection response.
 * Distinct from the subscription gate: the block is on role, not tier, so the
 * message must not imply an upgrade would help.
 */
export function createAdminRestrictedResponse(): NextResponse {
  return NextResponse.json(
    {
      error: 'Provider restricted',
      message: 'This provider is restricted to administrators.',
    },
    { status: 403 }
  );
}