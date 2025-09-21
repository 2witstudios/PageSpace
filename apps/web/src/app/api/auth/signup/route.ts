import { users, drives, userAiSettings, refreshTokens, db, eq } from '@pagespace/db';
import bcrypt from 'bcryptjs';
import { z } from 'zod/v4';
import { slugify, generateAccessToken, generateRefreshToken } from '@pagespace/lib/server';
import { createId } from '@paralleldrive/cuid2';
import { loggers, logAuthEvent } from '@pagespace/lib/logger-config';
import { trackAuthEvent } from '@pagespace/lib/activity-tracker';
import { serialize } from 'cookie';
// Removed AI defaults dependency

const signupSchema = z.object({
  name: z.string().min(1, {
      error: "Name is required"
}),
  email: z.email(),
  password: z.string().min(8, {
      error: "Password must be at least 8 characters long"
}),
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

    const { name, email: validatedEmail, password } = validation.data;
    email = validatedEmail;

    const existingUser = await db.query.users.findFirst({
      where: eq(users.email, email),
    });

    if (existingUser) {
      logAuthEvent('failed', undefined, email, clientIP, 'Email already exists');
      return Response.json({ error: 'User with this email already exists' }, { status: 409 });
    }

    const hashedPassword = await bcrypt.hash(password, 10);

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
    const driveName = `${user.name}'s Drive`;
    const driveSlug = slugify(driveName);
    const [newDrive] = await db.insert(drives).values({
      name: driveName,
      slug: driveSlug,
      ownerId: user.id,
      updatedAt: new Date(),
    }).returning();

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
    
    // Track signup event
    trackAuthEvent(user.id, 'signup', {
      email,
      name,
      ip: clientIP,
      userAgent: req.headers.get('user-agent')
    });

    // Generate JWT tokens for automatic authentication
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

    const isProduction = process.env.NODE_ENV === 'production';
    
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

    return Response.json({ 
      message: 'User created successfully',
      id: user.id,
      name: user.name,
      email: user.email,
      driveId: newDrive.id
    }, { status: 201, headers });
  } catch (error) {
    loggers.auth.error('Signup error', error as Error, { email, clientIP });
    return Response.json({ error: 'An unexpected error occurred.' }, { status: 500 });
  }
}