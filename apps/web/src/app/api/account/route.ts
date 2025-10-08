import { users, db, eq } from '@pagespace/db';
import { loggers } from '@pagespace/lib/server';
import { authenticateRequestWithOptions, isAuthError } from '@/lib/auth';

const AUTH_OPTIONS = { allow: ['jwt'] as const, requireCSRF: true };

export async function GET(req: Request) {
  const auth = await authenticateRequestWithOptions(req, AUTH_OPTIONS);
  if (isAuthError(auth)) {
    return auth.error;
  }
  const userId = auth.userId;
  const tokenVersion = auth.tokenVersion;

  const user = await db.query.users.findFirst({
    where: eq(users.id, userId),
    columns: {
      id: true,
      name: true,
      email: true,
      image: true,
      tokenVersion: true,
    },
  });

  if (!user || user.tokenVersion !== tokenVersion) {
    return Response.json({ error: 'Invalid token version' }, { status: 401 });
  }

  return Response.json({
    id: user.id,
    name: user.name,
    email: user.email,
    image: user.image,
  });
}

export async function PATCH(req: Request) {
  const auth = await authenticateRequestWithOptions(req, AUTH_OPTIONS);
  if (isAuthError(auth)) {
    return auth.error;
  }
  const userId = auth.userId;

  try {
    const body = await req.json();
    const { name, email } = body;

    // Validate inputs
    if (!name || !email) {
      return Response.json({ error: 'Name and email are required' }, { status: 400 });
    }

    // Email validation
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email)) {
      return Response.json({ error: 'Invalid email format' }, { status: 400 });
    }

    // Check if email is already taken by another user
    if (email) {
      const existingUser = await db.query.users.findFirst({
        where: eq(users.email, email),
      });

      if (existingUser && existingUser.id !== userId) {
        return Response.json({ error: 'Email is already in use' }, { status: 400 });
      }
    }

    // Update user
    const [updatedUser] = await db
      .update(users)
      .set({
        name: name.trim(),
        email: email.trim().toLowerCase(),
      })
      .where(eq(users.id, userId))
      .returning({
        id: users.id,
        name: users.name,
        email: users.email,
        image: users.image,
      });

    if (!updatedUser) {
      return Response.json({ error: 'Failed to update user' }, { status: 500 });
    }

    return Response.json({
      id: updatedUser.id,
      name: updatedUser.name,
      email: updatedUser.email,
      image: updatedUser.image,
    });
  } catch (error) {
    loggers.auth.error('Profile update error:', error as Error);
    return Response.json({ error: 'Failed to update profile' }, { status: 500 });
  }
}