/**
 * Integration Rate Limiter
 *
 * Wraps the distributed rate limiter for integration tool execution.
 * Provides connection + agent + tool level rate limiting.
 */

import {
  checkDistributedRateLimit,
  resetDistributedRateLimit,
  type RateLimitResult,
} from '../../security/distributed-rate-limit';

export interface IntegrationRateLimitConfig {
  connectionId: string;
  agentId: string | null;
  toolName: string;
  requestsPerMinute: number;
}

/**
 * Build a unique rate limit key for integration tool calls.
 *
 * Key structure: integration:{connectionId}:{agentId}:{toolName}
 * This ensures rate limits are tracked per connection, agent, and tool.
 */
export const buildRateLimitKey = (config: IntegrationRateLimitConfig): string => {
  return `integration:${config.connectionId}:${config.agentId ?? 'global'}:${config.toolName}`;
};

/**
 * Check if a tool call is allowed under rate limits.
 *
 * @param config - Rate limit configuration for this call
 * @returns Whether the call is allowed and retry info if not
 */
export const checkIntegrationRateLimit = async (
  config: IntegrationRateLimitConfig
): Promise<RateLimitResult> => {
  const key = buildRateLimitKey(config);

  return checkDistributedRateLimit(key, {
    maxAttempts: config.requestsPerMinute,
    windowMs: 60 * 1000, // 1 minute window
    blockDurationMs: 60 * 1000,
    progressiveDelay: false,
  });
};

/**
 * Reset rate limit for a specific integration key.
 * Useful after connection re-authorization.
 *
 * @param config - The connection/agent/tool to reset
 */
export const resetIntegrationRateLimit = async (
  config: Pick<IntegrationRateLimitConfig, 'connectionId' | 'agentId' | 'toolName'>
): Promise<void> => {
  const key = buildRateLimitKey({ ...config, requestsPerMinute: 0 });
  await resetDistributedRateLimit(key);
};

/**
 * Check rate limit at the connection level.
 * Used for provider-level rate limits that apply to all tools.
 *
 * @param connectionId - The connection to check
 * @param agentId - The agent making the call
 * @param requestsPerMinute - Provider-level rate limit
 */
export const checkConnectionRateLimit = async (
  connectionId: string,
  agentId: string | null,
  requestsPerMinute: number
): Promise<RateLimitResult> => {
  const key = `integration:${connectionId}:${agentId ?? 'global'}:provider`;

  return checkDistributedRateLimit(key, {
    maxAttempts: requestsPerMinute,
    windowMs: 60 * 1000,
    blockDurationMs: 60 * 1000,
    progressiveDelay: false,
  });
};

/**
 * Check rate limit at the drive level.
 * Used for cross-connection rate limits within a drive.
 *
 * @param driveId - The drive to check
 * @param requestsPerMinute - Drive-level rate limit
 */
export const checkDriveRateLimit = async (
  driveId: string,
  requestsPerMinute: number
): Promise<RateLimitResult> => {
  const key = `integration:drive:${driveId}`;

  return checkDistributedRateLimit(key, {
    maxAttempts: requestsPerMinute,
    windowMs: 60 * 1000,
    blockDurationMs: 60 * 1000,
    progressiveDelay: false,
  });
};

/**
 * Default rate limits for integrations.
 */
export const INTEGRATION_RATE_LIMITS = {
  /**
   * Default limit when no override is specified.
   */
  DEFAULT: 30, // 30 requests per minute

  /**
   * Minimum allowed rate limit.
   */
  MIN: 1, // 1 request per minute

  /**
   * Maximum allowed rate limit.
   */
  MAX: 1000, // 1000 requests per minute
} as const;
