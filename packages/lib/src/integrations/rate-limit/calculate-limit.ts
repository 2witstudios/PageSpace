/**
 * Pure Rate Limit Calculation
 *
 * Calculates the effective rate limit from multiple levels.
 * The most restrictive limit wins.
 *
 * This is a PURE function - no side effects, deterministic output.
 */

import type { RateLimitLevels } from '../types';

const DEFAULT_RATE_LIMIT = 30; // 30 requests per minute

/**
 * Calculate the effective rate limit from multiple levels.
 * Returns the most restrictive (lowest) limit.
 *
 * @param limits - Rate limits from different levels
 * @returns The effective rate limit (requests per minute)
 */
export const calculateEffectiveRateLimit = (limits: RateLimitLevels): number => {
  const candidates: number[] = [];

  // Provider-level limit (normalize to per-minute)
  if (limits.provider && limits.provider.windowMs > 0) {
    const perMinute = (limits.provider.requests / limits.provider.windowMs) * 60000;
    candidates.push(Math.floor(perMinute));
  }

  // Connection-level limit
  if (limits.connection?.requestsPerMinute !== undefined) {
    candidates.push(limits.connection.requestsPerMinute);
  }

  // Grant-level override
  if (limits.grant?.requestsPerMinute !== undefined) {
    candidates.push(limits.grant.requestsPerMinute);
  }

  // Tool-specific limit (normalize to per-minute)
  if (limits.tool && limits.tool.windowMs > 0) {
    const perMinute = (limits.tool.requests / limits.tool.windowMs) * 60000;
    candidates.push(Math.floor(perMinute));
  }

  // Return most restrictive (minimum) or default
  return candidates.length > 0 ? Math.min(...candidates) : DEFAULT_RATE_LIMIT;
};
