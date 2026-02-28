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
  notionProvider,
  slackProvider,
} from './index';

const expectedProviderIds = ['generic-webhook', 'github', 'notion', 'slack'] as const;

describe('builtinProviders registry', () => {
  it('given the registry, should contain all providers', () => {
    expect(Object.keys(builtinProviders)).toHaveLength(expectedProviderIds.length);
    for (const id of expectedProviderIds) {
      expect(builtinProviders).toHaveProperty(id);
    }
  });

  it('given the registry, should map to the correct provider objects', () => {
    expect(builtinProviders['generic-webhook']).toBe(genericWebhookProvider);
    expect(builtinProviders['github']).toBe(githubProvider);
    expect(builtinProviders['notion']).toBe(notionProvider);
    expect(builtinProviders['slack']).toBe(slackProvider);
  });

  it('given all provider IDs, should be unique', () => {
    const ids = builtinProviderList.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe('builtinProviderList', () => {
  it('given the list, should contain all registered providers', () => {
    expect(builtinProviderList).toHaveLength(expectedProviderIds.length);
    expect(builtinProviderList).toContain(genericWebhookProvider);
    expect(builtinProviderList).toContain(githubProvider);
    expect(builtinProviderList).toContain(notionProvider);
    expect(builtinProviderList).toContain(slackProvider);
  });
});

describe('getBuiltinProvider', () => {
  it('given a known provider ID, should return the provider config', () => {
    expect(getBuiltinProvider('github')).toBe(githubProvider);
    expect(getBuiltinProvider('generic-webhook')).toBe(genericWebhookProvider);
    expect(getBuiltinProvider('notion')).toBe(notionProvider);
    expect(getBuiltinProvider('slack')).toBe(slackProvider);
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
    expect(isBuiltinProvider('notion')).toBe(true);
    expect(isBuiltinProvider('slack')).toBe(true);
  });

  it('given an unknown provider ID, should return false', () => {
    expect(isBuiltinProvider('unknown-provider')).toBe(false);
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
