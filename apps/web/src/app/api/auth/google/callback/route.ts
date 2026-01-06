import { users, refreshTokens } from '@pagespace/db';
import { db, eq, or } from '@pagespace/db';
import { z } from 'zod/v4';
import { generateAccessToken, generateRefreshToken, getRefreshTokenMaxAge, decodeToken, generateCSRFToken, getSessionIdFromJWT, validateOrCreateDeviceToken } from '@pagespace/lib/server';
import {
  checkDistributedRateLimit,
  resetDistributedRateLimit,
  DISTRIBUTED_RATE_LIMITS,
} from '@pagespace/lib/security';
import { serialize } from 'cookie';
import { createId } from '@paralleldrive/cuid2';
import { loggers, logAuthEvent } from '@pagespace/lib/server';
import { trackAuthEvent } from '@pagespace/lib/activity-tracker';
import { OAuth2Client } from 'google-auth-library';
import { NextResponse } from 'next/server';
import crypto from 'crypto';
import { provisionGettingStartedDriveIfNeeded } from '@/lib/onboarding/getting-started-drive';

const googleCallbackSchema = z.object({
  code: z.string().min(1, "Authorization code is required"),
  state: z.string().nullish().optional(),
});

const client = new OAuth2Client(
  process.env.GOOGLE_OAUTH_CLIENT_ID,
  process.env.GOOGLE_OAUTH_CLIENT_SECRET,
  process.env.GOOGLE_OAUTH_REDIRECT_URI
);

export async function GET(req: Request) {
  try {
    const { searchParams } = new URL(req.url);
    const code = searchParams.get('code');
    const state = searchParams.get('state');
    const error = searchParams.get('error');

    if (error) {
      loggers.auth.warn('OAuth error', { error });
      
      // Handle specific OAuth errors
      let errorParam = 'oauth_error';
      if (error === 'access_denied') {
        errorParam = 'access_denied';
      }
      
      const baseUrl = process.env.NEXTAUTH_URL || process.env.WEB_APP_URL || req.url;
      return NextResponse.redirect(new URL(`/auth/signin?error=${errorParam}`, baseUrl));
    }

    const validation = googleCallbackSchema.safeParse({ code, state });
    if (!validation.success) {
      loggers.auth.warn('Invalid OAuth callback parameters', validation.error);
      const baseUrl = process.env.NEXTAUTH_URL || process.env.WEB_APP_URL || req.url;
      return NextResponse.redirect(new URL('/auth/signin?error=invalid_request', baseUrl));
    }

    const { code: authCode, state: stateParam } = validation.data;

    // Parse and verify state parameter signature
    let platform: 'web' | 'desktop' = 'web';
    let deviceId: string | undefined;
    let returnUrl = '/dashboard';

    if (stateParam) {
      try {
        const stateWithSignature = JSON.parse(
          Buffer.from(stateParam, 'base64').toString('utf-8')
        );

        // Check if this is a signed state parameter (new format)
        if (stateWithSignature.data && stateWithSignature.sig) {
          // Verify HMAC signature
          const { data, sig } = stateWithSignature;
          const expectedSignature = crypto
            .createHmac('sha256', process.env.OAUTH_STATE_SECRET!)
            .update(JSON.stringify(data))
            .digest('hex');

          if (sig !== expectedSignature) {
            loggers.auth.warn('OAuth state signature mismatch', { stateParam });
            const baseUrl = process.env.NEXTAUTH_URL || process.env.WEB_APP_URL || req.url;
            return NextResponse.redirect(new URL('/auth/signin?error=invalid_request', baseUrl));
          }

          // Signature valid, trust the data
          platform = data.platform || 'web';
          deviceId = data.deviceId;
          returnUrl = data.returnUrl || '/dashboard';
        } else {
          // Legacy format: unsigned state (backward compatibility)
          platform = stateWithSignature.platform || 'web';
          deviceId = stateWithSignature.deviceId;
          returnUrl = stateWithSignature.returnUrl || '/dashboard';
        }
      } catch {
        // Legacy fallback: state might be just a return URL string
        returnUrl = stateParam;
      }
    }

    // Rate limiting by IP address
    const clientIP = req.headers.get('x-forwarded-for')?.split(',')[0] ||
                     req.headers.get('x-real-ip') ||
                     'unknown';

    const ipRateLimit = await checkDistributedRateLimit(
      `oauth:callback:ip:${clientIP}`,
      DISTRIBUTED_RATE_LIMITS.LOGIN
    );
    if (!ipRateLimit.allowed) {
      const baseUrl = process.env.NEXTAUTH_URL || process.env.WEB_APP_URL || req.url;
      return NextResponse.redirect(new URL('/auth/signin?error=rate_limit', baseUrl));
    }

    // Exchange authorization code for tokens
    const { tokens } = await client.getToken(authCode);
    
    if (!tokens.id_token) {
      loggers.auth.error('No ID token received from Google');
      const baseUrl = process.env.NEXTAUTH_URL || process.env.WEB_APP_URL || req.url;
      return NextResponse.redirect(new URL('/auth/signin?error=oauth_error', baseUrl));
    }

    // Verify the ID token
    const ticket = await client.verifyIdToken({
      idToken: tokens.id_token,
      audience: process.env.GOOGLE_OAUTH_CLIENT_ID,
    });

    const payload = ticket.getPayload();
    if (!payload) {
      loggers.auth.error('Invalid Google ID token payload');
      const baseUrl = process.env.NEXTAUTH_URL || process.env.WEB_APP_URL || req.url;
      return NextResponse.redirect(new URL('/auth/signin?error=oauth_error', baseUrl));
    }

    const { sub: googleId, email, name, picture, email_verified } = payload;

    if (!email) {
      loggers.auth.error('Missing required email from Google');
      const baseUrl = process.env.NEXTAUTH_URL || process.env.WEB_APP_URL || req.url;
      return NextResponse.redirect(new URL('/auth/signin?error=oauth_error', baseUrl));
    }

    // Create fallback name if Google doesn't provide one
    const userName = name || email.split('@')[0] || 'User';

    // Check if user exists by Google ID or email
    let user = await db.query.users.findFirst({
      where: or(
        eq(users.googleId, googleId),
        eq(users.email, email)
      ),
    });

    if (user) {
      // Update existing user with Google ID if not set, or update other profile info
      if (!user.googleId || !user.name || user.image !== picture) {
        loggers.auth.info('Updating existing user via Google OAuth', { email });
        await db.update(users)
          .set({ 
            googleId: googleId || user.googleId,
            provider: user.password ? 'both' : 'google',
            name: user.name || userName, // Update name if it's missing
            image: picture || user.image, // Update image if different
            emailVerified: email_verified ? new Date() : user.emailVerified,
          })
          .where(eq(users.id, user.id));
        
        // Refetch the user to get updated data including any changes
        user = await db.query.users.findFirst({
          where: eq(users.id, user.id),
        }) || user;
        loggers.auth.info('User updated via Google OAuth', { userId: user.id, name: user.name });
      }
    } else {
      // Create new user
      loggers.auth.info('Creating new user via Google OAuth', { email });
      const [newUser] = await db.insert(users).values({
        id: createId(),
        name: userName,
        email,
        emailVerified: email_verified ? new Date() : null,
        image: picture || null,
        googleId,
        provider: 'google',
        tokenVersion: 0,
        role: 'user',
        // Storage tracking (quota/tier computed from subscriptionTier)
        storageUsedBytes: 0,
        subscriptionTier: 'free',
      }).returning();

      user = newUser;
      loggers.auth.info('New user created via Google OAuth', { userId: user.id, name: user.name });
    }

    let provisionedDrive: { driveId: string } | null = null;
    try {
      provisionedDrive = await provisionGettingStartedDriveIfNeeded(user.id);
      if (provisionedDrive) {
        returnUrl = `/dashboard/${provisionedDrive.driveId}`;
      }
    } catch (error) {
      loggers.auth.error('Failed to provision Getting Started drive', error as Error, {
        userId: user.id,
        provider: 'google',
      });
    }

    // Generate JWT tokens
    loggers.auth.debug('Generating tokens for Google OAuth user', { userId: user.id, tokenVersion: user.tokenVersion });
    const accessToken = await generateAccessToken(user.id, user.tokenVersion, user.role);
    const refreshToken = await generateRefreshToken(user.id, user.tokenVersion, user.role);

    const refreshPayload = await decodeToken(refreshToken);
    const refreshExpiresAt = refreshPayload?.exp
      ? new Date(refreshPayload.exp * 1000)
      : new Date(Date.now() + getRefreshTokenMaxAge() * 1000);

    // Save refresh token
    await db.insert(refreshTokens).values({
      id: createId(),
      token: refreshToken,
      userId: user.id,
      device: req.headers.get('user-agent'),
      userAgent: req.headers.get('user-agent'),
      ip: clientIP,
      lastUsedAt: new Date(),
      platform: platform,
      expiresAt: refreshExpiresAt,
    });

    // Reset rate limits on successful login
    await resetDistributedRateLimit(`oauth:callback:ip:${clientIP}`);

    // Log successful login
    logAuthEvent('login', user.id, email, clientIP, 'Google OAuth');

    // Track login event
    trackAuthEvent(user.id, 'login', {
      email,
      ip: clientIP,
      provider: 'google',
      userAgent: req.headers.get('user-agent')
    });

    // DESKTOP PLATFORM: Pass tokens through redirect URL
    if (platform === 'desktop') {
      // Validate that we have a deviceId for desktop OAuth
      if (!deviceId) {
        loggers.auth.error('Desktop OAuth missing deviceId from state', {
          userId: user.id,
          email: user.email,
          hasStateParam: !!stateParam,
          platform: platform,
        });
        const baseUrl = process.env.NEXTAUTH_URL || process.env.WEB_APP_URL || req.url;
        return NextResponse.redirect(new URL('/auth/signin?error=invalid_device', baseUrl));
      }

      // Generate device token for desktop
      const { deviceToken: deviceTokenValue } = await validateOrCreateDeviceToken({
        providedDeviceToken: undefined, // No existing token for OAuth
        userId: user.id,
        deviceId: deviceId, // Required for desktop
        platform: 'desktop',
        tokenVersion: user.tokenVersion,
        deviceName: req.headers.get('user-agent') || 'Desktop App',
        userAgent: req.headers.get('user-agent') || undefined,
        ipAddress: clientIP,
      });

      // Generate CSRF token for desktop
      const decoded = await decodeToken(accessToken);
      if (!decoded) {
        loggers.auth.error('Failed to decode access token for desktop OAuth');
        const baseUrl = process.env.NEXTAUTH_URL || process.env.WEB_APP_URL || req.url;
        return NextResponse.redirect(new URL('/auth/signin?error=oauth_error', baseUrl));
      }
      const sessionId = getSessionIdFromJWT({
        userId: user.id,
        tokenVersion: user.tokenVersion,
        iat: decoded.iat,
      });
      const csrfToken = generateCSRFToken(sessionId);

      // Redirect to dashboard with tokens in URL (will be handled by desktop OAuth handler)
      const baseUrl = process.env.NEXTAUTH_URL || process.env.WEB_APP_URL || req.url;
      const dashboardPath = provisionedDrive
        ? `/dashboard/${provisionedDrive.driveId}`
        : '/dashboard';
      const redirectUrl = new URL(dashboardPath, baseUrl);
      redirectUrl.searchParams.set('auth', 'success');
      redirectUrl.searchParams.set('desktop', 'true');

      // Encode tokens as base64 to pass through URL (desktop will intercept and store)
      const tokensData = {
        token: accessToken,
        refreshToken: refreshToken,
        csrfToken: csrfToken,
        deviceToken: deviceTokenValue,
      };
      const tokensEncoded = Buffer.from(JSON.stringify(tokensData)).toString('base64');
      redirectUrl.searchParams.set('tokens', tokensEncoded);

      return NextResponse.redirect(redirectUrl);
    }

    // WEB PLATFORM: Set cookies and redirect to dashboard
    const isProduction = process.env.NODE_ENV === 'production';

    const baseUrl = process.env.NEXTAUTH_URL || process.env.WEB_APP_URL || req.url;
    const redirectUrl = new URL(returnUrl, baseUrl);

    // Add a parameter to trigger auth state refresh after OAuth
    redirectUrl.searchParams.set('auth', 'success');

    const accessTokenCookie = serialize('accessToken', accessToken, {
      httpOnly: true,
      secure: isProduction,
      sameSite: 'strict',
      path: '/',
      maxAge: 15 * 60, // 15 minutes
      ...(isProduction && { domain: process.env.COOKIE_DOMAIN })
    });

    const refreshTokenCookie = serialize('refreshToken', refreshToken, {
      httpOnly: true,
      secure: isProduction,
      sameSite: 'strict',
      path: '/',
      maxAge: getRefreshTokenMaxAge(), // Configurable via REFRESH_TOKEN_TTL env var (default: 30d)
      ...(isProduction && { domain: process.env.COOKIE_DOMAIN })
    });

    const headers = new Headers();
    headers.append('Set-Cookie', accessTokenCookie);
    headers.append('Set-Cookie', refreshTokenCookie);

    return NextResponse.redirect(redirectUrl, { headers });

  } catch (error) {
    loggers.auth.error('Google OAuth callback error', error as Error);
    const baseUrl = process.env.NEXTAUTH_URL || process.env.WEB_APP_URL || req.url;
    return NextResponse.redirect(new URL('/auth/signin?error=oauth_error', baseUrl));
  }
}
