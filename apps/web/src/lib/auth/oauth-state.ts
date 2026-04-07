import crypto from 'crypto';

export interface OAuthStateData {
  returnUrl?: string;
  platform?: 'web' | 'desktop';
  deviceId?: string;
  deviceName?: string;
}

/**
 * Verify an HMAC-signed OAuth state parameter.
 * Returns the decoded data if signature is valid, null otherwise.
 * Uses timing-safe comparison to prevent timing attacks.
 */
export function verifyOAuthState(stateBase64: string): OAuthStateData | null {
  const secret = process.env.OAUTH_STATE_SECRET;
  if (!secret) return null;

  try {
    const parsed = JSON.parse(Buffer.from(stateBase64, 'base64').toString('utf-8'));
    if (!parsed.data || !parsed.sig) return null;

    const { data, sig } = parsed;
    const expected = crypto
      .createHmac('sha256', secret)
      .update(JSON.stringify(data))
      .digest('hex');

    // Timing-safe comparison to prevent timing attacks
    if (expected.length !== sig.length) return null;
    const isValid = crypto.timingSafeEqual(
      Buffer.from(expected, 'utf-8'),
      Buffer.from(sig, 'utf-8'),
    );

    return isValid ? data : null;
  } catch {
    return null;
  }
}

/**
 * Check if an OAuth state indicates a desktop platform request.
 * Only trusts the platform field if the HMAC signature is valid.
 */
export function isDesktopOAuthState(stateBase64: string | null | undefined): boolean {
  if (!stateBase64) return false;
  const data = verifyOAuthState(stateBase64);
  return data?.platform === 'desktop';
}
