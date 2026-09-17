import { describe, it, expect, vi } from 'vitest';
import { generateKeyPairSync } from 'crypto';
import { createAppleKeyProvider } from '../apple-jwks';

const rsaJwk = (kid: string) => {
  const jwk = generateKeyPairSync('rsa', { modulusLength: 2048 }).publicKey.export({ format: 'jwk' });
  return { kty: 'RSA', kid, use: 'sig', alg: 'RS256', n: jwk.n, e: jwk.e };
};

const jwksResponse = (...keys: unknown[]) => new Response(JSON.stringify({ keys }), { status: 200 });

describe('createAppleKeyProvider', () => {
  it('given a kid Apple publishes, should fetch the key set once and serve later lookups from cache', async () => {
    const fetchJwks = vi.fn().mockResolvedValue(jwksResponse(rsaJwk('k1'), rsaJwk('k2')));
    const provider = createAppleKeyProvider({ fetchJwks, now: () => 0 });

    expect(await provider.getKey('k1')).not.toBeNull();
    expect(await provider.getKey('k2')).not.toBeNull();
    expect(fetchJwks).toHaveBeenCalledTimes(1);
  });

  it('given an unknown kid within the refresh window, should not fetch again', async () => {
    let clock = 0;
    const fetchJwks = vi.fn().mockResolvedValue(jwksResponse(rsaJwk('k1')));
    const provider = createAppleKeyProvider({ fetchJwks, now: () => clock });
    await provider.getKey('k1');

    clock = 60_000;
    expect(await provider.getKey('forged-kid-1')).toBeNull();
    expect(await provider.getKey('forged-kid-2')).toBeNull();

    expect(fetchJwks).toHaveBeenCalledTimes(1);
  });

  it('given an unknown kid after the refresh window, should refresh once to pick up a rotated key', async () => {
    let clock = 0;
    const fetchJwks = vi
      .fn()
      .mockResolvedValueOnce(jwksResponse(rsaJwk('k1')))
      .mockResolvedValueOnce(jwksResponse(rsaJwk('k1'), rsaJwk('k-rotated')));
    const provider = createAppleKeyProvider({ fetchJwks, now: () => clock });
    await provider.getKey('k1');

    clock = 5 * 60_000 + 1;
    expect(await provider.getKey('k-rotated')).not.toBeNull();
    expect(fetchJwks).toHaveBeenCalledTimes(2);
  });

  it.each([
    ['a throttled response', () => Promise.resolve(new Response('slow down', { status: 429 }))],
    ['a malformed body', () => Promise.resolve(new Response('{"nope":true}', { status: 200 }))],
    ['a key set with no usable keys', () => Promise.resolve(jwksResponse({ kty: 'EC', kid: 'x' }))],
    ['a network timeout', () => Promise.reject(new DOMException('timeout', 'TimeoutError'))],
  ])('given %s on refresh, should keep the previously cached keys', async (_label, failure) => {
    let clock = 0;
    const fetchJwks = vi.fn().mockResolvedValueOnce(jwksResponse(rsaJwk('k1'))).mockImplementationOnce(failure);
    const provider = createAppleKeyProvider({ fetchJwks, now: () => clock });
    await provider.getKey('k1');

    clock = 10 * 60_000;
    expect(await provider.getKey('unknown')).toBeNull();

    expect(await provider.getKey('k1')).not.toBeNull();
    expect(fetchJwks).toHaveBeenCalledTimes(2);
  });

  it('given concurrent lookups for unknown kids, should share a single fetch', async () => {
    let release: (r: Response) => void = () => {};
    const fetchJwks = vi.fn().mockReturnValue(new Promise<Response>((resolve) => (release = resolve)));
    const provider = createAppleKeyProvider({ fetchJwks, now: () => 0 });

    const lookups = [provider.getKey('a'), provider.getKey('b'), provider.getKey('k1')];
    release(jwksResponse(rsaJwk('k1')));
    const [a, b, k1] = await Promise.all(lookups);

    expect(fetchJwks).toHaveBeenCalledTimes(1);
    expect(a).toBeNull();
    expect(b).toBeNull();
    expect(k1).not.toBeNull();
  });

  it('given the first fetch fails, should not retry until the window passes', async () => {
    let clock = 0;
    const fetchJwks = vi.fn().mockRejectedValue(new TypeError('fetch failed'));
    const provider = createAppleKeyProvider({ fetchJwks, now: () => clock });

    expect(await provider.getKey('k1')).toBeNull();
    clock = 1000;
    expect(await provider.getKey('k1')).toBeNull();

    expect(fetchJwks).toHaveBeenCalledTimes(1);
  });
});
