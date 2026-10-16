import { afterEach, describe, expect, it, vi } from 'vitest';
import { deploymentCapabilityTier, resolvePersonalCapabilityTier } from '../deployment-capability';
import { getStorageConfigFromSubscription } from '../../services/subscription-utils';
import { isMemoryAvailable } from '../automation-preferences';
import { TIERS } from '../subscription-tiers';

afterEach(() => vi.unstubAllEnvs());

describe('deployment capability independent of personal billing', () => {
  it.each(['onprem', 'tenant'] as const)('given %s personal Free, should preserve finite storage and Memory capability', (mode) => {
    vi.stubEnv('DEPLOYMENT_MODE', mode);
    expect(resolvePersonalCapabilityTier('free')).toBe('business');
    expect(isMemoryAvailable(resolvePersonalCapabilityTier('free'))).toBe(true);
    const storage = getStorageConfigFromSubscription('free');
    expect(storage.tier).toBe('business');
    expect(storage.quotaBytes).toBe(50 * 1024 ** 3);
    expect(storage.maxConcurrentUploads).toBe(10);
    expect(storage.maxFileCount).toBe(0);
    for (const tier of TIERS) expect(deploymentCapabilityTier(tier, mode)).toBe('business');
  });

  it('given cloud personal records, should reject retired tiers without altering explicit org entitlement', () => {
    vi.stubEnv('DEPLOYMENT_MODE', 'cloud');
    for (const value of ['free', 'business', 'founder', 'unknown', null]) {
      expect(resolvePersonalCapabilityTier(value)).toBe('free');
      expect(isMemoryAvailable(resolvePersonalCapabilityTier(value))).toBe(false);
    }
    expect(resolvePersonalCapabilityTier('pro')).toBe('pro');
    expect(deploymentCapabilityTier('business', 'cloud')).toBe('business');
  });
});
