import { withAdminAuth } from '@/lib/auth';
import { z } from 'zod';
import { loggers } from '@pagespace/lib/logging/logger-config';
import { accountRepository } from '@pagespace/lib/repositories/account-repository';
import { dataSubjectRequestRepository } from '@pagespace/lib/repositories/data-subject-request-repository';
import { lodgeAndEnqueueErasure } from '@/lib/erasure/request-erasure';

/**
 * Admin-gated Right-to-Erasure escalation (#908).
 *
 * The self-service path hard-blocks when the subject still owns multi-member
 * drives. This route is the escalation: an admin can FORCE-delete those drives
 * (orphaning co-members) when ownership transfer is impossible, satisfying the
 * Art 17 obligation. Requires an explicit typed confirmation to prevent fat
 * fingers, and records who escalated + the legal basis on the DSR row.
 */

const bodySchema = z.object({
  userId: z.string().min(1),
  forceDelete: z.boolean().optional().default(true),
  legalBasis: z.string().trim().min(1).optional(),
  // Must equal `ERASE <userId>` — proves the admin meant this exact subject.
  confirmation: z.string().min(1),
});

export const POST = withAdminAuth(async (admin, request) => {
  let parsed;
  try {
    parsed = bodySchema.parse(await request.json());
  } catch {
    return Response.json({ error: 'Invalid request body' }, { status: 400 });
  }

  const { userId, forceDelete, legalBasis, confirmation } = parsed;

  if (confirmation.trim() !== `ERASE ${userId}`) {
    return Response.json(
      { error: `Confirmation must be exactly "ERASE ${userId}"` },
      { status: 400 }
    );
  }

  const subject = await accountRepository.findById(userId);
  if (!subject) {
    return Response.json({ error: 'Target user not found' }, { status: 404 });
  }

  const existing = await dataSubjectRequestRepository.findActiveErasureForUser(userId);
  if (existing) {
    return Response.json(
      { message: 'Erasure already in progress', requestId: existing.id, status: existing.status },
      { status: 202 }
    );
  }

  try {
    const { requestId, jobId, slaDeadline } = await lodgeAndEnqueueErasure({
      subjectUserId: userId,
      subjectEmail: subject.email,
      stripeCustomerId: subject.stripeCustomerId,
      callerUserId: admin.id,
      requestedByType: 'admin',
      forceDelete,
      legalBasis: legalBasis ?? 'admin_escalation',
    });

    loggers.auth.info(
      `Admin ${admin.id} lodged force-delete erasure for ${userId} (request ${requestId}, force=${forceDelete})`
    );

    return Response.json(
      { message: 'Account erasure queued', requestId, jobId, forceDelete, slaDeadline },
      { status: 202 }
    );
  } catch (error) {
    loggers.auth.error('Admin erasure escalation failed:', error as Error);
    return Response.json({ error: 'Failed to queue account erasure' }, { status: 500 });
  }
});
