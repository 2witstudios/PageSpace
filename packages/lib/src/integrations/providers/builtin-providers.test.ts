import { describe, it, expect } from 'vitest';
import {
  builtinProviders,
  builtinProviderList,
  getBuiltinProvider,
  isBuiltinProvider,
  resolveProviderConfig,
} from './builtin-providers';

describe('getBuiltinProvider / isBuiltinProvider', () => {
  it('given a known builtin slug, should return its definition', () => {
    expect(getBuiltinProvider('github')).toBe(builtinProviders.github);
    expect(isBuiltinProvider('github')).toBe(true);
  });

  it('given an unknown slug, should return null / false', () => {
    expect(getBuiltinProvider('not-a-provider')).toBeNull();
    expect(isBuiltinProvider('not-a-provider')).toBe(false);
  });

  it('should list every registered builtin provider', () => {
    expect(builtinProviderList).toHaveLength(Object.keys(builtinProviders).length);
  });
});

describe('resolveProviderConfig', () => {
  it('given a builtin provider slug, should ignore stale persisted config and return the in-memory definition', () => {
    const stalePersistedConfig = {
      id: 'github',
      name: 'GitHub (stale)',
      tools: [], // e.g. missing tools/bundles added since this row was last seeded
    };

    const resolved = resolveProviderConfig({ slug: 'github', config: stalePersistedConfig });

    expect(resolved).toBe(builtinProviders.github);
    expect(resolved).not.toBe(stalePersistedConfig);
    expect(resolved?.tools.length).toBeGreaterThan(0);
  });

  it('given a non-builtin (custom) provider slug, should fall back to the persisted config', () => {
    const customConfig = { id: 'my-custom-provider', name: 'Custom', tools: [] };

    const resolved = resolveProviderConfig({ slug: 'my-custom-provider', config: customConfig });

    expect(resolved).toBe(customConfig);
  });

  it('given no provider, should return null', () => {
    expect(resolveProviderConfig(null)).toBeNull();
    expect(resolveProviderConfig(undefined)).toBeNull();
  });
});
