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
  it('refuses without claiming anything about the key, names the real limitation, and gives a next step', () => {
    const message = keysCommandNeedsLoginMessage('list', 'flag');
    expect(message).toContain('That says nothing about the key');
    expect(message).not.toMatch(/invalidated|revoked|expired/i);
    expect(message).toContain('pagespace login');
    expect(message).toContain('pagespace keys describe');
  });

  // Nothing has been validated when this fires — the classification is a
  // prefix check on a credential no request has been made with, so a revoked
  // token reaches this branch too. Asserting the key is VALID would swap one
  // unearned claim for its mirror image.
  it('never asserts that the key is valid, only that this refusal is not about it', () => {
    expect(keysCommandNeedsLoginMessage('list', 'flag')).not.toMatch(/key is (still )?(valid|fine|not invalid|working)/i);
  });

  // `pagespace login` alone is not enough while the key is still in the
  // environment: an explicit --token/env credential outranks the stored login
  // (auth/resolve.ts), so the caller would log in and hit this same refusal.
  it('tells the caller to remove the overriding credential, not just to log in', () => {
    const message = keysCommandNeedsLoginMessage('list', 'flag');
    expect(message).toMatch(/--token removed/);
    expect(message).toMatch(/outranks/);
  });

  // Issue #2481/#2476: every source used to get the same "--token/env
  // credential" line — a caller who only ever passed --key was told to remove
  // a flag it never used. The message now names the source that actually
  // resolved, per the AuthSource kind the resolve path already classified.
  it('names --token specifically when a --token flag resolved the key', () => {
    const message = keysCommandNeedsLoginMessage('list', 'flag');
    expect(message).toMatch(/--token removed/);
    expect(message).not.toMatch(/--key/);
  });

  it('names the env var specifically when PAGESPACE_TOKEN resolved the key', () => {
    const message = keysCommandNeedsLoginMessage('list', 'env');
    expect(message).toMatch(/PAGESPACE_TOKEN unset/);
    expect(message).not.toMatch(/--token removed/);
  });

  it('names the stored key, not --token, when a --key/stored credential resolved the key', () => {
    const message = keysCommandNeedsLoginMessage('list', 'stored');
    expect(message).toMatch(/--key\/PAGESPACE_KEY/);
    expect(message).not.toMatch(/--token removed/);
  });

  // Issue #2481/#2476 follow-up: PAGESPACE_TOKEN has a deprecated legacy alias,
  // PAGESPACE_AUTH_TOKEN, that still wins precedence when set. Naming the
  // MODERN var while the LEGACY one is what resolved leaves it in place — the
  // caller re-runs, resolves the same credential, and hits this refusal again.
  it('names the legacy env alias when THAT is what actually resolved the key, not PAGESPACE_TOKEN', () => {
    const message = keysCommandNeedsLoginMessage('list', 'env', 'PAGESPACE_AUTH_TOKEN');
    expect(message).toMatch(/PAGESPACE_AUTH_TOKEN unset/);
    expect(message).not.toMatch(/PAGESPACE_TOKEN unset/);
  });

  it('names the legacy PAGESPACE_PROFILE alias when it named the stored key, not the generic --key line', () => {
    const message = keysCommandNeedsLoginMessage('list', 'stored', 'PAGESPACE_PROFILE');
    expect(message).toMatch(/unsetting PAGESPACE_PROFILE/);
    expect(message).not.toMatch(/--key\/PAGESPACE_KEY/);
  });

  it('falls back to the modern PAGESPACE_TOKEN wording when no legacy alias is in play', () => {
    const message = keysCommandNeedsLoginMessage('list', 'env', null);
    expect(message).toMatch(/PAGESPACE_TOKEN unset/);
  });

  it('names the verb the caller actually ran', () => {
    expect(keysCommandNeedsLoginMessage('revoke', 'flag')).toContain('"pagespace keys revoke"');
  });

  it('reads correctly for the bare wizard, which has no verb', () => {
    const message = keysCommandNeedsLoginMessage(undefined, 'flag');
    expect(message).toContain('"pagespace keys"');
    expect(message).not.toContain('keys "');
  });
});
