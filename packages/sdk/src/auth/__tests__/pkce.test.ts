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
    const bytes = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(generateCodeVerifier(bytes)).toBe(generateCodeVerifier(bytes));
  });

  it('produces a 43-char verifier for 32 injected octets (RFC 7636 §4.1 recommendation)', () => {
    const bytes = new Uint8Array(32).fill(7);
    expect(generateCodeVerifier(bytes)).toHaveLength(43);
  });
});

describe('deriveCodeChallenge', () => {
  it('derives BASE64URL(SHA256(ASCII(verifier)))', () => {
    // Known RFC 7636 Appendix B test vector.
    const verifier = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';
    expect(deriveCodeChallenge(verifier)).toBe('E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM');
  });

  it('is pure — same verifier in, same challenge out, every time', () => {
    const verifier = 'a-fixed-verifier-string-for-determinism-check';
    expect(deriveCodeChallenge(verifier)).toBe(deriveCodeChallenge(verifier));
  });

  it('produces a challenge with no padding characters', () => {
    const challenge = deriveCodeChallenge('some-arbitrary-verifier-value-1234567890');
    expect(challenge).not.toContain('=');
  });
});
