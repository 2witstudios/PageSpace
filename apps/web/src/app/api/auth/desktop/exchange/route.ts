/**
 * Desktop OAuth Exchange Endpoint
 *
 * Exchanges a one-time code for authentication tokens.
 * This is the secure alternative to passing tokens in URL query parameters.
 *
 * Flow:
 * 1. Desktop app receives deep link: pagespace://auth-exchange?code=<code>
 * 2. Desktop app POSTs { code } to this endpoint
 * 3. Server validates code, returns tokens in response body
 * 4. Code is deleted (one-time use)
 *
 * Security:
 * - Tokens never appear in URLs or logs
 * - Codes are one-time use (atomic get-and-delete)
 * - Short TTL (5 minutes)
 * - Response body is not logged by nginx/proxies
 */

import { consumeExchangeCode } from '@pagespace/lib/auth';
import { loggers } from '@pagespace/lib/server';
import { createSessionCookie } from '@/lib/auth/cookie-config';
import { z } from 'zod/v4';

const exchangeRequestSchema = z.object({
  code: z.string().min(1, 'Exchange code is required'),
});

export async function POST(req: Request) {
  try {
    const body = await req.json();

    const validation = exchangeRequestSchema.safeParse(body);
    if (!validation.success) {
      loggers.auth.warn('Invalid exchange request', {
        errors: validation.error.issues,
      });
      return Response.json(
        { error: 'Missing or invalid exchange code' },
        { status: 400 }
      );
    }

    const { code } = validation.data;

    const data = await consumeExchangeCode(code);

    if (!data) {
      // consumeExchangeCode already logs the warning with codePrefix
      return Response.json(
        { error: 'Invalid or expired exchange code' },
        { status: 401 }
      );
    }

    loggers.auth.info('Desktop OAuth exchange successful', {
      userId: data.userId,
      provider: data.provider,
    });

    // Return tokens in response body (secure - not logged by proxies)
    // Set session cookie so Next.js middleware allows page route requests
    return Response.json({
      sessionToken: data.sessionToken,
      csrfToken: data.csrfToken,
      deviceToken: data.deviceToken,
    }, {
      headers: {
        'Set-Cookie': createSessionCookie(data.sessionToken),
      },
    });
  } catch (error) {
    loggers.auth.error('Desktop exchange error', error as Error);
    return Response.json(
      { error: 'Exchange failed' },
      { status: 500 }
    );
  }
}
