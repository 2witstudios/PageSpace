import { z } from 'zod/v4';
import { loggers } from '@pagespace/lib/server';
import {
  checkDistributedRateLimit,
  DISTRIBUTED_RATE_LIMITS,
} from '@pagespace/lib/security';
import { createSignedState } from '@pagespace/lib/integrations';
import { getClientIP, isSafeReturnUrl } from '@/lib/auth';
import { generatePKCE } from '@pagespace/lib/auth';

// Length bounds must match verifyOAuthState's oauthStateDataSchema — otherwise
// the server can mint a signed state it will later reject at the callback,
// bouncing users with oauth_error after they complete provider auth.
const googleSigninSchema = z.object({
  returnUrl: z.string().max(2048).optional(),
  platform: z.enum(['web', 'desktop', 'ios']).optional(),
  deviceId: z.string().min(1).max(128).optional(),
  deviceName: z.string().max(255).optional(),
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

    // Create signed state with HMAC-SHA256 + timestamp for tamper protection and expiration.
    const stateParam = createSignedState(
      {
        returnUrl: returnUrl || '/dashboard',
        platform: platform || 'web',
        ...(deviceId && { deviceId }),
        ...(deviceName && { deviceName }),
      },
      process.env.OAUTH_STATE_SECRET!
    );

    // Generate PKCE challenge (code_verifier stored server-side in Postgres via auth_handoff_tokens)
    const pkce = await generatePKCE(stateParam);

    // Generate OAuth URL (PKCE is optional — fails open to null if the DB is unavailable)
    const params = new URLSearchParams({
      client_id: process.env.GOOGLE_OAUTH_CLIENT_ID!,
      redirect_uri: process.env.GOOGLE_OAUTH_REDIRECT_URI!,
      response_type: 'code',
      scope: 'openid email profile',
      access_type: 'offline',
      prompt: 'consent',
      state: stateParam,
      ...(pkce && {
        code_challenge: pkce.codeChallenge,
        code_challenge_method: pkce.codeChallengeMethod,
      }),
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