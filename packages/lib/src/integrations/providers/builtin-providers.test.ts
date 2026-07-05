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
  it('given a builtin provider row, should ignore stale persisted config and return the in-memory definition', () => {
    const stalePersistedConfig = {
      id: 'github',
      name: 'GitHub (stale)',
      tools: [], // e.g. missing tools/bundles added since this row was last seeded
    };

    const resolved = resolveProviderConfig({
      slug: 'github',
      providerType: 'builtin',
      config: stalePersistedConfig,
    });

    expect(resolved).toBe(builtinProviders.github);
    expect(resolved).not.toBe(stalePersistedConfig);
    expect(resolved?.tools.length).toBeGreaterThan(0);
  });

  it('given a custom provider, should fall back to the persisted config', () => {
    const customConfig = { id: 'my-custom-provider', name: 'Custom', tools: [] };

    const resolved = resolveProviderConfig({
      slug: 'my-custom-provider',
      providerType: 'custom',
      config: customConfig,
    });

    expect(resolved).toBe(customConfig);
  });

  it('given a non-builtin provider whose slug collides with a builtin, should keep its own persisted config', () => {
    const customConfig = { id: 'github', name: 'My GitHub Proxy', tools: [] };

    const resolved = resolveProviderConfig({
      slug: 'github',
      providerType: 'custom',
      config: customConfig,
    });

    expect(resolved).toBe(customConfig);
    expect(resolved).not.toBe(builtinProviders.github);
  });

  it('given a builtin-typed row whose slug no longer has an in-memory definition, should fall back to the persisted config', () => {
    const persistedConfig = { id: 'retired-builtin', name: 'Retired', tools: [] };

    const resolved = resolveProviderConfig({
      slug: 'retired-builtin',
      providerType: 'builtin',
      config: persistedConfig,
    });

    expect(resolved).toBe(persistedConfig);
  });

  it('given no provider, should return null', () => {
    expect(resolveProviderConfig(null)).toBeNull();
    expect(resolveProviderConfig(undefined)).toBeNull();
  });
});
