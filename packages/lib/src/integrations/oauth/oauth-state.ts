/**
 * OAuth State Utilities
 *
 * Signed state parameter for CSRF protection during OAuth flows.
 * Extracts the HMAC pattern from Google Calendar connect/callback
 * into reusable functions.
 */

import crypto from 'crypto';
import { secureCompare } from '../../auth/secure-compare';

// State expiration: 10 minutes
const STATE_MAX_AGE_MS = 10 * 60 * 1000;

/**
 * Create a signed state parameter for OAuth flows.
 *
 * Uses HMAC-SHA256 for message authentication (not password hashing).
 *
 * @param data - Arbitrary data to include in the state (userId, returnUrl, etc.)
 * @param signingKey - HMAC signing key (e.g., process.env.OAUTH_STATE_SECRET)
 * @returns Base64-encoded signed state string
 */
export function createSignedState(
  data: Record<string, unknown>,
  signingKey: string
): string {
  const stateData = {
    ...data,
    timestamp: Date.now(),
  };

  const statePayload = JSON.stringify(stateData);
  const signature = crypto
    .createHmac('sha256', signingKey)
    .update(statePayload)
    .digest('hex');

  const stateWithSignature = JSON.stringify({ data: stateData, sig: signature });
  return Buffer.from(stateWithSignature).toString('base64');
}

/**
 * Verify and decode a signed state parameter.
 *
 * Uses HMAC-SHA256 for message authentication (not password hashing).
 *
 * @param state - Base64-encoded signed state string
 * @param signingKey - HMAC signing key (same as used in createSignedState)
 * @returns Decoded data if valid, null if invalid or expired
 */
export function verifySignedState<T extends Record<string, unknown> = Record<string, unknown>>(
  state: string,
  signingKey: string
): (T & { timestamp: number }) | null {
  try {
    const stateWithSignature = JSON.parse(Buffer.from(state, 'base64').toString('utf-8'));

    if (!stateWithSignature.data || !stateWithSignature.sig) {
      return null;
    }

    const expectedSignature = crypto
      .createHmac('sha256', signingKey)
      .update(JSON.stringify(stateWithSignature.data))
      .digest('hex');

    if (!secureCompare(String(stateWithSignature.sig), expectedSignature)) {
      return null;
    }

    const data = stateWithSignature.data;

    // Reject state with missing or invalid timestamp
    if (typeof data.timestamp !== 'number' || !Number.isFinite(data.timestamp)) {
      return null;
    }

    // Check state expiration
    if (Date.now() - data.timestamp > STATE_MAX_AGE_MS) {
      return null;
    }

    return data as T & { timestamp: number };
  } catch {
    return null;
  }
}
