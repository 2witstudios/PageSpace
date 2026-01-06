import { z } from 'zod/v4';
import { loggers } from '@pagespace/lib/server';
import {
  checkDistributedRateLimit,
  DISTRIBUTED_RATE_LIMITS,
} from '@pagespace/lib/security';
import crypto from 'crypto';

const googleSigninSchema = z.object({
  returnUrl: z.string().optional(),
  platform: z.enum(['web', 'desktop']).optional(),
  deviceId: z.string().optional(), // For desktop platform
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

    // Rate limiting by IP address
    const clientIP = req.headers.get('x-forwarded-for')?.split(',')[0] ||
                     req.headers.get('x-real-ip') ||
                     'unknown';

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

    const { returnUrl, platform, deviceId } = validation.data;

    // Create state object to preserve platform and deviceId through OAuth redirect
    const stateData = {
      returnUrl: returnUrl || '/dashboard',
      platform: platform || 'web',
      ...(deviceId && { deviceId }),
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
    const clientIP = req.headers.get('x-forwarded-for')?.split(',')[0] ||
                     req.headers.get('x-real-ip') ||
                     'unknown';

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