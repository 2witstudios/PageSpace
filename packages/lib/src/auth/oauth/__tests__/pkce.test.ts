/**
 * Provider-side PKCE S256 verification (OAuth 2.1 authorization server).
 *
 * Divergence from `packages/lib/src/auth/pkce.ts` (deliberate, per ADR 0003 §1.7
 * / ADR 0002 Decision 3): that module is PageSpace acting as an OAuth *client*
 * to Google/Apple and is fail-open by design (DB down → flow proceeds without
 * PKCE, see its own docstring). It stores verifiers in Postgres and has no
 * `verifyPkceChallenge`-shaped export at all — there is nothing inert to
 * extract; it is a full generate/store/consume flow, not a pure comparator.
 * This module is the new fail-closed, zero-I/O provider-side counterpart.
 */

import { describe, it, expect } from 'vitest';
import {
  verifyPkceChallenge,
  generateCodeVerifier,
  deriveCodeChallenge,
  isValidCodeVerifier,
} from '../pkce';

// RFC 7636 Appendix B — the spec's own worked example, verbatim.
const RFC_7636_APPENDIX_B_VERIFIER = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';
const RFC_7636_APPENDIX_B_CHALLENGE = 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM';

describe('verifyPkceChallenge', () => {
  it('given the RFC 7636 Appendix B vector with method S256, returns true', () => {
    expect(
      verifyPkceChallenge(RFC_7636_APPENDIX_B_VERIFIER, RFC_7636_APPENDIX_B_CHALLENGE, 'S256'),
    ).toBe(true);
  });

  it('given method "plain", returns false even when verifier equals challenge', () => {
    const verifier = 'a'.repeat(43);
    expect(verifyPkceChallenge(verifier, verifier, 'plain')).toBe(false);
  });

  it('given an unknown method string, returns false', () => {
    expect(
      verifyPkceChallenge(RFC_7636_APPENDIX_B_VERIFIER, RFC_7636_APPENDIX_B_CHALLENGE, 'sha256'),
    ).toBe(false);
  });

  it('given method "S256" with wrong case, returns false (no case-insensitive fallback)', () => {
    expect(
      verifyPkceChallenge(RFC_7636_APPENDIX_B_VERIFIER, RFC_7636_APPENDIX_B_CHALLENGE, 's256'),
    ).toBe(false);
  });

  it('given an absent/undefined method, returns false', () => {
    expect(
      verifyPkceChallenge(RFC_7636_APPENDIX_B_VERIFIER, RFC_7636_APPENDIX_B_CHALLENGE, undefined),
    ).toBe(false);
  });

  it('given a null method, returns false', () => {
    expect(
      verifyPkceChallenge(RFC_7636_APPENDIX_B_VERIFIER, RFC_7636_APPENDIX_B_CHALLENGE, null),
    ).toBe(false);
  });

  it('given a verifier one char under the RFC 7636 §4.1 minimum length (42), rejects before hashing', () => {
    const shortVerifier = 'a'.repeat(42);
    // Challenge deliberately matches nothing real — a false result here proves
    // shape validation runs, not that the hash happened not to collide.
    expect(verifyPkceChallenge(shortVerifier, deriveCodeChallenge(shortVerifier + 'a'), 'S256')).toBe(
      false,
    );
  });

  it('given a verifier one char over the RFC 7636 §4.1 maximum length (129), rejects before hashing', () => {
    const longVerifier = 'a'.repeat(129);
    expect(verifyPkceChallenge(longVerifier, deriveCodeChallenge(longVerifier), 'S256')).toBe(false);
  });

  it('given a verifier with an out-of-charset character (+ is base64 std, not base64url), rejects', () => {
    const badVerifier = '+'.repeat(43);
    expect(verifyPkceChallenge(badVerifier, deriveCodeChallenge(badVerifier), 'S256')).toBe(false);
  });

  it('given a verifier with base64 padding (=), rejects', () => {
    const badVerifier = 'a'.repeat(42) + '=';
    expect(verifyPkceChallenge(badVerifier, deriveCodeChallenge(badVerifier), 'S256')).toBe(false);
  });

  it('given a verifier containing a space, rejects', () => {
    const badVerifier = 'a'.repeat(21) + ' ' + 'a'.repeat(21);
    expect(verifyPkceChallenge(badVerifier, deriveCodeChallenge(badVerifier), 'S256')).toBe(false);
  });

  it('given a valid verifier at the exact minimum length (43), accepts a correctly derived challenge', () => {
    const verifier = 'a'.repeat(43);
    expect(verifyPkceChallenge(verifier, deriveCodeChallenge(verifier), 'S256')).toBe(true);
  });

  it('given a valid verifier at the exact maximum length (128), accepts a correctly derived challenge', () => {
    const verifier = 'a'.repeat(128);
    expect(verifyPkceChallenge(verifier, deriveCodeChallenge(verifier), 'S256')).toBe(true);
  });

  it('given a tampered challenge (one char flipped), returns false', () => {
    const lastChar = RFC_7636_APPENDIX_B_CHALLENGE[RFC_7636_APPENDIX_B_CHALLENGE.length - 1];
    const tampered =
      RFC_7636_APPENDIX_B_CHALLENGE.slice(0, -1) + (lastChar === 'M' ? 'N' : 'M');
    expect(verifyPkceChallenge(RFC_7636_APPENDIX_B_VERIFIER, tampered, 'S256')).toBe(false);
  });

  it('given a non-string verifier, returns false without throwing', () => {
    expect(verifyPkceChallenge(12345 as unknown as string, RFC_7636_APPENDIX_B_CHALLENGE, 'S256')).toBe(
      false,
    );
  });

  it('given a non-string challenge, returns false without throwing', () => {
    expect(
      verifyPkceChallenge(RFC_7636_APPENDIX_B_VERIFIER, null as unknown as string, 'S256'),
    ).toBe(false);
  });

  it('given an empty challenge, returns false', () => {
    expect(verifyPkceChallenge(RFC_7636_APPENDIX_B_VERIFIER, '', 'S256')).toBe(false);
  });
});

describe('isValidCodeVerifier', () => {
  it('accepts the RFC 7636 Appendix B verifier', () => {
    expect(isValidCodeVerifier(RFC_7636_APPENDIX_B_VERIFIER)).toBe(true);
  });

  it('rejects a verifier below 43 chars', () => {
    expect(isValidCodeVerifier('a'.repeat(42))).toBe(false);
  });

  it('rejects a verifier above 128 chars', () => {
    expect(isValidCodeVerifier('a'.repeat(129))).toBe(false);
  });

  it('accepts the full RFC 7636 §4.1 unreserved charset boundary characters', () => {
    // charset is [A-Za-z0-9-._~]; pad to a valid length with 'a'.
    const verifier = ('-._~' + 'a'.repeat(39)).slice(0, 43);
    expect(isValidCodeVerifier(verifier)).toBe(true);
  });
});

describe('generateCodeVerifier', () => {
  it('is deterministic given the same injected random bytes', () => {
    const fixedBytes = Buffer.from(Array.from({ length: 32 }, (_, i) => i));
    const first = generateCodeVerifier(fixedBytes);
    const second = generateCodeVerifier(fixedBytes);
    expect(first).toBe(second);
  });

  it('matches base64url(bytes) for the injected randomness (no hidden extra entropy source)', () => {
    const fixedBytes = Buffer.from(Array.from({ length: 32 }, (_, i) => i));
    expect(generateCodeVerifier(fixedBytes)).toBe(fixedBytes.toString('base64url'));
  });

  it('produces output that is itself a valid RFC 7636 §4.1 code verifier', () => {
    const fixedBytes = Buffer.from(Array.from({ length: 32 }, (_, i) => i));
    expect(isValidCodeVerifier(generateCodeVerifier(fixedBytes))).toBe(true);
  });

  it('produces different output for different injected bytes', () => {
    const bytesA = Buffer.from(Array.from({ length: 32 }, (_, i) => i));
    const bytesB = Buffer.from(Array.from({ length: 32 }, (_, i) => i + 1));
    expect(generateCodeVerifier(bytesA)).not.toBe(generateCodeVerifier(bytesB));
  });
});

describe('deriveCodeChallenge', () => {
  it('derives the RFC 7636 Appendix B challenge from its verifier', () => {
    expect(deriveCodeChallenge(RFC_7636_APPENDIX_B_VERIFIER)).toBe(RFC_7636_APPENDIX_B_CHALLENGE);
  });

  it('is deterministic (pure — same input, same output)', () => {
    expect(deriveCodeChallenge(RFC_7636_APPENDIX_B_VERIFIER)).toBe(
      deriveCodeChallenge(RFC_7636_APPENDIX_B_VERIFIER),
    );
  });
});

describe('full round trip (generation -> derivation -> verification)', () => {
  it('a freshly generated verifier and its derived challenge verify successfully under S256', () => {
    const fixedBytes = Buffer.from(Array.from({ length: 32 }, (_, i) => 31 - i));
    const verifier = generateCodeVerifier(fixedBytes);
    const challenge = deriveCodeChallenge(verifier);
    expect(verifyPkceChallenge(verifier, challenge, 'S256')).toBe(true);
  });
});
