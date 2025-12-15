import { users, drives, userAiSettings, db, eq } from '@pagespace/db';
import bcrypt from 'bcryptjs';
import { z } from 'zod/v4';
import {
  slugify,
  generateAccessToken,
  checkRateLimit,
  resetRateLimit,
  RATE_LIMIT_CONFIGS,
  createNotification,
  decodeToken,
  validateOrCreateDeviceToken,
} from '@pagespace/lib/server';
import { generateCSRFToken, getSessionIdFromJWT } from '@pagespace/lib/server';
import { createId } from '@paralleldrive/cuid2';
import { loggers, logAuthEvent } from '@pagespace/lib/server';
import { trackAuthEvent } from '@pagespace/lib/activity-tracker';
import { createVerificationToken } from '@pagespace/lib/verification-utils';
import { sendEmail } from '@pagespace/lib/services/email-service';
import { VerificationEmail } from '@pagespace/lib/email-templates/VerificationEmail';
import React from 'react';
import { populateUserDrive } from '@/lib/onboarding/drive-setup';

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
  deviceId: z.string().min(1, { message: 'Device identifier is required' }),
  platform: z.enum(['ios', 'android', 'desktop']).default('ios'),
  deviceName: z.string().optional(),
  appVersion: z.string().optional(),
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

    const {
      name,
      email: validatedEmail,
      password,
      deviceId,
      platform,
      deviceName,
      appVersion,
    } = validation.data;
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
    }).returning().then(res => res[0]);

    // Create a personal drive for the new user
    const driveName = 'Getting Started';
    const driveSlug = slugify(driveName);
    const newDrive = await db.insert(drives).values({
      name: driveName,
      slug: driveSlug,
      ownerId: user.id,
      updatedAt: new Date(),
    }).returning().then(res => res[0]);

    if (newDrive) {
      await populateUserDrive(user.id, newDrive.id);
    }

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
    loggers.auth.info('New user created via mobile', { userId: user.id, email, name, platform });

    // Reset rate limits on successful signup
    resetRateLimit(clientIP);
    resetRateLimit(email.toLowerCase());

    // Track signup event
    trackAuthEvent(user.id, 'signup', {
      email,
      name,
      ip: clientIP,
      userAgent: req.headers.get('user-agent'),
      platform,
      appVersion,
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

    // Device token only - no refresh token needed for mobile (90-day sessions)
    const { deviceToken } = await validateOrCreateDeviceToken({
      providedDeviceToken: null,
      userId: user.id,
      deviceId,
      platform,
      tokenVersion: user.tokenVersion,
      deviceName: deviceName || undefined,
      userAgent: req.headers.get('user-agent') || undefined,
      ipAddress: clientIP,
    });

    // Generate CSRF token for mobile client
    // Decode the access token to get its actual iat claim
    const decoded = await decodeToken(accessToken);
    if (!decoded?.iat) {
      loggers.auth.error('Failed to decode access token for CSRF generation');
      return Response.json({ error: 'Failed to generate session' }, { status: 500 });
    }

    const sessionId = getSessionIdFromJWT({
      userId: user.id,
      tokenVersion: user.tokenVersion,
      iat: decoded.iat
    });
    const csrfToken = generateCSRFToken(sessionId);

    // Return tokens in JSON body for mobile clients (device-token-only pattern)
    return Response.json({
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        image: user.image,
      },
      token: accessToken,
      csrfToken: csrfToken,
      deviceToken,
    }, { status: 201 });
  } catch (error) {
    loggers.auth.error('Mobile signup error', error as Error, { email, clientIP });
    return Response.json({ error: 'An unexpected error occurred.' }, { status: 500 });
  }
}
