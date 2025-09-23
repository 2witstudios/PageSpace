import { NextResponse } from 'next/server';
import { incrementUsage, ProviderType } from './usage-service';

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
  // Determine provider type based on model name for PageSpace provider
  const isProModel = provider === 'pagespace' && model === 'GLM-4.5';
  const providerType: ProviderType = isProModel ? 'pro' : 'standard';

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
  const resetTimeString = resetTime || getTomorrowMidnight();

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
 * Get tomorrow midnight UTC for rate limit reset
 */
function getTomorrowMidnight(): Date {
  const tomorrow = new Date();
  tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
  tomorrow.setUTCHours(0, 0, 0, 0);
  return tomorrow;
}

/**
 * Check if provider requires Pro subscription
 */
export function requiresProSubscription(provider: string, model: string | undefined, subscriptionTier: string | undefined): boolean {
  const isProModel = provider === 'pagespace' && model === 'GLM-4.5';
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