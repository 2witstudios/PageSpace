/**
 * L2·G2 — the web → credential-plane service signature. The plane accepts
 * ingress (`put`) and management (`revoke`) calls, and executor calls, only
 * from a caller holding the plane's shared service secret; an executor call
 * additionally carries its own signed grant, which is the real authority.
 *
 * The signature binds the method, the path, the SHA-256 of the exact body and
 * a timestamp, so a captured signature cannot be moved to another route, body
 * or (after 60 s) moment. Compare is timing-safe (hash-then-compare).
 */
import { describe, expect, it } from 'vitest';
import { createHash, createHmac } from 'node:crypto';
import { signPlaneRequest, decidePlaneRequestSignature, PLANE_SIGNATURE_MAX_AGE_MS } from '../plane-request-signature';

const hmac = (key: string, text: string) => createHmac('sha256', key).update(text).digest('hex');
const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const SECRET = 'plane-service-secret-0123456789abcdef';
const NOW = 1_800_000_000_000;
const body = new TextEncoder().encode('{"accountId":"acct_1"}');

const header = signPlaneRequest({ method: 'POST', path: '/v1/accounts/revoke', body, secret: SECRET, now: NOW, hmac, sha256 });
const decide = (overrides: Partial<Parameters<typeof decidePlaneRequestSignature>[0]> = {}) =>
  decidePlaneRequestSignature({ header, method: 'POST', path: '/v1/accounts/revoke', body, secret: SECRET, now: NOW, hmac, sha256, ...overrides });

describe('plane request signature', () => {
  it('given a request signed with the secret for this method, path and body, should accept it', () => {
    const actual = decide();
    const expected = { ok: true };
    expect(actual).toEqual(expected);
  });

  it('given the same signature on another path, another method or another body, should refuse bad_signature', () => {
    const actual = [decide({ path: '/v1/accounts/put' }), decide({ method: 'PUT' }), decide({ body: new TextEncoder().encode('{"accountId":"acct_2"}') })];
    const expected = [
      { ok: false, reason: 'bad_signature' },
      { ok: false, reason: 'bad_signature' },
      { ok: false, reason: 'bad_signature' },
    ];
    expect(actual).toEqual(expected);
  });

  it('given a signature under another secret, should refuse bad_signature', () => {
    const actual = decide({ secret: 'another-secret-another-secret-00000' });
    const expected = { ok: false, reason: 'bad_signature' };
    expect(actual).toEqual(expected);
  });

  it('given a signature older than the window or dated in the future beyond it, should refuse stale', () => {
    const actual = [decide({ now: NOW + PLANE_SIGNATURE_MAX_AGE_MS + 1 }), decide({ now: NOW - PLANE_SIGNATURE_MAX_AGE_MS - 1 })];
    const expected = [
      { ok: false, reason: 'stale' },
      { ok: false, reason: 'stale' },
    ];
    expect(actual).toEqual(expected);
  });

  it('given a missing or malformed header, or a secret too short to be one, should refuse', () => {
    const actual = [decide({ header: null }), decide({ header: 'v1=abc' }), decide({ header: 't=notanumber,v1=abc' }), decide({ secret: 'short' })];
    const expected = [
      { ok: false, reason: 'malformed' },
      { ok: false, reason: 'malformed' },
      { ok: false, reason: 'malformed' },
      { ok: false, reason: 'secret_invalid' },
    ];
    expect(actual).toEqual(expected);
  });
});
