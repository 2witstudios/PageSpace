/**
 * Verify a JWT signed by Apple (Sign in with Apple identity tokens and
 * server-to-server notifications): RS256 only, a signing key from the shared
 * PageSpace-owned JWKS cache, issuer https://appleid.apple.com, one of our
 * client ids as audience, and a required, unexpired `exp`.
 *
 * Returns a reason code instead of throwing, and never echoes token contents.
 */
import { verify } from 'crypto';
import { appleKeyProvider, type AppleKeyProvider } from './apple-jwks';

const APPLE_ISSUER = 'https://appleid.apple.com';
/** Tolerated clock skew between Apple and us. */
const CLOCK_SKEW_SECONDS = 60;

export type AppleJwtClaims = Record<string, unknown>;

export type AppleJwtVerification = { ok: true; claims: AppleJwtClaims } | { ok: false; reason: string };

const decodeSegment = (segment: string): unknown => JSON.parse(Buffer.from(segment, 'base64url').toString('utf8'));

export async function verifyAppleJwt(
  token: string,
  options: { audience: readonly string[]; keys?: AppleKeyProvider },
): Promise<AppleJwtVerification> {
  const parts = token.split('.');
  if (parts.length !== 3 || parts.some((part) => part.length === 0)) return { ok: false, reason: 'malformed' };
  const [headerSegment, payloadSegment, signatureSegment] = parts;

  let header: { alg?: unknown; kid?: unknown };
  let claims: AppleJwtClaims;
  try {
    header = decodeSegment(headerSegment) as { alg?: unknown; kid?: unknown };
    const decoded = decodeSegment(payloadSegment);
    if (typeof decoded !== 'object' || decoded === null || Array.isArray(decoded)) return { ok: false, reason: 'malformed' };
    claims = decoded as AppleJwtClaims;
  } catch {
    return { ok: false, reason: 'malformed' };
  }

  if (header.alg !== 'RS256') return { ok: false, reason: 'unsupported_alg' };
  if (typeof header.kid !== 'string') return { ok: false, reason: 'unknown_kid' };

  const key = await (options.keys ?? appleKeyProvider).getKey(header.kid);
  if (!key) return { ok: false, reason: 'unknown_kid' };

  const signatureValid = verify(
    'sha256',
    Buffer.from(`${headerSegment}.${payloadSegment}`),
    key,
    Buffer.from(signatureSegment, 'base64url'),
  );
  if (!signatureValid) return { ok: false, reason: 'invalid_signature' };

  if (claims.iss !== APPLE_ISSUER) return { ok: false, reason: 'invalid_issuer' };

  const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!audiences.some((aud) => typeof aud === 'string' && options.audience.includes(aud))) {
    return { ok: false, reason: 'invalid_audience' };
  }

  const nowSeconds = Math.floor(Date.now() / 1000);
  if (typeof claims.exp !== 'number') return { ok: false, reason: 'missing_exp' };
  if (claims.exp + CLOCK_SKEW_SECONDS <= nowSeconds) return { ok: false, reason: 'expired' };
  if (typeof claims.nbf === 'number' && claims.nbf - CLOCK_SKEW_SECONDS > nowSeconds) {
    return { ok: false, reason: 'not_yet_valid' };
  }

  return { ok: true, claims };
}
