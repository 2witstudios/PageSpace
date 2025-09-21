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
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  _provider: string,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  _model?: string
): Promise<RateLimitResult> {
  // All usage is now tracked as 'normal' type
  const providerType: ProviderType = 'normal';

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

  const errorMessage = `AI operations limited to ${limit} per day. Upgrade your plan for more operations.`;

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
 * Check if provider requires paid subscription (deprecated - all models available to all tiers)
 */
export function requiresProSubscription(
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  _provider: string,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  _model?: string
): boolean {
  // All models are now available to all subscription tiers
  return false;
}

/**
 * Create subscription required error response (deprecated)
 */
export function createSubscriptionRequiredResponse(): NextResponse {
  return NextResponse.json(
    {
      error: 'Subscription required',
      message: 'This feature requires a paid subscription.',
      upgradeUrl: '/settings/billing',
    },
    { status: 403 }
  );
}