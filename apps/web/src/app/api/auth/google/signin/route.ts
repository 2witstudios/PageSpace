import { z } from 'zod/v4';
import { loggers } from '@pagespace/lib/server';
import {
  checkDistributedRateLimit,
  DISTRIBUTED_RATE_LIMITS,
} from '@pagespace/lib/security';
import crypto from 'crypto';
import { getClientIP } from '@/lib/auth';

/**
 * Validates that a return URL is a safe same-origin path.
 * Prevents open redirect attacks by ensuring the URL:
 * - Is a relative path starting with /
 * - Does not contain protocol-relative URLs (//evil.com)
 * - Does not contain backslash tricks (\/evil.com)
 * - Does not contain encoded sequences that could bypass validation
 */
function isSafeReturnUrl(url: string | undefined): boolean {
  if (!url) return true; // undefined/empty falls back to /dashboard

  // Must start with exactly one forward slash (relative path)
  if (!url.startsWith('/')) return false;

  // Reject protocol-relative URLs (//evil.com) and backslash tricks
  if (url.startsWith('//') || url.startsWith('/\\')) return false;

  // Reject URLs with protocol schemes anywhere (javascript:, data:, etc.)
  if (/[a-z]+:/i.test(url)) return false;

  // Reject URLs with encoded characters that could bypass validation
  // %2f = /, %5c = \, %3a = :
  const decoded = decodeURIComponent(url);
  if (decoded.startsWith('//') || decoded.startsWith('/\\')) return false;
  if (/[a-z]+:/i.test(decoded)) return false;

  return true;
}

const googleSigninSchema = z.object({
  returnUrl: z.string().optional(),
  platform: z.enum(['web', 'desktop']).optional(),
  deviceId: z.string().optional(), // For device tracking on all platforms
  deviceName: z.string().optional(), // Human-readable device name
});

export async function POST(req: Request) {
  try {
    // Validate required OAuth environment variables
    if (!process.env.GOOGLE_OAUTH_CLIENT_ID || !process.env.GOOGLE_OAUTH_REDIRECT_URI || !process.env.OAUTH_STATE_SECRET) {
      loggers.auth.error('Missing required OAuth environment variables', {
        hasClientId: !!process.env.GOOGLE_OAUTH_CLIENT_ID,
        hasRedirectUri: !!process.env.GOOGLE_OAUTH_REDIRECT_URI,
        hasStateSecret: !!process.env.OAUTH_STATE_SECRET,
      });
      return Response.json(
        { error: 'OAuth not configured' },
        { status: 500 }
      );
    }

    const body = await req.json();
    const validation = googleSigninSchema.safeParse(body);

    if (!validation.success) {
      return Response.json({ errors: validation.error.flatten().fieldErrors }, { status: 400 });
    }

    const { returnUrl, platform, deviceId, deviceName } = validation.data;

    // SECURITY: Validate returnUrl to prevent open redirect attacks
    // An attacker could set returnUrl to an external domain and capture the deviceToken
    if (!isSafeReturnUrl(returnUrl)) {
      loggers.auth.warn('Rejected unsafe returnUrl in OAuth signin', {
        returnUrl,
        clientIP: getClientIP(req),
      });
      return Response.json(
        { error: 'Invalid return URL. Must be a relative path.' },
        { status: 400 }
      );
    }

    // Rate limiting by IP address
    const clientIP = getClientIP(req);

    const ipRateLimit = await checkDistributedRateLimit(
      `oauth:signin:ip:${clientIP}`,
      DISTRIBUTED_RATE_LIMITS.LOGIN
    );
    if (!ipRateLimit.allowed) {
      return Response.json(
        {
          error: 'Too many login attempts from this IP address. Please try again later.',
          retryAfter: ipRateLimit.retryAfter,
        },
        {
          status: 429,
          headers: {
            'Retry-After': String(ipRateLimit.retryAfter || 900),
            'X-RateLimit-Limit': String(DISTRIBUTED_RATE_LIMITS.LOGIN.maxAttempts),
            'X-RateLimit-Remaining': '0',
          },
        }
      );
    }

    // Create state object to preserve platform and deviceId through OAuth redirect
    const stateData = {
      returnUrl: returnUrl || '/dashboard',
      platform: platform || 'web',
      ...(deviceId && { deviceId }),
      ...(deviceName && { deviceName }),
    };

    // Sign state parameter with HMAC-SHA256 to prevent tampering
    const statePayload = JSON.stringify(stateData);
    const signature = crypto
      .createHmac('sha256', process.env.OAUTH_STATE_SECRET!)
      .update(statePayload)
      .digest('hex');

    const stateWithSignature = JSON.stringify({
      data: stateData,
      sig: signature,
    });

    const stateParam = Buffer.from(stateWithSignature).toString('base64');

    // Generate OAuth URL
    const params = new URLSearchParams({
      client_id: process.env.GOOGLE_OAUTH_CLIENT_ID!,
      redirect_uri: process.env.GOOGLE_OAUTH_REDIRECT_URI!,
      response_type: 'code',
      scope: 'openid email profile',
      access_type: 'offline',
      prompt: 'consent',
      state: stateParam,
    });

    const oauthUrl = `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;

    return Response.json({ url: oauthUrl });

  } catch (error) {
    loggers.auth.error('Google OAuth signin error', error as Error);
    return Response.json({ error: 'An unexpected error occurred.' }, { status: 500 });
  }
}

export async function GET(req: Request) {
  try {
    // Validate required OAuth environment variables
    if (!process.env.GOOGLE_OAUTH_CLIENT_ID || !process.env.GOOGLE_OAUTH_REDIRECT_URI) {
      loggers.auth.error('Missing required OAuth environment variables for GET', {
        hasClientId: !!process.env.GOOGLE_OAUTH_CLIENT_ID,
        hasRedirectUri: !!process.env.GOOGLE_OAUTH_REDIRECT_URI,
      });
      const baseUrl = process.env.WEB_APP_URL || process.env.NEXTAUTH_URL || 'http://localhost:3000';
      return Response.redirect(new URL('/auth/signin?error=oauth_config', baseUrl).toString());
    }

    // Rate limiting by IP address
    const clientIP = getClientIP(req);

    const ipRateLimit = await checkDistributedRateLimit(
      `oauth:signin:ip:${clientIP}`,
      DISTRIBUTED_RATE_LIMITS.LOGIN
    );
    if (!ipRateLimit.allowed) {
      const baseUrl = process.env.WEB_APP_URL || process.env.NEXTAUTH_URL || 'http://localhost:3000';
      return Response.redirect(new URL('/auth/signin?error=rate_limit', baseUrl).toString());
    }

    // Generate OAuth URL for direct link access
    const params = new URLSearchParams({
      client_id: process.env.GOOGLE_OAUTH_CLIENT_ID!,
      redirect_uri: process.env.GOOGLE_OAUTH_REDIRECT_URI!,
      response_type: 'code',
      scope: 'openid email profile',
      access_type: 'offline',
      prompt: 'consent',
    });

    const oauthUrl = `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;

    return Response.redirect(oauthUrl);

  } catch (error) {
    loggers.auth.error('Google OAuth signin GET error', error as Error);
    const baseUrl = process.env.WEB_APP_URL || process.env.NEXTAUTH_URL || 'http://localhost:3000';
    return Response.redirect(new URL('/auth/signin?error=oauth_error', baseUrl).toString());
  }
}