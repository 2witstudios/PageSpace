import { describe, it, expect, vi } from 'vitest';
import { resolveFallbackDeviceId, type DeviceIdFallbackDeps } from '../device-id-fallback';

describe('resolveFallbackDeviceId', () => {
  it('reuses a previously-persisted id without seeding or re-persisting', () => {
    const deps: DeviceIdFallbackDeps = {
      readPersistedId: vi.fn().mockReturnValue('stored-id'),
      persistId: vi.fn(),
      seedId: vi.fn().mockReturnValue('should-not-be-used'),
    };

    expect(resolveFallbackDeviceId(deps)).toBe('stored-id');
    expect(deps.seedId).not.toHaveBeenCalled();
    expect(deps.persistId).not.toHaveBeenCalled();
  });

  it('seeds from the legacy machine-derived id on first run and persists it (P1 upgrade continuity)', () => {
    // On upgrade there is no device-id file yet, but the device token is already
    // bound to the legacy `${hostname}-${platform}-${arch}` value. Seeding from
    // that value (not a fresh random id) preserves the binding, then persisting
    // it freezes it for future launches.
    let stored: string | null = null;
    const deps: DeviceIdFallbackDeps = {
      readPersistedId: () => stored,
      persistId: (id) => { stored = id; },
      seedId: () => 'oldhost-darwin-arm64',
    };

    expect(resolveFallbackDeviceId(deps)).toBe('oldhost-darwin-arm64');
    expect(stored).toBe('oldhost-darwin-arm64');
  });

  it('is STABLE across a simulated hostname change once persisted (never re-derived)', () => {
    let stored: string | null = null;
    let seedCount = 0;
    const deps: DeviceIdFallbackDeps = {
      readPersistedId: () => stored,
      persistId: (id) => { stored = id; },
      // Simulate the hostname changing between launches: the seed would differ,
      // but the persisted value must win so the id never flips.
      seedId: () => `host-${++seedCount}-darwin-arm64`,
    };

    const first = resolveFallbackDeviceId(deps);   // launch on host-1 → seeds + persists
    const second = resolveFallbackDeviceId(deps);  // launch on host-2 → reads persisted

    expect(first).toBe('host-1-darwin-arm64');
    expect(second).toBe('host-1-darwin-arm64');
    expect(seedCount).toBe(1);
  });

  it('stays stable across launches even when persistence FAILS, thanks to a deterministic seed (P2)', () => {
    // Simulate a read-only profile / full disk: persistId is a no-op, so the
    // file never appears. A deterministic seed means each launch regenerates the
    // SAME id — no device-binding churn, no repeated logouts.
    const deps: DeviceIdFallbackDeps = {
      readPersistedId: () => null,           // file never exists (write kept failing)
      persistId: () => { /* swallowed failure */ },
      seedId: () => 'host-darwin-arm64',     // deterministic for this machine
    };

    expect(resolveFallbackDeviceId(deps)).toBe('host-darwin-arm64');
    expect(resolveFallbackDeviceId(deps)).toBe('host-darwin-arm64'); // next launch, same id
  });
});
