import { createHmac, timingSafeEqual } from 'crypto';

/**
 * Security utilities for Socket.IO broadcast endpoint authentication
 */

function getBroadcastSecret(): string {
  const secret = process.env.REALTIME_BROADCAST_SECRET;
  if (!secret) {
    throw new Error('REALTIME_BROADCAST_SECRET environment variable is required');
  }
  if (secret.length < 32) {
    throw new Error('REALTIME_BROADCAST_SECRET must be at least 32 characters long');
  }
  return secret;
}

const MAX_TIMESTAMP_AGE = 5 * 60; // 5 minutes in seconds

/**
 * Generates an HMAC signature for broadcast request authentication
 * @param requestBody - The JSON request body as a string
 * @param timestamp - Unix timestamp in seconds (defaults to current time)
 * @returns Object with timestamp and signature for header construction
 */
export function generateBroadcastSignature(requestBody: string, timestamp?: number): { timestamp: number; signature: string } {
  const ts = timestamp || Math.floor(Date.now() / 1000);
  const payload = `${ts}.${requestBody}`;

  const signature = createHmac('sha256', getBroadcastSecret())
    .update(payload, 'utf8')
    .digest('hex');

  return { timestamp: ts, signature };
}

/**
 * Formats the signature for the X-Broadcast-Signature header
 * @param timestamp - Unix timestamp in seconds
 * @param signature - HMAC signature hex string
 * @returns Formatted header value: "t=timestamp,v1=signature"
 */
export function formatSignatureHeader(timestamp: number, signature: string): string {
  return `t=${timestamp},v1=${signature}`;
}

/**
 * Verifies the HMAC signature from a broadcast request
 * @param signatureHeader - Value from X-Broadcast-Signature header
 * @param requestBody - Raw request body as string
 * @returns true if signature is valid and not expired, false otherwise
 */
export function verifyBroadcastSignature(signatureHeader: string, requestBody: string): boolean {
  if (!signatureHeader || !requestBody) {
    return false;
  }

  // Validate input types
  if (typeof signatureHeader !== 'string' || typeof requestBody !== 'string') {
    return false;
  }

  try {
    // Parse header format: "t=timestamp,v1=signature"
    const parts = signatureHeader.split(',');
    if (parts.length !== 2) {
      return false;
    }

    let timestamp: number | undefined;
    let providedSignature: string | undefined;

    for (const part of parts) {
      const [key, value] = part.split('=');
      if (key === 't') {
        timestamp = parseInt(value, 10);
      } else if (key === 'v1') {
        providedSignature = value;
      }
    }

    if (!timestamp || !providedSignature) {
      return false;
    }

    // Check timestamp validity (prevent replay attacks)
    const currentTime = Math.floor(Date.now() / 1000);
    if (Math.abs(currentTime - timestamp) > MAX_TIMESTAMP_AGE) {
      return false;
    }

    // Generate expected signature
    const { signature: expectedSignature } = generateBroadcastSignature(requestBody, timestamp);

    // Timing-safe comparison
    const expectedBuffer = Buffer.from(expectedSignature, 'hex');
    const providedBuffer = Buffer.from(providedSignature, 'hex');

    if (expectedBuffer.length !== providedBuffer.length) {
      return false;
    }

    return timingSafeEqual(expectedBuffer, providedBuffer);
  } catch (error) {
    console.error('Broadcast signature verification error:', error);
    return false;
  }
}

/**
 * Creates a signed request header for broadcast requests
 * @param requestBody - JSON request body as string
 * @returns Object with headers to include in fetch request
 */
export function createSignedBroadcastHeaders(requestBody: string): Record<string, string> {
  const { timestamp, signature } = generateBroadcastSignature(requestBody);

  return {
    'Content-Type': 'application/json',
    'X-Broadcast-Signature': formatSignatureHeader(timestamp, signature),
  };
}