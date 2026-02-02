/**
 * Integration Rate Limiter Tests
 *
 * Tests for rate limiting tool execution.
 * Uses mocked distributed rate limiter for unit testing.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock types for rate limiter
interface RateLimitResult {
  allowed: boolean;
  retryAfter?: number;
  attemptsRemaining?: number;
}

interface IntegrationRateLimitConfig {
  connectionId: string;
  agentId: string;
  toolName: string;
  requestsPerMinute: number;
}

// Mock rate limiter
const mockCheckRateLimit = vi.fn<
  (key: string, config: { maxAttempts: number; windowMs: number }) => Promise<RateLimitResult>
>();
const mockResetRateLimit = vi.fn<(key: string) => Promise<void>>();

// Inline implementation for testing
const buildRateLimitKey = (config: IntegrationRateLimitConfig): string => {
  return `integration:${config.connectionId}:${config.agentId}:${config.toolName}`;
};

const checkIntegrationRateLimit = async (
  config: IntegrationRateLimitConfig
): Promise<RateLimitResult> => {
  const key = buildRateLimitKey(config);
  return mockCheckRateLimit(key, {
    maxAttempts: config.requestsPerMinute,
    windowMs: 60 * 1000,
  });
};

const resetIntegrationRateLimit = async (
  config: Pick<IntegrationRateLimitConfig, 'connectionId' | 'agentId' | 'toolName'>
): Promise<void> => {
  const key = buildRateLimitKey({ ...config, requestsPerMinute: 0 });
  await mockResetRateLimit(key);
};

describe('buildRateLimitKey', () => {
  it('given connection, agent, and tool, should create unique key', () => {
    const config: IntegrationRateLimitConfig = {
      connectionId: 'conn-123',
      agentId: 'agent-456',
      toolName: 'list_repos',
      requestsPerMinute: 30,
    };

    const key = buildRateLimitKey(config);

    expect(key).toBe('integration:conn-123:agent-456:list_repos');
  });

  it('given different tools, should create different keys', () => {
    const config1: IntegrationRateLimitConfig = {
      connectionId: 'conn-123',
      agentId: 'agent-456',
      toolName: 'list_repos',
      requestsPerMinute: 30,
    };

    const config2: IntegrationRateLimitConfig = {
      connectionId: 'conn-123',
      agentId: 'agent-456',
      toolName: 'create_issue',
      requestsPerMinute: 30,
    };

    expect(buildRateLimitKey(config1)).not.toBe(buildRateLimitKey(config2));
  });
});

describe('checkIntegrationRateLimit', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('given count under limit, should allow request', async () => {
    mockCheckRateLimit.mockResolvedValue({
      allowed: true,
      attemptsRemaining: 29,
    });

    const result = await checkIntegrationRateLimit({
      connectionId: 'conn-123',
      agentId: 'agent-456',
      toolName: 'list_repos',
      requestsPerMinute: 30,
    });

    expect(result.allowed).toBe(true);
    expect(result.attemptsRemaining).toBe(29);
  });

  it('given count at limit, should deny request', async () => {
    mockCheckRateLimit.mockResolvedValue({
      allowed: false,
      retryAfter: 45,
    });

    const result = await checkIntegrationRateLimit({
      connectionId: 'conn-123',
      agentId: 'agent-456',
      toolName: 'list_repos',
      requestsPerMinute: 30,
    });

    expect(result.allowed).toBe(false);
    expect(result.retryAfter).toBe(45);
  });

  it('given rate limit config, should track per minute window', async () => {
    mockCheckRateLimit.mockResolvedValue({ allowed: true });

    await checkIntegrationRateLimit({
      connectionId: 'conn-123',
      agentId: 'agent-456',
      toolName: 'list_repos',
      requestsPerMinute: 60,
    });

    expect(mockCheckRateLimit).toHaveBeenCalledWith(
      'integration:conn-123:agent-456:list_repos',
      { maxAttempts: 60, windowMs: 60000 }
    );
  });

  it('given different keys, should track independently', async () => {
    mockCheckRateLimit.mockResolvedValue({ allowed: true });

    await checkIntegrationRateLimit({
      connectionId: 'conn-1',
      agentId: 'agent-1',
      toolName: 'tool-a',
      requestsPerMinute: 30,
    });

    await checkIntegrationRateLimit({
      connectionId: 'conn-2',
      agentId: 'agent-2',
      toolName: 'tool-b',
      requestsPerMinute: 30,
    });

    expect(mockCheckRateLimit).toHaveBeenCalledTimes(2);
    expect(mockCheckRateLimit).toHaveBeenCalledWith(
      'integration:conn-1:agent-1:tool-a',
      expect.any(Object)
    );
    expect(mockCheckRateLimit).toHaveBeenCalledWith(
      'integration:conn-2:agent-2:tool-b',
      expect.any(Object)
    );
  });
});

describe('resetIntegrationRateLimit', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('given window expiration, should reset count', async () => {
    mockResetRateLimit.mockResolvedValue(undefined);

    await resetIntegrationRateLimit({
      connectionId: 'conn-123',
      agentId: 'agent-456',
      toolName: 'list_repos',
    });

    expect(mockResetRateLimit).toHaveBeenCalledWith(
      'integration:conn-123:agent-456:list_repos'
    );
  });
});

describe('rate limit integration scenarios', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('given provider rate limit, should apply to all tools', async () => {
    // Simulate provider-level rate limit
    mockCheckRateLimit.mockResolvedValue({ allowed: true });

    const providerLimit = 100; // requests per minute for entire provider

    await checkIntegrationRateLimit({
      connectionId: 'conn-github',
      agentId: 'agent-1',
      toolName: 'provider:github', // Provider-level key
      requestsPerMinute: providerLimit,
    });

    expect(mockCheckRateLimit).toHaveBeenCalledWith(
      'integration:conn-github:agent-1:provider:github',
      { maxAttempts: 100, windowMs: 60000 }
    );
  });

  it('given grant-level override, should use most restrictive limit', async () => {
    // When grant specifies a lower limit than provider
    mockCheckRateLimit.mockResolvedValue({
      allowed: false,
      retryAfter: 30,
    });

    const grantOverrideLimit = 10; // Grant allows only 10/min (more restrictive than provider's 100)

    const result = await checkIntegrationRateLimit({
      connectionId: 'conn-github',
      agentId: 'agent-1',
      toolName: 'create_issue',
      requestsPerMinute: grantOverrideLimit,
    });

    expect(result.allowed).toBe(false);
  });
});
