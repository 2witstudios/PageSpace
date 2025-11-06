/**
 * GitHub OAuth Connection Initiation
 * POST /api/github/auth/connect
 *
 * Initiates the GitHub OAuth flow for connecting a user's GitHub account
 */

import { z } from 'zod/v4';
import { checkRateLimit, RATE_LIMIT_CONFIGS } from '@pagespace/lib/server';
import { loggers } from '@pagespace/lib/server';
import { verify } from '@pagespace/lib/server';
import { createId } from '@paralleldrive/cuid2';

const githubConnectSchema = z.object({
  driveId: z.string().optional(),
  returnUrl: z.string().optional(),
});

export async function POST(req: Request) {
  try {
    // Verify authentication
    const authHeader = req.headers.get('authorization');
    if (!authHeader) {
      return Response.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const token = authHeader.replace('Bearer ', '');
    const payload = await verify(token);
    if (!payload) {
      return Response.json({ error: 'Invalid token' }, { status: 401 });
    }

    const body = await req.json();
    const validation = githubConnectSchema.safeParse(body);

    if (!validation.success) {
      return Response.json({ errors: validation.error.flatten().fieldErrors }, { status: 400 });
    }

    // Rate limiting by IP address
    const clientIP = req.headers.get('x-forwarded-for')?.split(',')[0] ||
                     req.headers.get('x-real-ip') ||
                     'unknown';

    const ipRateLimit = checkRateLimit(clientIP, RATE_LIMIT_CONFIGS.LOGIN);
    if (!ipRateLimit.allowed) {
      return Response.json(
        {
          error: 'Too many connection attempts. Please try again later.',
          retryAfter: ipRateLimit.retryAfter
        },
        {
          status: 429,
          headers: {
            'Retry-After': ipRateLimit.retryAfter?.toString() || '900'
          }
        }
      );
    }

    const { driveId, returnUrl } = validation.data;

    // Check environment variables
    if (!process.env.GITHUB_OAUTH_CLIENT_ID || !process.env.GITHUB_OAUTH_REDIRECT_URI) {
      loggers.auth.error('GitHub OAuth not configured');
      return Response.json({ error: 'GitHub integration not configured' }, { status: 500 });
    }

    // Generate state parameter for CSRF protection
    const state = createId();

    // Store state in a way that can be verified in callback
    // For now, we'll encode the userId, driveId, and returnUrl in the state
    const stateData = {
      state,
      userId: payload.userId,
      driveId,
      returnUrl,
      timestamp: Date.now(),
    };
    const encodedState = Buffer.from(JSON.stringify(stateData)).toString('base64url');

    // Generate OAuth URL
    const scopes = ['repo', 'read:user', 'user:email'];
    const params = new URLSearchParams({
      client_id: process.env.GITHUB_OAUTH_CLIENT_ID,
      redirect_uri: process.env.GITHUB_OAUTH_REDIRECT_URI,
      scope: scopes.join(' '),
      state: encodedState,
      allow_signup: 'true',
    });

    const oauthUrl = `https://github.com/login/oauth/authorize?${params.toString()}`;

    loggers.auth.info('GitHub OAuth connection initiated', {
      userId: payload.userId,
      driveId,
    });

    return Response.json({ url: oauthUrl, state });

  } catch (error) {
    loggers.auth.error('GitHub OAuth connect error', error as Error);
    return Response.json({ error: 'An unexpected error occurred.' }, { status: 500 });
  }
}

export async function GET(req: Request) {
  try {
    // Verify authentication
    const { searchParams } = new URL(req.url);
    const token = searchParams.get('token');

    if (!token) {
      return Response.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const payload = await verify(token);
    if (!payload) {
      return Response.json({ error: 'Invalid token' }, { status: 401 });
    }

    // Check environment variables
    if (!process.env.GITHUB_OAUTH_CLIENT_ID || !process.env.GITHUB_OAUTH_REDIRECT_URI) {
      loggers.auth.error('GitHub OAuth not configured');
      const baseUrl = process.env.WEB_APP_URL || process.env.NEXTAUTH_URL || 'http://localhost:3000';
      return Response.redirect(new URL('/settings?error=github_not_configured', baseUrl).toString());
    }

    // Generate state parameter
    const state = createId();
    const stateData = {
      state,
      userId: payload.userId,
      timestamp: Date.now(),
    };
    const encodedState = Buffer.from(JSON.stringify(stateData)).toString('base64url');

    // Generate OAuth URL for direct link access
    const scopes = ['repo', 'read:user', 'user:email'];
    const params = new URLSearchParams({
      client_id: process.env.GITHUB_OAUTH_CLIENT_ID,
      redirect_uri: process.env.GITHUB_OAUTH_REDIRECT_URI,
      scope: scopes.join(' '),
      state: encodedState,
      allow_signup: 'true',
    });

    const oauthUrl = `https://github.com/login/oauth/authorize?${params.toString()}`;

    return Response.redirect(oauthUrl);

  } catch (error) {
    loggers.auth.error('GitHub OAuth connect GET error', error as Error);
    const baseUrl = process.env.WEB_APP_URL || process.env.NEXTAUTH_URL || 'http://localhost:3000';
    return Response.redirect(new URL('/settings?error=github_error', baseUrl).toString());
  }
}
