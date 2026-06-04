import { NextResponse } from 'next/server';
import { incrementUsage } from './usage-service';
import { getTomorrowMidnightUTC } from '@pagespace/lib/services/date-utils';
import { isBillingEnabled } from '@pagespace/lib/deployment-mode';
import type { ProviderType } from '@pagespace/lib/services/rate-limit-cache';
import { getProviderTier, isModelAllowedForTier } from '@/lib/ai/core/ai-providers-config';

/** Subscription tiers that have access to paid features (voice mode, etc.). */
export const PAID_TIERS = new Set(['pro', 'founder', 'business']);

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  limit: number;
  subscriptionTier: string;
}

/**
 * Check and enforce rate limits for AI provider calls
 */
export async function checkAIRateLimit(
  userId: string,
  provider: string,
  model?: string
): Promise<RateLimitResult> {
  const providerType: ProviderType = getProviderTier(provider, model);

  try {
    const result = await incrementUsage(userId, providerType);

    if (!result.success) {
      return {
        allowed: false,
        remaining: result.remainingCalls,
        limit: result.limit,
        subscriptionTier: 'unknown', // Will be filled by caller if needed
      };
    }

    return {
      allowed: true,
      remaining: result.remainingCalls,
      limit: result.limit,
      subscriptionTier: 'unknown', // Will be filled by caller if needed
    };

  } catch (error) {
    console.error('Rate limit check failed:', error);
    // On error, deny the request
    return {
      allowed: false,
      remaining: 0,
      limit: 0,
      subscriptionTier: 'unknown',
    };
  }
}

/**
 * Create rate limit error response
 */
export function createRateLimitResponse(
  providerType: ProviderType,
  limit: number,
  resetTime?: Date
): NextResponse {
  const resetTimeString = resetTime || new Date(getTomorrowMidnightUTC());

  const errorMessage = providerType === 'pro'
    ? `Pro AI calls limited to ${limit} per day. Upgrade to Pro or Business for more access.`
    : `Standard AI calls limited to ${limit} per day. Upgrade to Pro (200/day) or Business (1000/day) for more calls.`;

  return NextResponse.json(
    {
      error: 'Rate limit exceeded',
      message: errorMessage,
      limit,
      resetTime: resetTimeString,
      upgradeUrl: '/settings/billing',
    },
    {
      status: 429,
      headers: {
        'X-RateLimit-Limit': limit.toString(),
        'X-RateLimit-Remaining': '0',
        'X-RateLimit-Reset': Math.floor(resetTimeString.getTime() / 1000).toString(),
        'Retry-After': Math.floor((resetTimeString.getTime() - Date.now()) / 1000).toString(),
      },
    }
  );
}

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
      upgradeUrl: '/settings/billing',
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