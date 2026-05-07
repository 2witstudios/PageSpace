import { z } from 'zod/v4';
import { loggers } from '@pagespace/lib/logging/logger-config';
import {
  checkDistributedRateLimit,
  DISTRIBUTED_RATE_LIMITS,
} from '@pagespace/lib/security/distributed-rate-limit';
import { createSignedState } from '@pagespace/lib/integrations/oauth/oauth-state';
import { getClientIP, isSafeReturnUrl } from '@/lib/auth';
import { INVITE_TOKEN_MAX_LENGTH } from '@/lib/auth/oauth-state';

// Length bounds must match verifyOAuthState's oauthStateDataSchema — otherwise
// the server can mint a signed state it will later reject at the callback,
// bouncing users with oauth_error after they complete provider auth.
const appleSigninSchema = z.object({
  returnUrl: z.string().max(2048).optional(),
  platform: z.enum(['web', 'desktop', 'ios']).optional(),
  deviceId: z.string().min(1).max(128).optional(),
  deviceName: z.string().max(255).optional(),
  inviteToken: z.string().min(1).max(INVITE_TOKEN_MAX_LENGTH).optional(),
});

export async function POST(req: Request) {
  try {
    // Validate required OAuth environment variables
    if (
      !process.env.APPLE_SERVICE_ID ||
      !process.env.APPLE_REDIRECT_URI ||
      !process.env.OAUTH_STATE_SECRET
    ) {
      loggers.auth.error('Missing required Apple OAuth environment variables', {
        hasServiceId: !!process.env.APPLE_SERVICE_ID,
        hasRedirectUri: !!process.env.APPLE_REDIRECT_URI,
        hasStateSecret: !!process.env.OAUTH_STATE_SECRET,
      });
      return Response.json(
        { error: 'Apple OAuth not configured' },
        { status: 500 }
      );
    }

    const body = await req.json();
    const validation = appleSigninSchema.safeParse(body);

    if (!validation.success) {
      return Response.json({ errors: validation.error.flatten().fieldErrors }, { status: 400 });
    }

    const { returnUrl, platform, deviceId, deviceName, inviteToken } = validation.data;

    // SECURITY: Validate returnUrl to prevent open redirect attacks
    if (!isSafeReturnUrl(returnUrl)) {
      loggers.auth.warn('Rejected unsafe returnUrl in Apple OAuth signin', {
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

    // Sign state with HMAC-SHA256 + auto-attached timestamp via the shared
    // helper (matches Google signin); verifyOAuthState requires timestamp to
    // accept the state at the callback.
    const stateParam = createSignedState(
      {
        returnUrl: returnUrl || '/dashboard',
        platform: platform || 'web',
        ...(deviceId && { deviceId }),
        ...(deviceName && { deviceName }),
        ...(inviteToken && { inviteToken }),
      },
      process.env.OAUTH_STATE_SECRET!
    );

    // Generate Apple OAuth URL
    // Note: Apple uses response_mode=form_post which POSTs the authorization response
    const params = new URLSearchParams({
      client_id: process.env.APPLE_SERVICE_ID!,
      redirect_uri: process.env.APPLE_REDIRECT_URI!,
      response_type: 'code id_token',
      scope: 'name email',
      response_mode: 'form_post',
      state: stateParam,
    });

    const oauthUrl = `https://appleid.apple.com/auth/authorize?${params.toString()}`;

    return Response.json({ url: oauthUrl });

  } catch (error) {
    loggers.auth.error('Apple OAuth signin error', error as Error);
    return Response.json({ error: 'An unexpected error occurred.' }, { status: 500 });
  }
}

export async function GET(req: Request) {
  try {
    // Validate required OAuth environment variables
    if (
      !process.env.APPLE_SERVICE_ID ||
      !process.env.APPLE_REDIRECT_URI ||
      !process.env.OAUTH_STATE_SECRET
    ) {
      loggers.auth.error('Missing required Apple OAuth environment variables for GET', {
        hasServiceId: !!process.env.APPLE_SERVICE_ID,
        hasRedirectUri: !!process.env.APPLE_REDIRECT_URI,
        hasStateSecret: !!process.env.OAUTH_STATE_SECRET,
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

    // SECURITY: Create signed state parameter to prevent CSRF attacks.
    // Auto-attaches timestamp required by verifyOAuthState at the callback.
    const stateParam = createSignedState(
      { returnUrl: '/dashboard', platform: 'web' },
      process.env.OAUTH_STATE_SECRET!
    );

    // Generate OAuth URL for direct link access
    const params = new URLSearchParams({
      client_id: process.env.APPLE_SERVICE_ID!,
      redirect_uri: process.env.APPLE_REDIRECT_URI!,
      response_type: 'code id_token',
      scope: 'name email',
      response_mode: 'form_post',
      state: stateParam,
    });

    const oauthUrl = `https://appleid.apple.com/auth/authorize?${params.toString()}`;

    return Response.redirect(oauthUrl);

  } catch (error) {
    loggers.auth.error('Apple OAuth signin GET error', error as Error);
    const baseUrl = process.env.WEB_APP_URL || process.env.NEXTAUTH_URL || 'http://localhost:3000';
    return Response.redirect(new URL('/auth/signin?error=oauth_error', baseUrl).toString());
  }
}
