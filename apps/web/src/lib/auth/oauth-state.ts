import crypto from 'crypto';
import { z } from 'zod';
import { secureCompare } from '@pagespace/lib';

// State expires after 10 minutes — prevents replay attacks
const STATE_MAX_AGE_MS = 10 * 60 * 1000;

const oauthStateDataSchema = z.object({
  returnUrl: z.string().max(2048).optional(),
  platform: z.enum(['web', 'desktop', 'ios']).optional(),
  deviceId: z.string().min(1).max(128).optional(),
  deviceName: z.string().max(255).optional(),
  timestamp: z.number().finite(),
});

export type OAuthStateData = z.infer<typeof oauthStateDataSchema>;

export type VerifyOAuthStateResult =
  | { status: 'valid'; data: OAuthStateData }
  | { status: 'invalid_signature' }
  | { status: 'expired' }
  | { status: 'unsigned'; returnUrl?: string }
  | { status: 'malformed' };

/**
 * Verify an HMAC-signed OAuth state parameter.
 * Returns a discriminated result so callers can handle each case appropriately:
 * - 'valid': signature verified AND payload matches the expected schema
 * - 'invalid_signature': sig field present but doesn't match (reject)
 * - 'unsigned': parseable JSON but no sig field (safe defaults)
 * - 'malformed': unparseable, or HMAC-verified payload that fails schema narrowing
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

    if (!secureCompare(String(sig), expected)) {
      return { status: 'invalid_signature' };
    }

    // Schema validation AFTER HMAC verification — the HMAC proves authenticity
    // but not shape. Narrow to an explicit Zod schema so every caller (and
    // CodeQL's dataflow engine) sees a sanitized trust boundary.
    const parsedResult = oauthStateDataSchema.safeParse(data);
    if (!parsedResult.success) {
      return { status: 'malformed' };
    }

    if (Date.now() - parsedResult.data.timestamp > STATE_MAX_AGE_MS) {
      return { status: 'expired' };
    }

    return { status: 'valid', data: parsedResult.data };
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
