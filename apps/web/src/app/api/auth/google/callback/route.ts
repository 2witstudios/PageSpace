import { users, refreshTokens, drives } from '@pagespace/db';
import { db, eq, or, count } from '@pagespace/db';
import { z } from 'zod/v4';
import { generateAccessToken, generateRefreshToken, checkRateLimit, resetRateLimit, RATE_LIMIT_CONFIGS, slugify } from '@pagespace/lib/server';
import { serialize } from 'cookie';
import { createId } from '@paralleldrive/cuid2';
import { loggers, logAuthEvent } from '@pagespace/lib/logger-config';
import { trackAuthEvent } from '@pagespace/lib/activity-tracker';
import { OAuth2Client } from 'google-auth-library';
import { NextResponse } from 'next/server';

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

    const { code: authCode } = validation.data;

    // Rate limiting by IP address
    const clientIP = req.headers.get('x-forwarded-for')?.split(',')[0] || 
                     req.headers.get('x-real-ip') || 
                     'unknown';
    
    const ipRateLimit = checkRateLimit(clientIP, RATE_LIMIT_CONFIGS.LOGIN);
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
        console.log(`[GOOGLE_AUTH] Updating existing user: ${email}`);
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
        console.log(`[GOOGLE_AUTH] User updated: ${user.name}`);
      }
    } else {
      // Create new user
      console.log(`[GOOGLE_AUTH] Creating new user: ${email}`);
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
      }).returning();

      user = newUser;
      console.log(`[GOOGLE_AUTH] New user created: ${user.name} (id: ${user.id})`);
    }

    // Check if this user needs a personal drive (new users or existing users without drives)
    const userDriveCount = await db.select({ count: count() }).from(drives).where(eq(drives.ownerId, user.id));
    console.log(`[GOOGLE_AUTH] User has ${userDriveCount[0]?.count || 0} drives`);
    
    if (userDriveCount[0]?.count === 0) {
      // Create a personal drive for users who don't have any drives
      const driveName = `${user.name || userName}'s Drive`;
      const driveSlug = slugify(driveName);
      console.log(`[GOOGLE_AUTH] Creating drive: ${driveName} (${driveSlug})`);
      await db.insert(drives).values({
        name: driveName,
        slug: driveSlug,
        ownerId: user.id,
        updatedAt: new Date(),
      });
    }

    // Generate JWT tokens
    console.log(`[GOOGLE_AUTH] Generating tokens for user: ${user.id} (tokenVersion: ${user.tokenVersion})`);
    const accessToken = await generateAccessToken(user.id, user.tokenVersion, user.role);
    const refreshToken = await generateRefreshToken(user.id, user.tokenVersion, user.role);

    // Save refresh token
    await db.insert(refreshTokens).values({
      id: createId(),
      token: refreshToken,
      userId: user.id,
      device: req.headers.get('user-agent'),
      ip: clientIP,
    });

    // Reset rate limits on successful login
    resetRateLimit(clientIP);
    resetRateLimit(email.toLowerCase());
    
    // Log successful login
    logAuthEvent('login', user.id, email, clientIP, 'Google OAuth');
    
    // Track login event
    trackAuthEvent(user.id, 'login', {
      email,
      ip: clientIP,
      provider: 'google',
      userAgent: req.headers.get('user-agent')
    });

    const isProduction = process.env.NODE_ENV === 'production';
    
    // Set cookies and redirect to dashboard
    const baseUrl = process.env.NEXTAUTH_URL || process.env.WEB_APP_URL || req.url;
    const redirectUrl = new URL('/dashboard', baseUrl);
    
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
      maxAge: 7 * 24 * 60 * 60, // 7 days
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