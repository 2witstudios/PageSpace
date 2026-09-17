import { db } from '@pagespace/db/db'
import { eq } from '@pagespace/db/operators'
import { users } from '@pagespace/db/schema/auth';
import { userEmailMatch, prepareUserWrite, decryptUserRow } from '@pagespace/lib/auth/user-repository';
import { decryptField } from '@pagespace/lib/encryption/field-crypto';
import { z } from 'zod';
import { loggers } from '@pagespace/lib/logging/logger-config';
import { accountRepository } from '@pagespace/lib/repositories/account-repository';
import { auditRequest } from '@pagespace/lib/audit/audit-log';
import { authenticateRequestWithOptions, isAuthError } from '@/lib/auth';
import { isValidEmail } from '@pagespace/lib/validators/email';
import { getActorInfo, logUserActivity } from '@pagespace/lib/monitoring/activity-logger';
import { planDriveDisposition } from '@pagespace/lib/compliance/erasure/drive-disposition';
import { dataSubjectRequestRepository } from '@pagespace/lib/repositories/data-subject-request-repository';
import { sendVerificationEmail } from '@/lib/auth/send-verification-email';
import { lodgeAndEnqueueErasure } from '@/lib/erasure/request-erasure';

const patchBodySchema = z
  .object({
    name: z.string().trim().min(1).optional(),
    email: z.string().trim().optional(),
  })
  .refine((data) => data.name !== undefined || data.email !== undefined, {
    message: 'At least one of name or email is required',
  });

const AUTH_OPTIONS_READ = { allow: ['session'] as const, requireCSRF: false };
const AUTH_OPTIONS_WRITE = { allow: ['session'] as const, requireCSRF: true };

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

  // Decrypt PII at the edge so the account view shows plaintext email/name.
  const decrypted = await decryptUserRow(user);

  return Response.json({
    id: decrypted.id,
    name: decrypted.name,
    email: decrypted.email,
    image: decrypted.image,
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
    const parsed = patchBodySchema.safeParse(body);

    if (!parsed.success) {
      return Response.json({ error: 'At least one of name or email is required' }, { status: 400 });
    }

    const { name, email } = parsed.data;

    if (email !== undefined && !isValidEmail(email)) {
      return Response.json({ error: 'Invalid email format' }, { status: 400 });
    }

    const normalizedEmail = email !== undefined ? email.toLowerCase().trim() : undefined;
    let emailChanged = false;
    if (normalizedEmail !== undefined) {
      // Decide "changed" by comparing against the caller's CURRENT stored
      // address (case-insensitively). Inferring it from a uniqueness miss is
      // unsound: emails are not guaranteed lowercase at rest (OAuth stores the
      // provider value verbatim), so a case-sensitive lookup would miss the
      // user's own row and spuriously de-verify them on a no-op resubmit.
      const current = await db.query.users.findFirst({
        where: eq(users.id, userId),
        columns: { email: true },
      });
      // Decrypt the stored email before the case-insensitive comparison so a
      // ciphertext value is compared as plaintext (legacy plaintext passes through).
      const currentEmailPlain = current ? await decryptField(current.email) : '';
      emailChanged = (currentEmailPlain ?? '').toLowerCase() !== normalizedEmail;

      if (emailChanged) {
        const existingUser = await db.query.users.findFirst({
          where: userEmailMatch(normalizedEmail),
        });
        if (existingUser && existingUser.id !== userId) {
          return Response.json({ error: 'Email is already in use' }, { status: 400 });
        }
      }
    }

    const updates: { name?: string; email?: string; emailVerified?: Date | null } = {};
    if (name !== undefined) updates.name = name;
    if (normalizedEmail !== undefined) updates.email = normalizedEmail;
    // A new address must be re-verified — the old verification proved ownership
    // of a different inbox. Verification is re-issued via the email below.
    if (emailChanged) updates.emailVerified = null;

    const [updatedRow] = await db
      .update(users)
      // Encrypt email/name + recompute emailBidx (when email present) per the flag.
      .set(await prepareUserWrite(updates))
      .where(eq(users.id, userId))
      .returning({
        id: users.id,
        name: users.name,
        email: users.email,
        image: users.image,
      });

    if (!updatedRow) {
      return Response.json({ error: 'Failed to update user' }, { status: 500 });
    }

    // Decrypt PII at the edge so the response, verification email, and activity
    // log all see plaintext email/name.
    const updatedUser = await decryptUserRow(updatedRow);

    // Send a verification email to the NEW address. Best-effort: a delivery
    // failure must not fail the profile update — the user can resend from the
    // account banner.
    if (emailChanged) {
      try {
        await sendVerificationEmail({
          userId,
          email: updatedUser.email,
          userName: updatedUser.name,
        });
      } catch (error) {
        loggers.auth.warn('Failed to send verification email after email change', {
          userId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    // Log activity for audit trail (profile updates may be security-relevant)
    const actorInfo = await getActorInfo(userId);
    const updatedFields: string[] = [];
    if (name !== undefined) updatedFields.push('name');
    if (email !== undefined) updatedFields.push('email');
    logUserActivity(userId, 'profile_update', {
      targetUserId: userId,
      targetUserEmail: updatedUser.email,
      updatedFields,
    }, actorInfo);

    auditRequest(req, { eventType: 'data.write', userId, resourceType: 'account', resourceId: userId, details: { operation: 'profile_update', updatedFields } });

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

    // Idempotency: surface an in-flight erasure rather than enqueuing a second.
    const existing = await dataSubjectRequestRepository.findActiveErasureForUser(userId);
    if (existing) {
      return Response.json(
        {
          message: 'Account erasure already in progress',
          requestId: existing.id,
          status: existing.status,
          slaDeadline: existing.slaDeadline,
        },
        { status: 202 }
      );
    }

    // Self-service cannot orphan co-owned drives. Multi-member ownership blocks
    // with guidance; the admin force-delete route is the escalation path (#908).
    const ownedDrives = await accountRepository.getOwnedDrives(userId);
    const drivesWithMembers = await Promise.all(
      ownedDrives.map(async (drive) => ({
        id: drive.id,
        name: drive.name,
        memberCount: await accountRepository.getDriveMemberCount(drive.id),
      }))
    );
    const disposition = planDriveDisposition(drivesWithMembers, { forceDelete: false });
    if (disposition.blocked) {
      return Response.json(
        {
          error:
            'You must transfer ownership or delete all drives with other members before deleting your account',
          multiMemberDrives: disposition.multiMemberDriveNames,
        },
        { status: 400 }
      );
    }

    // Evidence the request receipt (best-effort) — the SLA clock starts now.
    auditRequest(req, {
      eventType: 'data.delete',
      userId,
      resourceType: 'account',
      resourceId: userId,
      details: { operation: 'erasure_request', requestedByType: 'self' },
    });

    const { requestId, slaDeadline } = await lodgeAndEnqueueErasure({
      subjectUserId: userId,
      subjectEmail: user.email,
      stripeCustomerId: user.stripeCustomerId,
      callerUserId: userId,
      requestedByType: 'self',
      forceDelete: false,
    });

    loggers.auth.info(`Account erasure queued for user ${userId} (request ${requestId})`);

    return Response.json(
      { message: 'Account erasure queued', requestId, status: 'queued', slaDeadline },
      { status: 202 }
    );
  } catch (error) {
    loggers.auth.error('Account erasure request error:', error as Error);
    return Response.json({ error: 'Failed to queue account erasure' }, { status: 500 });
  }
}