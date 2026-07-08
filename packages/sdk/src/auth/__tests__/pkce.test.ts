import { describe, expect, it } from 'vitest';
import { deriveCodeChallenge, generateCodeVerifier } from '../pkce.js';

describe('generateCodeVerifier', () => {
  it('base64url-encodes the injected random bytes with no padding', () => {
    const bytes = new Uint8Array(32).fill(0);
    const verifier = generateCodeVerifier(bytes);
    expect(verifier).toBe(Buffer.from(bytes).toString('base64url'));
    expect(verifier).not.toContain('=');
    expect(verifier).not.toContain('+');
    expect(verifier).not.toContain('/');
  });

  it('is pure — same bytes in, same verifier out, every time', () => {
    const bytes = new Uint8Array(32).fill(0).map((_, i) => i);
    expect(generateCodeVerifier(bytes)).toBe(generateCodeVerifier(bytes));
  });

  it('produces a 43-char verifier for 32 injected octets (RFC 7636 §4.1 recommendation)', () => {
    const bytes = new Uint8Array(32).fill(7);
    expect(generateCodeVerifier(bytes)).toHaveLength(43);
  });

  it('produces a 128-char verifier for 96 injected octets (the upper bound)', () => {
    const bytes = new Uint8Array(96).fill(7);
    expect(generateCodeVerifier(bytes)).toHaveLength(128);
  });

  it('rejects fewer than 32 bytes — RFC 7636 §4.1 requires a >=43-char code_verifier', () => {
    expect(() => generateCodeVerifier(new Uint8Array(31))).toThrow(RangeError);
    expect(() => generateCodeVerifier(new Uint8Array(0))).toThrow(RangeError);
  });

  it('rejects more than 96 bytes — RFC 7636 §4.1 caps code_verifier at 128 chars', () => {
    expect(() => generateCodeVerifier(new Uint8Array(97))).toThrow(RangeError);
  });

  it('accepts every byte count in the valid 32-96 range without throwing', () => {
    for (const n of [32, 48, 64, 80, 96]) {
      expect(() => generateCodeVerifier(new Uint8Array(n))).not.toThrow();
    }
  });
});

describe('deriveCodeChallenge', () => {
  it('derives BASE64URL(SHA256(ASCII(verifier)))', async () => {
    // Known RFC 7636 Appendix B test vector.
    const verifier = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';
    await expect(deriveCodeChallenge(verifier)).resolves.toBe('E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM');
  });

  it('is pure — same verifier in, same challenge out, every time', async () => {
    const verifier = 'a-fixed-verifier-string-for-determinism-check';
    expect(await deriveCodeChallenge(verifier)).toBe(await deriveCodeChallenge(verifier));
  });

  it('produces a challenge with no padding characters', async () => {
    const challenge = await deriveCodeChallenge('some-arbitrary-verifier-value-1234567890');
    expect(challenge).not.toContain('=');
  });
});
