/**
 * The scope an agent may hold from the jwt-bearer grant (ADR 0007 Decision 6,
 * threat model T4): `account` (+ optional `offline_access`) only. Content
 * (`drive:*`, `all_drives`) and key-shaped scopes are refused on this grant.
 */
import { describe, it, expect } from 'vitest';
import { resolveAgentAssertionScopes, AGENT_ASSERTION_DEFAULT_SCOPE } from '../assertion-scope';

describe('resolveAgentAssertionScopes', () => {
  it('given no scope, should grant the default account offline_access', () => {
    expect(AGENT_ASSERTION_DEFAULT_SCOPE).toBe('account offline_access');
    expect(resolveAgentAssertionScopes(null)).toEqual({ ok: true, scopes: ['account', 'offline_access'] });
  });

  it('given an empty or whitespace scope, should grant the default', () => {
    expect(resolveAgentAssertionScopes('')).toEqual({ ok: true, scopes: ['account', 'offline_access'] });
    expect(resolveAgentAssertionScopes('   ')).toEqual({ ok: true, scopes: ['account', 'offline_access'] });
  });

  it('given account alone, should grant an access-only account scope', () => {
    expect(resolveAgentAssertionScopes('account')).toEqual({ ok: true, scopes: ['account'] });
  });

  it('given account offline_access in any order, should grant both', () => {
    expect(resolveAgentAssertionScopes('offline_access account')).toEqual({ ok: true, scopes: ['account', 'offline_access'] });
  });

  it.each([
    ['a drive scope', 'drive:abc123'],
    ['a drive scope with a role', 'drive:abc123:admin'],
    ['all_drives', 'all_drives'],
    ['all_drives with offline_access', 'all_drives offline_access'],
    ['manage_keys (key management)', 'manage_keys'],
    ['manage_keys with offline_access', 'manage_keys offline_access'],
    ['update_key (key-shaped)', 'update_key:abc123 drive:abc123'],
    ['activate_key (key-shaped)', 'activate_key:abc123'],
    ['a key name (key-shaped mint)', 'drive:abc123 name:my-key'],
    ['offline_access alone', 'offline_access'],
    ['an unknown scope', 'account admin'],
    ['a malformed scope', 'account drive:'],
  ])('given %s, should refuse', (_label, scope) => {
    expect(resolveAgentAssertionScopes(scope)).toEqual({ ok: false });
  });
});
