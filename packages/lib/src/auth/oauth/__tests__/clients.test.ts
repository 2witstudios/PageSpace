/**
 * Static first-party OAuth client registry (ADR 0002 Decision 3) + redirect_uri
 * validation. Registry lookup is code, not DB, for the CLI's client_id; the
 * DB `oauth_clients` table exists only for future dynamic registration.
 */
import { describe, it, expect } from 'vitest';
import { getRegisteredClient, validateRedirectUri, PAGESPACE_CLI_CLIENT_ID } from '../clients';

describe('getRegisteredClient', () => {
  it('returns the pagespace-cli client for its client_id', () => {
    const client = getRegisteredClient(PAGESPACE_CLI_CLIENT_ID);
    expect(client).not.toBeNull();
    expect(client?.clientId).toBe('pagespace-cli');
    expect(client?.type).toBe('public');
    expect(client?.firstParty).toBe(true);
  });

  it('returns null for an unknown client_id (fail closed)', () => {
    expect(getRegisteredClient('evil-client')).toBeNull();
  });

  it('returns null for an empty string', () => {
    expect(getRegisteredClient('')).toBeNull();
  });
});

describe('validateRedirectUri', () => {
  const client = getRegisteredClient(PAGESPACE_CLI_CLIENT_ID)!;

  it('accepts the exact registered loopback path on an arbitrary port', () => {
    expect(validateRedirectUri(client, 'http://127.0.0.1:51234/callback')).toBe(true);
    expect(validateRedirectUri(client, 'http://127.0.0.1:1/callback')).toBe(true);
    expect(validateRedirectUri(client, 'http://127.0.0.1/callback')).toBe(true); // default port
  });

  it('accepts the IPv6 loopback literal on an arbitrary port', () => {
    expect(validateRedirectUri(client, 'http://[::1]:9999/callback')).toBe(true);
  });

  it('rejects `localhost` even though it usually resolves to loopback (RFC 8252 §8.3)', () => {
    expect(validateRedirectUri(client, 'http://localhost:51234/callback')).toBe(false);
  });

  it('rejects a mismatched path on the loopback host (substring/prefix attack)', () => {
    expect(validateRedirectUri(client, 'http://127.0.0.1:51234/callback/evil')).toBe(false);
    expect(validateRedirectUri(client, 'http://127.0.0.1:51234/call')).toBe(false);
    expect(validateRedirectUri(client, 'http://127.0.0.1:51234/')).toBe(false);
  });

  it('rejects a non-loopback host entirely (open redirect attempt)', () => {
    expect(validateRedirectUri(client, 'http://evil.example.com/callback')).toBe(false);
    expect(validateRedirectUri(client, 'https://127.0.0.1.evil.example.com/callback')).toBe(false);
  });

  it('rejects https on the loopback pattern (scheme must match exactly)', () => {
    expect(validateRedirectUri(client, 'https://127.0.0.1:51234/callback')).toBe(false);
  });

  it('rejects a redirect_uri carrying userinfo, query, or fragment', () => {
    expect(validateRedirectUri(client, 'http://user@127.0.0.1:51234/callback')).toBe(false);
    expect(validateRedirectUri(client, 'http://127.0.0.1:51234/callback?x=1')).toBe(false);
    expect(validateRedirectUri(client, 'http://127.0.0.1:51234/callback#frag')).toBe(false);
  });

  it('rejects a malformed URI', () => {
    expect(validateRedirectUri(client, 'not a uri')).toBe(false);
    expect(validateRedirectUri(client, '')).toBe(false);
  });

  it('rejects everything for a client with no registered redirect URIs', () => {
    const bareClient = { clientId: 'x', name: 'X', type: 'public' as const, redirectUris: [], allowedGrantTypes: [], firstParty: false };
    expect(validateRedirectUri(bareClient, 'http://127.0.0.1:1/callback')).toBe(false);
  });

  it('zero-trust audit: alternate loopback IP encodings (decimal/octal/short-form) still resolve to the exact registered host, not a bypass', () => {
    // The WHATWG URL parser normalizes every one of these into the literal
    // "127.0.0.1" before validateRedirectUri ever compares hostnames — so
    // there is no alternate representation that is BOTH accepted here AND
    // distinct from the registered loopback literal.
    expect(validateRedirectUri(client, 'http://2130706433/callback')).toBe(true); // decimal
    expect(validateRedirectUri(client, 'http://0177.0.0.1/callback')).toBe(true); // octal
    expect(validateRedirectUri(client, 'http://127.1/callback')).toBe(true); // short-form
  });

  it('zero-trust audit: expanded/alternate IPv6 loopback literals still normalize to [::1]', () => {
    expect(validateRedirectUri(client, 'http://[0:0:0:0:0:0:0:1]/callback')).toBe(true);
    expect(validateRedirectUri(client, 'http://[::0:1]/callback')).toBe(true);
  });

  it('zero-trust audit: a dot-segment path-traversal probe cannot smuggle an unregistered path past the exact-match check', () => {
    // The URL parser resolves ".." during parsing itself (before this
    // function ever sees a pathname), so this collapses to "/secret", which
    // is exactly matched against and rejected the same as any other
    // unregistered path.
    expect(validateRedirectUri(client, 'http://127.0.0.1:5000/callback/../secret')).toBe(false);
    expect(validateRedirectUri(client, 'http://127.0.0.1:5000/callback/../../evil')).toBe(false);
  });

  it('zero-trust audit: an encoded dot-segment (literal %2e%2e, never decoded into a path separator) is rejected as an unregistered path', () => {
    expect(validateRedirectUri(client, 'http://127.0.0.1:5000/callback%2e%2e/evil')).toBe(false);
  });
});
