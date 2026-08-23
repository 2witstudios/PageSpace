import { describe, expect, it } from 'vitest';
import { credentialKindOf, keysCommandNeedsLoginMessage } from '../credential-kind.js';
import type { AuthSource } from '../resolve.js';

const OAUTH_CREDENTIAL = {
  kind: 'oauth' as const,
  refreshToken: 'ps_rt_x',
  clientId: 'cli',
  scopes: ['manage_keys'],
  createdAt: '2026-08-22T00:00:00.000Z',
};

const STATIC_CREDENTIAL = {
  kind: 'static' as const,
  token: 'mcp_abcdefghijklmnop',
  scopes: ['drive:d1:member'],
  createdAt: '2026-08-22T00:00:00.000Z',
};

describe('credentialKindOf', () => {
  it('classifies an mcp_ bearer from --token or the env var as a key', () => {
    for (const kind of ['flag', 'env'] as const) {
      expect(credentialKindOf({ kind, token: 'mcp_abcdefghijklmnop' } as AuthSource)).toBe('key');
    }
  });

  // Never assumed to be a key: pre-emptively refusing something this CLI can't
  // identify would break a credential class the server might well accept.
  it('classifies any other bearer as "other" rather than guessing', () => {
    expect(credentialKindOf({ kind: 'flag', token: 'ps_at_abcdefgh' } as AuthSource)).toBe('other');
    expect(credentialKindOf({ kind: 'env', token: 'something-else' } as AuthSource)).toBe('other');
  });

  it('classifies a stored credential by its kind, not by inspecting its secret', () => {
    expect(credentialKindOf({ kind: 'stored', host: 'h', credential: STATIC_CREDENTIAL })).toBe('key');
    expect(credentialKindOf({ kind: 'stored', host: 'h', credential: OAUTH_CREDENTIAL })).toBe('login');
  });

  it('classifies no credential as "none"', () => {
    expect(credentialKindOf({ kind: 'none', host: 'h' })).toBe('none');
  });

  it('never returns the token it inspected', () => {
    expect(credentialKindOf({ kind: 'flag', token: 'mcp_abcdefghijklmnop' } as AuthSource)).not.toContain('mcp_');
  });
});

describe('keysCommandNeedsLoginMessage', () => {
  // Issue #2464: the message this replaces said the key had been invalidated,
  // which is the one thing that was not true.
  it('says the key is fine, names the real limitation, and gives a next step', () => {
    const message = keysCommandNeedsLoginMessage('list');
    expect(message).toContain('Your key is not invalid');
    expect(message).not.toMatch(/invalidated|revoked|expired/i);
    expect(message).toContain('pagespace login');
    expect(message).toContain('pagespace keys describe');
  });

  it('names the verb the caller actually ran', () => {
    expect(keysCommandNeedsLoginMessage('revoke')).toContain('"pagespace keys revoke"');
  });

  it('reads correctly for the bare wizard, which has no verb', () => {
    const message = keysCommandNeedsLoginMessage();
    expect(message).toContain('"pagespace keys"');
    expect(message).not.toContain('keys "');
  });
});
