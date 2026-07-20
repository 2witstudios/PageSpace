import { describe, it, expect, vi } from 'vitest';
import { resolveFallbackDeviceId, type DeviceIdFallbackDeps } from '../device-id-fallback';

describe('resolveFallbackDeviceId', () => {
  it('reuses a previously-persisted id without generating or re-persisting', () => {
    const deps: DeviceIdFallbackDeps = {
      readPersistedId: vi.fn().mockReturnValue('stored-uuid'),
      persistId: vi.fn(),
      generateId: vi.fn().mockReturnValue('should-not-be-used'),
    };

    expect(resolveFallbackDeviceId(deps)).toBe('stored-uuid');
    expect(deps.generateId).not.toHaveBeenCalled();
    expect(deps.persistId).not.toHaveBeenCalled();
  });

  it('generates and persists a new id when none is stored', () => {
    const deps: DeviceIdFallbackDeps = {
      readPersistedId: vi.fn().mockReturnValue(null),
      persistId: vi.fn(),
      generateId: vi.fn().mockReturnValue('fresh-uuid'),
    };

    expect(resolveFallbackDeviceId(deps)).toBe('fresh-uuid');
    expect(deps.persistId).toHaveBeenCalledWith('fresh-uuid');
  });

  it('is STABLE across a simulated hostname change (persisted uuid, never hostname-derived)', () => {
    // In-memory persistence store. The hostname is irrelevant to the result:
    // the fallback only ever reads/writes the persisted uuid.
    let stored: string | null = null;
    let generateCount = 0;
    const deps: DeviceIdFallbackDeps = {
      readPersistedId: () => stored,
      persistId: (id) => { stored = id; },
      generateId: () => `uuid-${++generateCount}`,
    };

    // First launch (hostname "host-A"): generates + persists.
    const first = resolveFallbackDeviceId(deps);
    // Second launch after a hostname change (hostname "host-B"): reuses the same id.
    const second = resolveFallbackDeviceId(deps);

    expect(first).toBe('uuid-1');
    expect(second).toBe('uuid-1');
    expect(generateCount).toBe(1);
  });
});
