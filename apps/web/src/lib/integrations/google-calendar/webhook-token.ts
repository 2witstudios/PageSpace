/**
 * Webhook Token Authentication
 *
 * Generates and verifies HMAC tokens for Google Calendar push notification webhooks.
 * Google echoes back the token we provide during watch() registration via
 * the X-Goog-Channel-Token header, allowing us to authenticate notifications
 * without scanning all connections.
 */

import crypto from 'crypto';

/**
 * Generate an HMAC token for webhook authentication.
 * Token encodes the userId so we can identify the user without a DB lookup.
 */
export const generateWebhookToken = (userId: string): string => {
  const secret = process.env.OAUTH_STATE_SECRET;
  if (!secret) return '';

  const signature = crypto
    .createHmac('sha256', secret)
    .update(`webhook:${userId}`)
    .digest('hex');

  // Format: userId.signature (userId is needed for verification)
  return `${userId}.${signature}`;
};

/**
 * Verify a webhook token and extract the userId.
 * Returns the userId if valid, null if invalid or missing secret.
 */
export const verifyWebhookToken = (token: string): string | null => {
  const secret = process.env.OAUTH_STATE_SECRET;
  if (!secret || !token) return null;

  const dotIndex = token.indexOf('.');
  if (dotIndex === -1) return null;

  const userId = token.slice(0, dotIndex);
  const signature = token.slice(dotIndex + 1);

  const expectedSignature = crypto
    .createHmac('sha256', secret)
    .update(`webhook:${userId}`)
    .digest('hex');

  // Timing-safe comparison to prevent timing attacks
  try {
    const sigBuffer = Buffer.from(signature, 'hex');
    const expectedBuffer = Buffer.from(expectedSignature, 'hex');
    if (sigBuffer.length !== expectedBuffer.length) return null;
    if (!crypto.timingSafeEqual(sigBuffer, expectedBuffer)) return null;
  } catch {
    return null;
  }

  return userId;
};
