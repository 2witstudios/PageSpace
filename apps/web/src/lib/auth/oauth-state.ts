import crypto from 'crypto';

export interface OAuthStateData {
  returnUrl?: string;
  platform?: 'web' | 'desktop' | 'ios';
  deviceId?: string;
  deviceName?: string;
}

export type VerifyOAuthStateResult =
  | { status: 'valid'; data: OAuthStateData }
  | { status: 'invalid_signature' }
  | { status: 'unsigned'; returnUrl?: string }
  | { status: 'malformed' };

/**
 * Verify an HMAC-signed OAuth state parameter.
 * Returns a discriminated result so callers can handle each case appropriately:
 * - 'valid': signature verified, data is trustworthy
 * - 'invalid_signature': sig field present but doesn't match (reject)
 * - 'unsigned': parseable JSON but no sig field (safe defaults)
 * - 'malformed': unparseable (safe defaults)
 *
 * Uses timing-safe comparison to prevent timing attacks.
 */
export function verifyOAuthState(stateBase64: string): VerifyOAuthStateResult {
  const secret = process.env.OAUTH_STATE_SECRET;

  try {
    const parsed = JSON.parse(Buffer.from(stateBase64, 'base64').toString('utf-8'));

    if (!parsed.data || !parsed.sig) {
      // No signature — treat as unsigned legacy state
      return { status: 'unsigned', returnUrl: parsed.returnUrl };
    }

    if (!secret) {
      return { status: 'invalid_signature' };
    }

    const { data, sig } = parsed;
    const expected = crypto
      .createHmac('sha256', secret)
      .update(JSON.stringify(data))
      .digest('hex');

    // Timing-safe comparison to prevent timing attacks
    if (expected.length !== sig.length) {
      return { status: 'invalid_signature' };
    }

    const isValid = crypto.timingSafeEqual(
      Buffer.from(expected, 'utf-8'),
      Buffer.from(sig, 'utf-8'),
    );

    return isValid
      ? { status: 'valid', data }
      : { status: 'invalid_signature' };
  } catch {
    return { status: 'malformed' };
  }
}

/**
 * Check if an OAuth state indicates a desktop platform request.
 * Only trusts the platform field if the HMAC signature is valid.
 */
export function isDesktopOAuthState(stateBase64: string | null | undefined): boolean {
  if (!stateBase64) return false;
  const result = verifyOAuthState(stateBase64);
  return result.status === 'valid' && result.data.platform === 'desktop';
}
