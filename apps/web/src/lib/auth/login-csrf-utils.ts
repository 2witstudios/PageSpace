import { randomBytes, createHmac, timingSafeEqual } from 'crypto';

// Constants
export const LOGIN_CSRF_COOKIE_NAME = 'login_csrf';
export const LOGIN_CSRF_MAX_AGE = 300; // 5 minutes
const LOGIN_CSRF_TOKEN_LENGTH = 32;

/**
 * Gets the CSRF secret, with fallback to JWT_SECRET for convenience
 */
function getLoginCSRFSecret(): string {
  const secret = process.env.CSRF_SECRET || process.env.JWT_SECRET;
  if (!secret || secret.length < 32) {
    throw new Error('CSRF_SECRET or JWT_SECRET must be at least 32 characters');
  }
  return secret;
}

/**
 * Generates a login CSRF token with timestamp and signature
 * Token format: <randomValue>.<timestamp>.<signature>
 */
export function generateLoginCSRFToken(): string {
  const tokenValue = randomBytes(LOGIN_CSRF_TOKEN_LENGTH).toString('hex');
  const timestamp = Math.floor(Date.now() / 1000).toString();

  // Create HMAC signature: tokenValue.timestamp
  const payload = `${tokenValue}.${timestamp}`;
  const signature = createHmac('sha256', getLoginCSRFSecret())
    .update(payload)
    .digest('hex');

  return `${tokenValue}.${timestamp}.${signature}`;
}

/**
 * Validates a login CSRF token
 * Returns true if valid, false otherwise
 */
export function validateLoginCSRFToken(token: string, maxAge: number = LOGIN_CSRF_MAX_AGE): boolean {
  if (!token) return false;

  const parts = token.split('.');
  if (parts.length !== 3) return false;

  const [tokenValue, timestamp, signature] = parts;

  // Check token age
  const tokenTime = parseInt(timestamp, 10);
  if (isNaN(tokenTime)) return false;

  const currentTime = Math.floor(Date.now() / 1000);
  const age = currentTime - tokenTime;
  if (age > maxAge || age < 0) return false;

  // Recreate expected signature
  const payload = `${tokenValue}.${timestamp}`;
  const expectedSignature = createHmac('sha256', getLoginCSRFSecret())
    .update(payload)
    .digest('hex');

  // Timing-safe comparison
  try {
    const expectedBuffer = Buffer.from(expectedSignature, 'hex');
    const actualBuffer = Buffer.from(signature, 'hex');

    if (expectedBuffer.length !== actualBuffer.length) return false;

    return timingSafeEqual(expectedBuffer, actualBuffer);
  } catch {
    return false;
  }
}
