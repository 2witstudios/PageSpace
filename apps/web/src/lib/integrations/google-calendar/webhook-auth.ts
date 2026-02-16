/**
 * Zero-Trust Webhook Authentication
 *
 * Validates Google Calendar webhook requests using cryptographic HMAC tokens.
 * This module enforces strict authentication with no fallback paths.
 *
 * Security model:
 *   1. All webhook requests MUST include a valid HMAC token
 *   2. Fail-closed in production: Missing OAUTH_STATE_SECRET returns 500
 *   3. No fallback to channel/resource ID lookup (zero-trust)
 */

import { NextResponse } from 'next/server';
import { verifyWebhookToken } from './webhook-token';

export type WebhookAuthResult = { userId: string };

let secretWarningLogged = false;

/**
 * Reset the warning flag (exported for testing only)
 */
export function _resetWarningFlag(): void {
  secretWarningLogged = false;
}

/**
 * Validate webhook authentication token.
 *
 * Returns:
 *   - { userId: string } on successful authentication
 *   - NextResponse on failure (return immediately to client)
 *
 * Failure modes:
 *   - 500: Production without OAUTH_STATE_SECRET (fail-closed)
 *   - 401: Missing authentication token
 *   - 401: Invalid authentication token
 */
export function validateWebhookAuth(
  channelToken: string | null
): WebhookAuthResult | NextResponse {
  const secret = process.env.OAUTH_STATE_SECRET;

  // Fail-closed in production: OAUTH_STATE_SECRET must be configured
  if (!secret) {
    if (process.env.NODE_ENV === 'production') {
      return NextResponse.json(
        { error: 'Internal server error - webhook authentication not configured' },
        { status: 500 }
      );
    }
    // Development/test: warn once and return 401
    if (!secretWarningLogged) {
      console.warn(
        '[webhook-auth] OAUTH_STATE_SECRET is not configured. Webhook authentication will fail.'
      );
      secretWarningLogged = true;
    }
    return NextResponse.json(
      { error: 'Missing authentication token' },
      { status: 401 }
    );
  }

  // Missing token
  if (!channelToken) {
    return NextResponse.json(
      { error: 'Missing authentication token' },
      { status: 401 }
    );
  }

  // Verify token and extract userId
  const userId = verifyWebhookToken(channelToken);
  if (!userId) {
    return NextResponse.json(
      { error: 'Invalid authentication token' },
      { status: 401 }
    );
  }

  return { userId };
}
