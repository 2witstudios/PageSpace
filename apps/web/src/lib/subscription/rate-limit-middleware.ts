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
  const isThinkingModel = provider === 'pagespace' && model === 'gemini-2.5-pro';
  const providerType: ProviderType = isThinkingModel ? 'extra_thinking' : 'normal';

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

  const errorMessage = providerType === 'extra_thinking'
    ? `Extra Thinking calls limited to ${limit} per day. Upgrade to Pro or Business for more access.`
    : `AI calls limited to ${limit} per day. Upgrade to Pro (50/day) or Business (500/day) for more calls.`;

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
  const isThinkingModel = provider === 'pagespace' && model === 'gemini-2.5-pro';
  if (!isThinkingModel) {
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
      message: 'Extra Thinking provider requires a Pro or Business subscription.',
      upgradeUrl: '/settings/billing',
    },
    { status: 403 }
  );
}