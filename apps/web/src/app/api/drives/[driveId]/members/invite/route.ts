import { NextResponse } from 'next/server';
import { z } from 'zod/v4';
import { authenticateRequestWithOptions, isAuthError } from '@/lib/auth';
import { isHomeDrive, homeDriveActionError } from '@pagespace/lib/services/drive-guards';
import { isEmailVerified } from '@pagespace/lib/auth/verification-utils';
import { loggers } from '@pagespace/lib/logging/logger-config';
import { auditRequest } from '@pagespace/lib/audit/audit-log';
import { driveInviteRepository } from '@/lib/repositories/drive-invite-repository';
import { canAdministerDrive } from '@pagespace/lib/permissions/drive-relationship';
import { loadDriveRelationship } from '@pagespace/lib/permissions/drive-relationship-loader';
import { handleEmailPath, handleUserIdPath } from '@/lib/drive-invites/invite-handlers';

const AUTH_OPTIONS = { allow: ['session'] as const, requireCSRF: true };

const permissionEntrySchema = z.object({
  pageId: z.string().min(1),
  canView: z.boolean(),
  canEdit: z.boolean(),
  canShare: z.boolean(),
});

// Discriminated by which identity field is present. Role enum is enforced
// here at the boundary — PR #1229 took the role through a TypeScript cast
// and accepted 'OWNER' silently. Zod refuses it now.
const inviteBodySchema = z.union([
  z.object({
    userId: z.string().min(1),
    role: z.enum(['MEMBER', 'ADMIN']).default('MEMBER'),
    customRoleId: z.string().nullable().optional(),
    permissions: z.array(permissionEntrySchema).default([]),
  }),
  z.object({
    email: z.string().trim().toLowerCase().pipe(z.string().email().max(254)),
    role: z.enum(['MEMBER', 'ADMIN']).default('MEMBER'),
    customRoleId: z.string().nullable().optional(),
    permissions: z.array(permissionEntrySchema).default([]),
    expiryDays: z.number().int().min(1).max(365).nullable().optional(),
  }),
]);


export async function POST(
  request: Request,
  context: { params: Promise<{ driveId: string }> }
) {
  try {
    const auth = await authenticateRequestWithOptions(request, AUTH_OPTIONS);
    if (isAuthError(auth)) return auth.error;
    const inviterUserId = auth.userId;

    const { driveId } = await context.params;

    const emailVerified = await isEmailVerified(inviterUserId);
    if (!emailVerified) {
      return NextResponse.json(
        {
          error: 'Email verification required. Please verify your email to perform this action.',
          requiresEmailVerification: true,
        },
        { status: 403 }
      );
    }

    let rawBody: unknown;
    try {
      rawBody = await request.json();
    } catch {
      return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
    }

    const parsed = inviteBodySchema.safeParse(rawBody);
    if (!parsed.success) {
      return NextResponse.json(
        { error: 'Invalid request body', issues: parsed.error.issues },
        { status: 400 }
      );
    }
    const body = parsed.data;

    const drive = await driveInviteRepository.findDriveById(driveId);
    if (!drive) {
      return NextResponse.json({ error: 'Drive not found' }, { status: 404 });
    }

    if (isHomeDrive(drive)) {
      return NextResponse.json({ error: homeDriveActionError(drive, 'invite') }, { status: 403 });
    }

    // The drive's lead or an effective ADMIN. The org-aware membership reads ACCEPTED rows only, so
    // a pending admin cannot exercise admin powers; an org Owner/Admin invites as ADMIN.
    if (!canAdministerDrive(await loadDriveRelationship(inviterUserId, drive))) {
      auditRequest(request, {
        eventType: 'authz.access.denied',
        userId: inviterUserId,
        resourceType: 'drive',
        resourceId: driveId,
        details: { operation: 'invite', reason: 'not_drive_admin' },
      });
      return NextResponse.json(
        { error: 'Only drive owners and admins can add members' },
        { status: 403 }
      );
    }

    if ('userId' in body) {
      return await handleUserIdPath({
        request,
        body,
        drive,
        driveId,
        inviterUserId,
      });
    }

    return await handleEmailPath({
      request,
      body,
      drive,
      driveId,
      inviterUserId,
    });
  } catch (error) {
    loggers.api.error('Error adding member:', error as Error);
    return NextResponse.json({ error: 'Failed to add member' }, { status: 500 });
  }
}
