import { users, db, eq } from '@pagespace/db';
import { createHash } from 'crypto';
import { loggers, accountRepository, activityLogRepository } from '@pagespace/lib/server';
import { authenticateRequestWithOptions, isAuthError } from '@/lib/auth';
import { createServiceToken, verifyServiceToken, type ServiceTokenClaims } from '@pagespace/lib/auth-utils';

const AUTH_OPTIONS_READ = { allow: ['jwt'] as const, requireCSRF: false };
const AUTH_OPTIONS_WRITE = { allow: ['jwt'] as const, requireCSRF: true };

export async function GET(req: Request) {
  const auth = await authenticateRequestWithOptions(req, AUTH_OPTIONS_READ);
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
  const auth = await authenticateRequestWithOptions(req, AUTH_OPTIONS_WRITE);
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

// Processor service URL
const PROCESSOR_URL = process.env.PROCESSOR_URL || 'http://processor:3003';

/**
 * Create an anonymized identifier for GDPR-compliant audit trail preservation.
 * Uses a deterministic hash so the same user ID always produces the same anonymized ID.
 */
function createAnonymizedActorEmail(userId: string): string {
  const hash = createHash('sha256').update(userId).digest('hex').slice(0, 12);
  return `deleted_user_${hash}`;
}

interface AvatarServiceToken {
  token: string;
  claims: ServiceTokenClaims;
}

const REQUIRED_AVATAR_SCOPES: ServiceTokenClaims['scopes'] = ['avatars:write'];

async function createAvatarServiceToken(userId: string, expirationTime: string): Promise<AvatarServiceToken> {
  const token = await createServiceToken('web', REQUIRED_AVATAR_SCOPES, {
    userId,
    tenantId: userId,
    expirationTime,
  });

  const claims = await verifyServiceToken(token);
  if (!claims) {
    throw new Error('Avatar service token verification failed');
  }

  const missingScopes = REQUIRED_AVATAR_SCOPES.filter((scope) => !claims.scopes.includes(scope));
  if (missingScopes.length > 0) {
    throw new Error(
      `Avatar service token missing required scopes: ${missingScopes.join(', ')} (scopes: ${
        claims.scopes.join(', ') || 'none'
      })`
    );
  }

  return { token, claims };
}

export async function DELETE(req: Request) {
  const auth = await authenticateRequestWithOptions(req, AUTH_OPTIONS_WRITE);
  if (isAuthError(auth)) {
    return auth.error;
  }
  const userId = auth.userId;

  try {
    const body = await req.json();
    const { emailConfirmation } = body;

    // Get user details via repository seam
    const user = await accountRepository.findById(userId);

    if (!user) {
      return Response.json({ error: 'User not found' }, { status: 404 });
    }

    // Validate email confirmation
    if (!emailConfirmation || emailConfirmation.trim().toLowerCase() !== user.email.toLowerCase()) {
      return Response.json({ error: 'Email confirmation does not match your account email' }, { status: 400 });
    }

    // Check and categorize owned drives via repository seam
    const ownedDrives = await accountRepository.getOwnedDrives(userId);

    if (ownedDrives.length > 0) {
      const driveIds = ownedDrives.map(d => d.id);

      // Count members for each drive via repository seam
      const memberCounts = await Promise.all(
        driveIds.map(async (driveId) => ({
          driveId,
          memberCount: await accountRepository.getDriveMemberCount(driveId),
        }))
      );

      // Categorize into solo and multi-member drives
      const soloDriveIds = [];
      const multiMemberDrives = [];

      for (const drive of ownedDrives) {
        const memberCountData = memberCounts.find(mc => mc.driveId === drive.id);
        const memberCount = memberCountData?.memberCount || 0;

        if (memberCount <= 1) {
          soloDriveIds.push(drive.id);
        } else {
          multiMemberDrives.push(drive);
        }
      }

      // Block deletion if multi-member drives still exist
      if (multiMemberDrives.length > 0) {
        return Response.json(
          {
            error: 'You must transfer ownership or delete all drives with other members before deleting your account',
            multiMemberDrives: multiMemberDrives.map(d => d.name),
          },
          { status: 400 }
        );
      }

      // Auto-delete solo drives via repository seam
      if (soloDriveIds.length > 0) {
        for (const driveId of soloDriveIds) {
          await accountRepository.deleteDrive(driveId);
        }
        loggers.auth.info(`Auto-deleted ${soloDriveIds.length} solo drives for user ${userId}`);
      }
    }

    // Delete user's avatar if it exists and is a local file
    if (user.image && !user.image.startsWith('http://') && !user.image.startsWith('https://')) {
      try {
        const { token: serviceToken } = await createAvatarServiceToken(userId, '2m');

        await fetch(`${PROCESSOR_URL}/api/avatar/${userId}`, {
          method: 'DELETE',
          headers: {
            'Authorization': `Bearer ${serviceToken}`
          }
        });
      } catch (error) {
        // Log error but don't fail the deletion
        loggers.auth.error('Could not delete user avatar during account deletion:', error as Error);
      }
    }

    // Anonymize activity logs before user deletion (GDPR compliance + SOX audit trail)
    // This preserves the audit trail while removing PII
    const anonymizeResult = await activityLogRepository.anonymizeForUser(
      userId,
      createAnonymizedActorEmail(userId)
    );
    if (anonymizeResult.success) {
      loggers.auth.info(`Anonymized activity logs for user ${userId}`);
    } else {
      // Log error but don't fail the deletion - user has right to delete their account
      loggers.auth.error('Could not anonymize activity logs during account deletion:', new Error(anonymizeResult.error));
    }

    // Delete the user via repository seam (FK set null will preserve activity logs with userId = null)
    await accountRepository.deleteUser(userId);

    loggers.auth.info(`User account deleted: ${userId}`);

    return Response.json({ message: 'Account deleted successfully' }, { status: 200 });
  } catch (error) {
    loggers.auth.error('Account deletion error:', error as Error);
    return Response.json({ error: 'Failed to delete account' }, { status: 500 });
  }
}