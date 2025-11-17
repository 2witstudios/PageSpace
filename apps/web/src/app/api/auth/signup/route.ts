import { users, drives, userAiSettings, refreshTokens, db, eq } from '@pagespace/db';
import bcrypt from 'bcryptjs';
import { z } from 'zod/v4';
import { slugify, generateAccessToken, generateRefreshToken, getRefreshTokenMaxAge, checkRateLimit, resetRateLimit, RATE_LIMIT_CONFIGS, createNotification, decodeToken, validateOrCreateDeviceToken } from '@pagespace/lib/server';
import { createId } from '@paralleldrive/cuid2';
import { loggers, logAuthEvent } from '@pagespace/lib/server';
import { trackAuthEvent } from '@pagespace/lib/activity-tracker';
import { serialize } from 'cookie';
import { createVerificationToken } from '@pagespace/lib/verification-utils';
import { sendEmail } from '@pagespace/lib/services/email-service';
import { VerificationEmail } from '@pagespace/lib/email-templates/VerificationEmail';
import React from 'react';
import { NextResponse } from 'next/server';
// Removed AI defaults dependency

const signupSchema = z.object({
  name: z.string().min(1, {
      error: "Name is required"
  }),
  email: z.email(),
  password: z.string()
    .min(12, { message: "Password must be at least 12 characters long" })
    .regex(/[A-Z]/, { message: "Password must contain at least one uppercase letter" })
    .regex(/[a-z]/, { message: "Password must contain at least one lowercase letter" })
    .regex(/[0-9]/, { message: "Password must contain at least one number" }),
  confirmPassword: z.string().min(1, { message: "Please confirm your password" }),
  acceptedTos: z.boolean().refine((val) => val === true, {
    message: "You must accept the Terms of Service and Privacy Policy",
  }),
  // Optional device information for device token creation
  deviceId: z.string().optional(),
  deviceName: z.string().optional(),
  deviceToken: z.string().optional(),
}).refine((data) => data.password === data.confirmPassword, {
  message: "Passwords do not match",
  path: ["confirmPassword"],
});

export async function POST(req: Request) {
  const clientIP = req.headers.get('x-forwarded-for')?.split(',')[0] || 
                   req.headers.get('x-real-ip') || 
                   'unknown';
  
  let email: string | undefined;
  
  try {
    const body = await req.json();
    const validation = signupSchema.safeParse(body);

    if (!validation.success) {
      return Response.json({ errors: validation.error.flatten().fieldErrors }, { status: 400 });
    }

    const { name, email: validatedEmail, password, deviceId, deviceName, deviceToken: existingDeviceToken } = validation.data;
    email = validatedEmail;

    // Rate limiting by IP address and email (prevent spam and email enumeration)
    const ipRateLimit = checkRateLimit(clientIP, RATE_LIMIT_CONFIGS.SIGNUP);
    const emailRateLimit = checkRateLimit(email.toLowerCase(), RATE_LIMIT_CONFIGS.SIGNUP);

    if (!ipRateLimit.allowed) {
      logAuthEvent('failed', undefined, email, clientIP, 'IP rate limit exceeded');
      return Response.json(
        {
          error: 'Too many signup attempts from this IP address. Please try again later.',
          retryAfter: ipRateLimit.retryAfter
        },
        {
          status: 429,
          headers: {
            'Retry-After': ipRateLimit.retryAfter?.toString() || '3600'
          }
        }
      );
    }

    if (!emailRateLimit.allowed) {
      logAuthEvent('failed', undefined, email, clientIP, 'Email rate limit exceeded');
      return Response.json(
        {
          error: 'Too many signup attempts for this email. Please try again later.',
          retryAfter: emailRateLimit.retryAfter
        },
        {
          status: 429,
          headers: {
            'Retry-After': emailRateLimit.retryAfter?.toString() || '3600'
          }
        }
      );
    }

    const existingUser = await db.query.users.findFirst({
      where: eq(users.email, email),
    });

    if (existingUser) {
      logAuthEvent('failed', undefined, email, clientIP, 'Email already exists');
      return Response.json({ error: 'User with this email already exists' }, { status: 409 });
    }

    const hashedPassword = await bcrypt.hash(password, 12);

    const user = await db.insert(users).values({
      id: createId(),
      name,
      email,
      password: hashedPassword,
      // Storage tracking (quota/tier computed from subscriptionTier)
      storageUsedBytes: 0,
      subscriptionTier: 'free',
      tosAcceptedAt: new Date(),
    }).returning().then(res => res[0]);

    // Create a personal drive for the new user
    const driveName = `${user.name}'s Drive`;
    const driveSlug = slugify(driveName);
    await db.insert(drives).values({
      name: driveName,
      slug: driveSlug,
      ownerId: user.id,
      updatedAt: new Date(),
    });

    // Add default 'ollama' provider for the new user with Docker-compatible URL
    // This enables local AI models via Ollama for users with local deployments
    await db.insert(userAiSettings).values({
      userId: user.id,
      provider: 'ollama',
      baseUrl: 'http://host.docker.internal:11434', // Default Docker networking URL
      updatedAt: new Date(),
    });

    // Log successful signup
    logAuthEvent('signup', user.id, email, clientIP);
    loggers.auth.info('New user created', { userId: user.id, email, name });

    // Reset rate limits on successful signup
    resetRateLimit(clientIP);
    resetRateLimit(email.toLowerCase());

    // Track signup event
    trackAuthEvent(user.id, 'signup', {
      email,
      name,
      ip: clientIP,
      userAgent: req.headers.get('user-agent')
    });

    // Send verification email (don't block signup)
    try {
      const verificationToken = await createVerificationToken({
        userId: user.id,
        type: 'email_verification',
      });

      const baseUrl = process.env.WEB_APP_URL || process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000';
      const verificationUrl = `${baseUrl}/api/auth/verify-email?token=${verificationToken}`;

      await sendEmail({
        to: email,
        subject: 'Verify your PageSpace email',
        react: React.createElement(VerificationEmail, { userName: name, verificationUrl }),
      });

      loggers.auth.info('Verification email sent', { userId: user.id, email });

      // Create notification to verify email
      await createNotification({
        userId: user.id,
        type: 'EMAIL_VERIFICATION_REQUIRED',
        title: 'Please verify your email',
        message: 'Check your inbox for a verification link. You can resend it from your account settings.',
        metadata: {
          email,
          settingsUrl: '/settings/account',
        },
      });
    } catch (error) {
      // Don't fail signup if email fails
      loggers.auth.error('Failed to send verification email', error as Error, { userId: user.id });
    }

    // Generate JWT tokens for automatic authentication
    const accessToken = await generateAccessToken(user.id, user.tokenVersion, user.role);
    const refreshToken = await generateRefreshToken(user.id, user.tokenVersion, user.role);

    const refreshPayload = await decodeToken(refreshToken);
    const refreshExpiresAt = refreshPayload?.exp
      ? new Date(refreshPayload.exp * 1000)
      : new Date(Date.now() + getRefreshTokenMaxAge() * 1000);

    // Create or validate device token for web platform
    let deviceTokenValue: string | undefined;
    if (deviceId) {
      const { deviceToken: createdDeviceToken } = await validateOrCreateDeviceToken({
        providedDeviceToken: existingDeviceToken,
        userId: user.id,
        deviceId,
        platform: 'web',
        tokenVersion: user.tokenVersion,
        deviceName,
        userAgent: req.headers.get('user-agent') ?? undefined,
        ipAddress: clientIP !== 'unknown' ? clientIP : undefined,
      });
      deviceTokenValue = createdDeviceToken;
    }

    // Save refresh token
    await db.insert(refreshTokens).values({
      id: createId(),
      token: refreshToken,
      userId: user.id,
      device: req.headers.get('user-agent'),
      userAgent: req.headers.get('user-agent'),
      ip: clientIP,
      lastUsedAt: new Date(),
      platform: 'web',
      expiresAt: refreshExpiresAt,
    });

    const isProduction = process.env.NODE_ENV === 'production';

    // Set cookies and redirect to dashboard (matching Google OAuth pattern)
    const baseUrl = process.env.NEXTAUTH_URL || process.env.WEB_APP_URL || req.url;
    const redirectUrl = new URL('/dashboard', baseUrl);

    // Add auth success parameter to trigger auth state refresh
    redirectUrl.searchParams.set('auth', 'success');

    // Add device token to URL if created (will be stored in localStorage by client)
    if (deviceTokenValue) {
      redirectUrl.searchParams.set('deviceToken', deviceTokenValue);
    }

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

    return NextResponse.redirect(redirectUrl, {
      status: 303, // See Other - forces GET method on redirect
      headers
    });
  } catch (error) {
    loggers.auth.error('Signup error', error as Error, { email, clientIP });
    return Response.json({ error: 'An unexpected error occurred.' }, { status: 500 });
  }
}