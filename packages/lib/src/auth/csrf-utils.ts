import { randomBytes, createHmac, timingSafeEqual } from 'crypto';

function getCSRFSecret(): string {
  const CSRF_SECRET = process.env.CSRF_SECRET;
  if (!CSRF_SECRET) {
    throw new Error('CSRF_SECRET environment variable is required');
  }
  return CSRF_SECRET;
}

const CSRF_TOKEN_LENGTH = 32;
const CSRF_SEPARATOR = '.';

/**
 * Generates a CSRF token for the given session ID
 */
export function generateCSRFToken(sessionId: string): string {
  const tokenValue = randomBytes(CSRF_TOKEN_LENGTH).toString('hex');
  const timestamp = Math.floor(Date.now() / 1000).toString();
  
  // Create HMAC signature: sessionId.tokenValue.timestamp
  const payload = `${sessionId}${CSRF_SEPARATOR}${tokenValue}${CSRF_SEPARATOR}${timestamp}`;
  const signature = createHmac('sha256', getCSRFSecret())
    .update(payload)
    .digest('hex');
  
  return `${tokenValue}${CSRF_SEPARATOR}${timestamp}${CSRF_SEPARATOR}${signature}`;
}

/**
 * Validates a CSRF token against the given session ID
 */
export function validateCSRFToken(token: string, sessionId: string, maxAge: number = 3600): boolean {
  if (!token || !sessionId) {
    return false;
  }

  // Validate input types
  if (typeof token !== 'string' || typeof sessionId !== 'string') {
    return false;
  }

  try {
    const parts = token.split(CSRF_SEPARATOR);
    if (parts.length !== 3) {
      return false;
    }
    
    const [tokenValue, timestamp, signature] = parts;
    
    // Check if token has expired
    const tokenTime = parseInt(timestamp, 10);
    const currentTime = Math.floor(Date.now() / 1000);
    const age = currentTime - tokenTime;
    if (age > maxAge || (maxAge === 0 && age >= 0)) {
      return false;
    }
    
    // Recreate the expected signature
    const payload = `${sessionId}${CSRF_SEPARATOR}${tokenValue}${CSRF_SEPARATOR}${timestamp}`;
    const expectedSignature = createHmac('sha256', getCSRFSecret())
      .update(payload)
      .digest('hex');
    
    // Compare signatures using timing-safe comparison
    const expectedBuffer = Buffer.from(expectedSignature, 'hex');
    const actualBuffer = Buffer.from(signature, 'hex');
    
    if (expectedBuffer.length !== actualBuffer.length) {
      return false;
    }
    
    return timingSafeEqual(expectedBuffer, actualBuffer);
  } catch (error) {
    console.error('CSRF token validation error:', error);
    return false;
  }
}

/**
 * Extracts session ID from JWT token (for CSRF validation)
 */
export function getSessionIdFromJWT(payload: { userId: string; tokenVersion: number; iat?: number }): string {
  // Create a deterministic session ID from user info and issued time
  return createHmac('sha256', getCSRFSecret())
    .update(`${payload.userId}-${payload.tokenVersion}-${payload.iat || 0}`)
    .digest('hex')
    .substring(0, 16); // Use first 16 chars for session ID
}