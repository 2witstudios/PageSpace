import { z } from 'zod/v4';
import { loggers } from '@pagespace/lib/server';
import {
  checkDistributedRateLimit,
  DISTRIBUTED_RATE_LIMITS,
} from '@pagespace/lib/security';
import crypto from 'crypto';
import { getClientIP, isSafeReturnUrl } from '@/lib/auth';

const appleSigninSchema = z.object({
  returnUrl: z.string().optional(),
  platform: z.enum(['web', 'desktop', 'ios']).optional(),
  deviceId: z.string().optional(),
  deviceName: z.string().optional(),
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

    const { returnUrl, platform, deviceId, deviceName } = validation.data;

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
    if (!process.env.APPLE_SERVICE_ID || !process.env.APPLE_REDIRECT_URI) {
      loggers.auth.error('Missing required Apple OAuth environment variables for GET', {
        hasServiceId: !!process.env.APPLE_SERVICE_ID,
        hasRedirectUri: !!process.env.APPLE_REDIRECT_URI,
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
      client_id: process.env.APPLE_SERVICE_ID!,
      redirect_uri: process.env.APPLE_REDIRECT_URI!,
      response_type: 'code id_token',
      scope: 'name email',
      response_mode: 'form_post',
    });

    const oauthUrl = `https://appleid.apple.com/auth/authorize?${params.toString()}`;

    return Response.redirect(oauthUrl);

  } catch (error) {
    loggers.auth.error('Apple OAuth signin GET error', error as Error);
    const baseUrl = process.env.WEB_APP_URL || process.env.NEXTAUTH_URL || 'http://localhost:3000';
    return Response.redirect(new URL('/auth/signin?error=oauth_error', baseUrl).toString());
  }
}
