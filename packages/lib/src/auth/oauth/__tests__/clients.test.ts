/**
 * Static first-party OAuth client registry (ADR 0002 Decision 3) + redirect_uri
 * validation. Registry lookup is code, not DB, for the CLI's client_id; the
 * DB `oauth_clients` table exists only for future dynamic registration.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  getRegisteredClient,
  validateRedirectUri,
  PAGESPACE_CLI_CLIENT_ID,
  registeredClientFromRecord,
  resolveClientFrom,
  type OAuthClientRecord,
} from '../clients';

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

// ---------------------------------------------------------------------------
// DB-backed third-party clients (ADR 0004 Decision 2, Phase 1a leaf 2)
// ---------------------------------------------------------------------------

function record(overrides: Partial<OAuthClientRecord> = {}): OAuthClientRecord {
  return {
    clientId: 'app_swipesend',
    name: 'SwipeSend',
    clientType: 'public',
    redirectUris: ['swipesend://callback'],
    allowedGrantTypes: ['authorization_code', 'refresh_token'],
    allowedScopes: ['profile', 'drive:member', 'offline_access'],
    logoUrl: 'https://swipesend.app/logo.png',
    homepageUrl: 'https://swipesend.app',
    description: 'Swipe to send',
    ownerUserId: 'user-1',
    verified: false,
    isFirstParty: false,
    disabledAt: null,
    ...overrides,
  };
}

describe('registeredClientFromRecord', () => {
  it('maps an enabled public row to a third-party RegisteredClient, field for field', () => {
    expect(registeredClientFromRecord(record())).toEqual({
      clientId: 'app_swipesend',
      name: 'SwipeSend',
      type: 'public',
      redirectUris: ['swipesend://callback'],
      allowedGrantTypes: ['authorization_code', 'refresh_token'],
      allowedScopes: ['profile', 'drive:member', 'offline_access'],
      firstParty: false,
      verified: false,
      logoUrl: 'https://swipesend.app/logo.png',
      homepageUrl: 'https://swipesend.app',
      description: 'Swipe to send',
      ownerUserId: 'user-1',
    });
  });

  it('omits absent presentation fields rather than carrying nulls', () => {
    const client = registeredClientFromRecord(record({ logoUrl: null, homepageUrl: null, description: null, ownerUserId: null }));
    expect(client).not.toBeNull();
    expect(client).not.toHaveProperty('logoUrl');
    expect(client).not.toHaveProperty('homepageUrl');
    expect(client).not.toHaveProperty('description');
    expect(client).not.toHaveProperty('ownerUserId');
  });

  it('is never firstParty, whatever the row says — first-party clients exist only in code', () => {
    expect(registeredClientFromRecord(record({ isFirstParty: true }))?.firstParty).toBe(false);
  });

  it('carries verified through', () => {
    expect(registeredClientFromRecord(record({ verified: true }))?.verified).toBe(true);
  });

  it('returns null for a disabled row', () => {
    expect(registeredClientFromRecord(record({ disabledAt: new Date('2026-01-01T00:00:00Z') }))).toBeNull();
  });

  it('returns null for a confidential row — public clients only (ADR 0004 Decision 1)', () => {
    expect(registeredClientFromRecord(record({ clientType: 'confidential' }))).toBeNull();
  });

  it('copies the lists, so a caller mutating the client cannot write through to the record', () => {
    const source = record();
    const client = registeredClientFromRecord(source)!;
    client.redirectUris.push('evil://x');
    client.allowedScopes?.push('account');
    expect(source.redirectUris).toEqual(['swipesend://callback']);
    expect(source.allowedScopes).toEqual(['profile', 'drive:member', 'offline_access']);
  });
});

describe('resolveClientFrom — static registry first, then the database', () => {
  it('returns the static first-party client without touching the database', async () => {
    const lookup = vi.fn();
    const client = await resolveClientFrom(PAGESPACE_CLI_CLIENT_ID, lookup);
    expect(client).toBe(getRegisteredClient(PAGESPACE_CLI_CLIENT_ID));
    expect(lookup).not.toHaveBeenCalled();
  });

  it('never lets a database row shadow a static client id', async () => {
    const lookup = vi.fn().mockResolvedValue(record({ clientId: PAGESPACE_CLI_CLIENT_ID, name: 'Impostor' }));
    const client = await resolveClientFrom(PAGESPACE_CLI_CLIENT_ID, lookup);
    expect(client?.name).toBe('PageSpace CLI');
    expect(client?.firstParty).toBe(true);
  });

  it('falls through to the database for a non-static id', async () => {
    const lookup = vi.fn().mockResolvedValue(record());
    const client = await resolveClientFrom('app_swipesend', lookup);
    expect(lookup).toHaveBeenCalledWith('app_swipesend');
    expect(client?.clientId).toBe('app_swipesend');
    expect(client?.firstParty).toBe(false);
  });

  it('an unknown client and a disabled client are indistinguishable — both null', async () => {
    const unknown = await resolveClientFrom('app_nope', vi.fn().mockResolvedValue(null));
    const disabled = await resolveClientFrom(
      'app_swipesend',
      vi.fn().mockResolvedValue(record({ disabledAt: new Date('2026-01-01T00:00:00Z') })),
    );
    expect(unknown).toBeNull();
    expect(disabled).toBeNull();
    expect(disabled).toStrictEqual(unknown);
  });

  it('never trusts a row whose clientId differs from the one asked for', async () => {
    const client = await resolveClientFrom('app_swipesend', vi.fn().mockResolvedValue(record({ clientId: 'app_other' })));
    expect(client).toBeNull();
  });

  it('returns null for an empty client id without a lookup', async () => {
    const lookup = vi.fn();
    expect(await resolveClientFrom('', lookup)).toBeNull();
    expect(lookup).not.toHaveBeenCalled();
  });
});

