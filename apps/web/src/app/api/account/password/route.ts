import { users, db, eq } from '@pagespace/db';
import bcrypt from 'bcryptjs';
import { loggers } from '@pagespace/lib/server';
import { authenticateRequestWithOptions, isAuthError } from '@/lib/auth';

const AUTH_OPTIONS = { allow: ['jwt'] as const, requireCSRF: true };

export async function POST(req: Request) {
  const auth = await authenticateRequestWithOptions(req, AUTH_OPTIONS);
  if (isAuthError(auth)) {
    return auth.error;
  }
  const userId = auth.userId;
  const tokenVersion = auth.tokenVersion;

  try {
    const body = await req.json();
    const { currentPassword, newPassword } = body;

    // Validate inputs
    if (!currentPassword || !newPassword) {
      return Response.json({ error: 'Current and new password are required' }, { status: 400 });
    }

    // Check password length
    if (newPassword.length < 8) {
      return Response.json({ error: 'Password must be at least 8 characters long' }, { status: 400 });
    }

    // Get user with password
    const user = await db.query.users.findFirst({
      where: eq(users.id, userId),
      columns: {
        id: true,
        password: true,
        tokenVersion: true,
      },
    });

    if (!user || user.tokenVersion !== tokenVersion) {
      return Response.json({ error: 'Invalid token version' }, { status: 401 });
    }

    if (!user.password) {
      return Response.json({ error: 'User does not have a password set' }, { status: 400 });
    }

    // Verify current password
    const isValidPassword = await bcrypt.compare(currentPassword, user.password);
    if (!isValidPassword) {
      return Response.json({ error: 'Current password is incorrect' }, { status: 400 });
    }

    // Hash new password
    const hashedPassword = await bcrypt.hash(newPassword, 10);

    // Update password and increment token version to invalidate existing sessions
    await db
      .update(users)
      .set({
        password: hashedPassword,
        tokenVersion: user.tokenVersion + 1, // This will log out all sessions
      })
      .where(eq(users.id, userId));

    return Response.json({ 
      message: 'Password changed successfully. Please log in again with your new password.' 
    });
  } catch (error) {
    loggers.auth.error('Password change error:', error as Error);
    return Response.json({ error: 'Failed to change password' }, { status: 500 });
  }
}