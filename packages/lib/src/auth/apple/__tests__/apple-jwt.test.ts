import { describe, it, expect, vi } from 'vitest';
import { generateKeyPairSync, sign, type KeyObject } from 'crypto';
import { verifyAppleJwt } from '../apple-jwt';

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const keys = { getKey: vi.fn(async (kid: string): Promise<KeyObject | null> => (kid === 'k1' ? publicKey : null)) };
const now = Math.floor(Date.now() / 1000);

function signJwt(header: Record<string, unknown>, claims: Record<string, unknown>, key = privateKey): string {
  const h = Buffer.from(JSON.stringify(header)).toString('base64url');
  const p = Buffer.from(JSON.stringify(claims)).toString('base64url');
  return `${h}.${p}.${sign('sha256', Buffer.from(`${h}.${p}`), key).toString('base64url')}`;
}

const claims = (overrides: Record<string, unknown> = {}) => ({
  iss: 'https://appleid.apple.com',
  aud: 'ai.pagespace.ios',
  sub: 'apple-sub-1',
  iat: now,
  exp: now + 300,
  ...overrides,
});
const opts = { audience: ['ai.pagespace.ios', 'ai.pagespace.web'], keys };

describe('verifyAppleJwt', () => {
  it('given a token Apple signed for one of our clients, should return its claims', async () => {
    const result = await verifyAppleJwt(signJwt({ alg: 'RS256', kid: 'k1' }, claims()), opts);

    expect(result).toEqual({ ok: true, claims: claims() });
  });

  it.each([
    ['a wrong issuer', claims({ iss: 'https://evil.example' }), 'invalid_issuer'],
    ['another app as audience', claims({ aud: 'com.someone.else' }), 'invalid_audience'],
    ['an expired token', claims({ iat: now - 900, exp: now - 600 }), 'expired'],
    ['no expiry', (() => { const c: Record<string, unknown> = claims(); delete c.exp; return c; })(), 'missing_exp'],
    ['a not-yet-valid token', claims({ nbf: now + 3600 }), 'not_yet_valid'],
  ])('given %s, should reject it', async (_label, body, reason) => {
    expect(await verifyAppleJwt(signJwt({ alg: 'RS256', kid: 'k1' }, body), opts)).toEqual({ ok: false, reason });
  });

  it('given an audience array containing one of our clients, should accept it', async () => {
    const result = await verifyAppleJwt(signJwt({ alg: 'RS256', kid: 'k1' }, claims({ aud: ['x', 'ai.pagespace.web'] })), opts);
    expect(result.ok).toBe(true);
  });

  it('given a signature from a key that is not Apple\'s, should reject it', async () => {
    const forger = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey;
    expect(await verifyAppleJwt(signJwt({ alg: 'RS256', kid: 'k1' }, claims(), forger), opts)).toEqual({ ok: false, reason: 'invalid_signature' });
  });

  it.each([
    ['alg none', { alg: 'none', kid: 'k1' }],
    ['HS256', { alg: 'HS256', kid: 'k1' }],
  ])('given %s, should reject it without looking up a key', async (_label, header) => {
    keys.getKey.mockClear();
    expect(await verifyAppleJwt(signJwt(header, claims()), opts)).toEqual({ ok: false, reason: 'unsupported_alg' });
    expect(keys.getKey).not.toHaveBeenCalled();
  });

  it('given a kid Apple does not publish, should reject it', async () => {
    expect(await verifyAppleJwt(signJwt({ alg: 'RS256', kid: 'unknown' }, claims()), opts)).toEqual({ ok: false, reason: 'unknown_kid' });
  });

  it.each(['', 'not-a-jwt', 'a.b', '!!!.@@@.###'])('given malformed input %j, should reject it', async (token) => {
    expect((await verifyAppleJwt(token, opts)).ok).toBe(false);
  });
});
