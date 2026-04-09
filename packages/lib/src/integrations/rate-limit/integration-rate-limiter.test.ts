/**
 * Integration Rate Limiter Tests
 *
 * Tests for rate limiting tool execution.
 * Imports from the actual source and mocks the distributed rate limiter.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the distributed rate limiter
const mockCheckDistributedRateLimit = vi.fn();
const mockResetDistributedRateLimit = vi.fn();

vi.mock('../../security/distributed-rate-limit', () => ({
  checkDistributedRateLimit: (...args: unknown[]) => mockCheckDistributedRateLimit(...args),
  resetDistributedRateLimit: (...args: unknown[]) => mockResetDistributedRateLimit(...args),
}));

import {
  buildRateLimitKey,
  checkIntegrationRateLimit,
  resetIntegrationRateLimit,
  checkConnectionRateLimit,
  checkDriveRateLimit,
  INTEGRATION_RATE_LIMITS,
  type IntegrationRateLimitConfig,
} from './integration-rate-limiter';

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

  it('given null agentId, should use global in key', () => {
    const config: IntegrationRateLimitConfig = {
      connectionId: 'conn-123',
      agentId: null,
      toolName: 'list_repos',
      requestsPerMinute: 30,
    };

    const key = buildRateLimitKey(config);

    expect(key).toBe('integration:conn-123:global:list_repos');
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
    mockCheckDistributedRateLimit.mockResolvedValue({
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
    mockCheckDistributedRateLimit.mockResolvedValue({
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

  it('given rate limit config, should call distributed rate limiter with correct params', async () => {
    mockCheckDistributedRateLimit.mockResolvedValue({ allowed: true });

    await checkIntegrationRateLimit({
      connectionId: 'conn-123',
      agentId: 'agent-456',
      toolName: 'list_repos',
      requestsPerMinute: 60,
    });

    expect(mockCheckDistributedRateLimit).toHaveBeenCalledWith(
      'integration:conn-123:agent-456:list_repos',
      {
        maxAttempts: 60,
        windowMs: 60000,
        blockDurationMs: 60000,
        progressiveDelay: false,
      }
    );
  });

  it('given different keys, should track independently', async () => {
    mockCheckDistributedRateLimit.mockResolvedValue({ allowed: true });

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

    expect(mockCheckDistributedRateLimit).toHaveBeenCalledTimes(2);
    expect(mockCheckDistributedRateLimit).toHaveBeenCalledWith(
      'integration:conn-1:agent-1:tool-a',
      {
        maxAttempts: 30,
        windowMs: 60000,
        blockDurationMs: 60000,
        progressiveDelay: false,
      }
    );
    expect(mockCheckDistributedRateLimit).toHaveBeenCalledWith(
      'integration:conn-2:agent-2:tool-b',
      {
        maxAttempts: 30,
        windowMs: 60000,
        blockDurationMs: 60000,
        progressiveDelay: false,
      }
    );
  });
});

describe('resetIntegrationRateLimit', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('given reset request, should call resetDistributedRateLimit with correct key', async () => {
    mockResetDistributedRateLimit.mockResolvedValue(undefined);

    await resetIntegrationRateLimit({
      connectionId: 'conn-123',
      agentId: 'agent-456',
      toolName: 'list_repos',
    });

    expect(mockResetDistributedRateLimit).toHaveBeenCalledWith(
      'integration:conn-123:agent-456:list_repos'
    );
  });

  it('given null agentId, should use global in key', async () => {
    mockResetDistributedRateLimit.mockResolvedValue(undefined);

    await resetIntegrationRateLimit({
      connectionId: 'conn-123',
      agentId: null,
      toolName: 'list_repos',
    });

    expect(mockResetDistributedRateLimit).toHaveBeenCalledWith(
      'integration:conn-123:global:list_repos'
    );
  });
});

describe('checkConnectionRateLimit', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('given connection rate limit check, should use provider-level key', async () => {
    mockCheckDistributedRateLimit.mockResolvedValue({ allowed: true });

    await checkConnectionRateLimit('conn-github', 'agent-1', 100);

    expect(mockCheckDistributedRateLimit).toHaveBeenCalledWith(
      'integration:conn-github:agent-1:provider',
      {
        maxAttempts: 100,
        windowMs: 60000,
        blockDurationMs: 60000,
        progressiveDelay: false,
      }
    );
  });

  it('given null agentId, should use global in key', async () => {
    mockCheckDistributedRateLimit.mockResolvedValue({ allowed: true });

    await checkConnectionRateLimit('conn-github', null, 100);

    expect(mockCheckDistributedRateLimit).toHaveBeenCalledWith(
      'integration:conn-github:global:provider',
      {
        maxAttempts: 100,
        windowMs: 60000,
        blockDurationMs: 60000,
        progressiveDelay: false,
      }
    );
  });
});

describe('checkDriveRateLimit', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('given drive rate limit check, should use drive-level key', async () => {
    mockCheckDistributedRateLimit.mockResolvedValue({ allowed: true });

    await checkDriveRateLimit('drive-123', 200);

    expect(mockCheckDistributedRateLimit).toHaveBeenCalledWith(
      'integration:drive:drive-123',
      {
        maxAttempts: 200,
        windowMs: 60000,
        blockDurationMs: 60000,
        progressiveDelay: false,
      }
    );
  });

  it('given rate limit exceeded, should return denied result', async () => {
    mockCheckDistributedRateLimit.mockResolvedValue({
      allowed: false,
      retryAfter: 30,
    });

    const result = await checkDriveRateLimit('drive-123', 200);

    expect(result.allowed).toBe(false);
    expect(result.retryAfter).toBe(30);
  });
});

describe('INTEGRATION_RATE_LIMITS', () => {
  it('should export default rate limits', () => {
    expect(INTEGRATION_RATE_LIMITS.DEFAULT).toBe(30);
    expect(INTEGRATION_RATE_LIMITS.MIN).toBe(1);
    expect(INTEGRATION_RATE_LIMITS.MAX).toBe(1000);
  });
});
