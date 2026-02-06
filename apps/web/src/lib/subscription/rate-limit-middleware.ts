import { NextResponse } from 'next/server';
import { getTomorrowMidnightUTC, type ProviderType } from '@pagespace/lib';

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  limit: number;
  subscriptionTier: string;
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
    : `Standard AI calls limited to ${limit} per day. Upgrade to Pro (100/day) or Business (500/day) for more calls.`;

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
 * Check if provider requires Pro subscription
 */
export function requiresProSubscription(provider: string, model: string | undefined, subscriptionTier: string | undefined): boolean {
  const isProModel = provider === 'pagespace' && model === 'glm-4.7';
  if (!isProModel) {
    return false;
  }

  // Allow access for 'pro' and 'business' tiers
  return subscriptionTier !== 'pro' && subscriptionTier !== 'business';
}

/**
 * Create subscription required error response
 */
export function createSubscriptionRequiredResponse(): NextResponse {
  return NextResponse.json(
    {
      error: 'Subscription required',
      message: 'Pro AI provider requires a Pro or Business subscription.',
      upgradeUrl: '/settings/billing',
    },
    { status: 403 }
  );
}