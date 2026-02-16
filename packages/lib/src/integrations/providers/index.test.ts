/**
 * Provider Registry Tests
 *
 * Validates the built-in provider registry, lookup utilities,
 * and structural invariants.
 */

import { describe, it, expect } from 'vitest';
import {
  builtinProviders,
  builtinProviderList,
  getBuiltinProvider,
  isBuiltinProvider,
  genericWebhookProvider,
  githubProvider,
} from './index';

describe('builtinProviders registry', () => {
  it('given the registry, should contain both providers', () => {
    expect(Object.keys(builtinProviders)).toHaveLength(2);
    expect(builtinProviders).toHaveProperty('generic-webhook');
    expect(builtinProviders).toHaveProperty('github');
  });

  it('given the registry, should map to the correct provider objects', () => {
    expect(builtinProviders['generic-webhook']).toBe(genericWebhookProvider);
    expect(builtinProviders['github']).toBe(githubProvider);
  });

  it('given all provider IDs, should be unique', () => {
    const ids = builtinProviderList.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe('builtinProviderList', () => {
  it('given the list, should contain all registered providers', () => {
    expect(builtinProviderList).toHaveLength(2);
    expect(builtinProviderList).toContain(genericWebhookProvider);
    expect(builtinProviderList).toContain(githubProvider);
  });
});

describe('getBuiltinProvider', () => {
  it('given a known provider ID, should return the provider config', () => {
    expect(getBuiltinProvider('github')).toBe(githubProvider);
    expect(getBuiltinProvider('generic-webhook')).toBe(genericWebhookProvider);
  });

  it('given an unknown provider ID, should return null', () => {
    expect(getBuiltinProvider('unknown-provider')).toBeNull();
    expect(getBuiltinProvider('')).toBeNull();
  });
});

describe('isBuiltinProvider', () => {
  it('given a known provider ID, should return true', () => {
    expect(isBuiltinProvider('github')).toBe(true);
    expect(isBuiltinProvider('generic-webhook')).toBe(true);
  });

  it('given an unknown provider ID, should return false', () => {
    expect(isBuiltinProvider('slack')).toBe(false);
    expect(isBuiltinProvider('')).toBe(false);
  });
});

describe('provider structural invariants', () => {
  it('given all providers, should each have at least one tool', () => {
    for (const provider of builtinProviderList) {
      expect(provider.tools.length).toBeGreaterThan(0);
    }
  });

  it('given all providers, should each have a non-empty id and name', () => {
    for (const provider of builtinProviderList) {
      expect(provider.id).toBeTruthy();
      expect(provider.name).toBeTruthy();
    }
  });

  it('given all tools across all providers, should have unique IDs within their provider', () => {
    for (const provider of builtinProviderList) {
      const toolIds = provider.tools.map((t) => t.id);
      expect(new Set(toolIds).size).toBe(toolIds.length);
    }
  });
});
