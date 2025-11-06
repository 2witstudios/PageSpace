/**
 * GitHub OAuth Callback Handler
 * GET /api/github/auth/callback
 *
 * Handles the OAuth callback from GitHub and stores the connection
 */

import { githubConnections } from '@pagespace/db';
import { db, eq } from '@pagespace/db';
import { z } from 'zod/v4';
import { checkRateLimit, RATE_LIMIT_CONFIGS } from '@pagespace/lib/server';
import { loggers } from '@pagespace/lib/server';
import { NextResponse } from 'next/server';
import { GitHubService } from '@pagespace/lib/services/github-service';

const githubCallbackSchema = z.object({
  code: z.string().min(1, 'Authorization code is required'),
  state: z.string().min(1, 'State parameter is required'),
});

export async function GET(req: Request) {
  try {
    const { searchParams } = new URL(req.url);
    const code = searchParams.get('code');
    const state = searchParams.get('state');
    const error = searchParams.get('error');

    const baseUrl = process.env.NEXTAUTH_URL || process.env.WEB_APP_URL || req.url;

    if (error) {
      loggers.auth.warn('GitHub OAuth error', { error });

      let errorParam = 'github_oauth_error';
      if (error === 'access_denied') {
        errorParam = 'github_access_denied';
      }

      return NextResponse.redirect(new URL(`/settings?error=${errorParam}`, baseUrl));
    }

    const validation = githubCallbackSchema.safeParse({ code, state });
    if (!validation.success) {
      loggers.auth.warn('Invalid GitHub OAuth callback parameters', validation.error);
      return NextResponse.redirect(new URL('/settings?error=github_invalid_request', baseUrl));
    }

    const { code: authCode, state: encodedState } = validation.data;

    // Decode and validate state
    let stateData: {
      state: string;
      userId: string;
      driveId?: string;
      returnUrl?: string;
      timestamp: number;
    };

    try {
      const decodedState = Buffer.from(encodedState, 'base64url').toString('utf-8');
      stateData = JSON.parse(decodedState);

      // Validate state timestamp (prevent replay attacks, 10 minutes expiry)
      const stateAge = Date.now() - stateData.timestamp;
      if (stateAge > 10 * 60 * 1000) {
        loggers.auth.warn('Expired GitHub OAuth state', { age: stateAge });
        return NextResponse.redirect(new URL('/settings?error=github_state_expired', baseUrl));
      }
    } catch (e) {
      loggers.auth.error('Invalid GitHub OAuth state', e as Error);
      return NextResponse.redirect(new URL('/settings?error=github_invalid_state', baseUrl));
    }

    // Rate limiting
    const clientIP = req.headers.get('x-forwarded-for')?.split(',')[0] ||
                     req.headers.get('x-real-ip') ||
                     'unknown';

    const ipRateLimit = checkRateLimit(clientIP, RATE_LIMIT_CONFIGS.LOGIN);
    if (!ipRateLimit.allowed) {
      return NextResponse.redirect(new URL('/settings?error=github_rate_limit', baseUrl));
    }

    // Check environment variables
    if (!process.env.GITHUB_OAUTH_CLIENT_ID || !process.env.GITHUB_OAUTH_CLIENT_SECRET || !process.env.GITHUB_OAUTH_REDIRECT_URI) {
      loggers.auth.error('GitHub OAuth not configured');
      return NextResponse.redirect(new URL('/settings?error=github_not_configured', baseUrl));
    }

    // Exchange authorization code for access token
    const tokenResponse = await fetch('https://github.com/login/oauth/access_token', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify({
        client_id: process.env.GITHUB_OAUTH_CLIENT_ID,
        client_secret: process.env.GITHUB_OAUTH_CLIENT_SECRET,
        code: authCode,
        redirect_uri: process.env.GITHUB_OAUTH_REDIRECT_URI,
      }),
    });

    if (!tokenResponse.ok) {
      loggers.auth.error('Failed to exchange GitHub code for token', {
        status: tokenResponse.status,
      });
      return NextResponse.redirect(new URL('/settings?error=github_token_exchange_failed', baseUrl));
    }

    const tokenData = await tokenResponse.json();

    if (tokenData.error) {
      loggers.auth.error('GitHub OAuth token error', { error: tokenData.error });
      return NextResponse.redirect(new URL('/settings?error=github_token_error', baseUrl));
    }

    const { access_token, token_type, scope } = tokenData;

    if (!access_token) {
      loggers.auth.error('No access token received from GitHub');
      return NextResponse.redirect(new URL('/settings?error=github_no_token', baseUrl));
    }

    // Get GitHub user information
    const githubService = new GitHubService(access_token);
    const githubUser = await githubService.getAuthenticatedUser();

    if (!githubUser) {
      loggers.auth.error('Failed to get GitHub user information');
      return NextResponse.redirect(new URL('/settings?error=github_user_info_failed', baseUrl));
    }

    // Check if connection already exists
    const existingConnection = await db.query.githubConnections.findFirst({
      where: eq(githubConnections.userId, stateData.userId),
    });

    // Encrypt the access token before storing
    const encryptedToken = GitHubService.encryptToken(access_token);

    if (existingConnection) {
      // Update existing connection
      await db.update(githubConnections)
        .set({
          githubUserId: githubUser.id.toString(),
          githubUsername: githubUser.login,
          githubEmail: githubUser.email || null,
          githubAvatarUrl: githubUser.avatar_url,
          encryptedAccessToken: encryptedToken,
          tokenType: token_type || 'Bearer',
          scope: scope || null,
          lastUsed: new Date(),
          updatedAt: new Date(),
          revokedAt: null, // Clear revoked status if reconnecting
        })
        .where(eq(githubConnections.id, existingConnection.id));

      loggers.auth.info('Updated GitHub connection', {
        userId: stateData.userId,
        githubUsername: githubUser.login,
      });
    } else {
      // Create new connection
      await db.insert(githubConnections).values({
        userId: stateData.userId,
        githubUserId: githubUser.id.toString(),
        githubUsername: githubUser.login,
        githubEmail: githubUser.email || null,
        githubAvatarUrl: githubUser.avatar_url,
        encryptedAccessToken: encryptedToken,
        tokenType: token_type || 'Bearer',
        scope: scope || null,
        lastUsed: new Date(),
      });

      loggers.auth.info('Created new GitHub connection', {
        userId: stateData.userId,
        githubUsername: githubUser.login,
      });
    }

    // Redirect to return URL or settings page
    const redirectUrl = stateData.returnUrl || '/settings?tab=integrations&github=connected';
    return NextResponse.redirect(new URL(redirectUrl, baseUrl));

  } catch (error) {
    loggers.auth.error('GitHub OAuth callback error', error as Error);
    const baseUrl = process.env.NEXTAUTH_URL || process.env.WEB_APP_URL || req.url;
    return NextResponse.redirect(new URL('/settings?error=github_callback_error', baseUrl));
  }
}
