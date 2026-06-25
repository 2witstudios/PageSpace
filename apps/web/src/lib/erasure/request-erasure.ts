import { db } from '@pagespace/db/db';
import { eq, sql } from '@pagespace/db/operators';
import { users } from '@pagespace/db/schema/auth';
import { loggers } from '@pagespace/lib/logging/logger-config';
import { isCloud } from '@pagespace/lib/deployment-mode';
import { dataSubjectRequestRepository } from '@pagespace/lib/repositories/data-subject-request-repository';
import type { DataSubjectRequesterType } from '@pagespace/db/schema/data-subject-requests';
import { stripe } from '@/lib/stripe/client';
import { enqueueAccountErasure } from './enqueue';

export interface LodgeErasureInput {
  subjectUserId: string;
  subjectEmail: string;
  stripeCustomerId: string | null;
  callerUserId: string;
  requestedByType: DataSubjectRequesterType;
  forceDelete: boolean;
  legalBasis?: string | null;
}

export interface LodgeErasureResult {
  requestId: string;
  jobId: string;
  slaDeadline: Date;
}

/**
 * Lodge a Right-to-Erasure request and hand it to the durable queue (#906).
 *
 * The DSR row is created FIRST so the request is evidenced within the Art 12(3)
 * SLA even if downstream steps fail. Stripe deletion runs here (its SDK lives in
 * the web app, not the processor) as a best-effort step recorded on the row;
 * the user's sessions are invalidated immediately by bumping tokenVersion; the
 * heavy, irreversible erasure runs asynchronously in the processor worker.
 */
export async function lodgeAndEnqueueErasure(input: LodgeErasureInput): Promise<LodgeErasureResult> {
  const now = new Date();

  const request = await dataSubjectRequestRepository.create({
    userId: input.subjectUserId,
    subjectEmail: input.subjectEmail,
    requestType: 'erasure',
    forceDelete: input.forceDelete,
    requestedByUserId: input.callerUserId,
    requestedByType: input.requestedByType,
    legalBasis: input.legalBasis ?? null,
    receivedAt: now,
  });

  // Stripe customer deletion (cloud-only; SDK is web-side). Best-effort —
  // erasure cannot be gated on Stripe availability.
  if (isCloud() && input.stripeCustomerId) {
    try {
      await stripe.customers.del(input.stripeCustomerId);
      await dataSubjectRequestRepository.appendStepResult(request.id, {
        step: 'stripe-customer',
        status: 'ok',
        detail: `deleted ${input.stripeCustomerId}`,
        at: new Date().toISOString(),
      });
    } catch (error) {
      await dataSubjectRequestRepository.appendStepResult(request.id, {
        step: 'stripe-customer',
        status: 'failed',
        detail: error instanceof Error ? error.message : String(error),
        at: new Date().toISOString(),
      });
      loggers.auth.error('Could not delete Stripe customer during erasure:', error as Error);
    }
  } else {
    await dataSubjectRequestRepository.appendStepResult(request.id, {
      step: 'stripe-customer',
      status: 'skipped',
      detail: 'no Stripe customer / non-cloud deployment',
      at: new Date().toISOString(),
    });
  }

  // Lock the subject out immediately — they (or an admin) have requested erasure.
  try {
    await db
      .update(users)
      .set({ tokenVersion: sql`${users.tokenVersion} + 1` })
      .where(eq(users.id, input.subjectUserId));
  } catch (error) {
    loggers.auth.error('Could not bump tokenVersion during erasure lodge:', error as Error);
  }

  let jobId: string;
  try {
    jobId = await enqueueAccountErasure({
      requestId: request.id,
      userId: input.subjectUserId,
      callerUserId: input.callerUserId,
    });
  } catch (error) {
    // The DSR row exists but no job was queued. Leaving it `pending` would make
    // `findActiveErasureForUser` report a phantom in-flight erasure that no
    // worker will ever process, blocking retries. Mark it failed so a fresh
    // request can be lodged, then surface the failure to the caller.
    const message = error instanceof Error ? error.message : String(error);
    await dataSubjectRequestRepository.markFailed(request.id, `enqueue failed: ${message}`);
    throw error;
  }

  // Guarded pending|blocked -> queued: never regress a row the worker may have
  // already advanced to in_progress/completed in the time since enqueue.
  await dataSubjectRequestRepository.markQueued(request.id, jobId);

  return { requestId: request.id, jobId, slaDeadline: request.slaDeadline };
}
