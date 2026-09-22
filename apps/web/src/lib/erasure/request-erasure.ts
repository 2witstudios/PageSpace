import { db } from '@pagespace/db/db';
import { eq, sql } from '@pagespace/db/operators';
import { users } from '@pagespace/db/schema/auth';
import { loggers } from '@pagespace/lib/logging/logger-config';
import { isCloud } from '@pagespace/lib/deployment-mode';
import { dataSubjectRequestRepository } from '@pagespace/lib/repositories/data-subject-request-repository';
import type { DataSubjectRequesterType, DataSubjectRequestStepResult } from '@pagespace/db/schema/data-subject-requests';
import {
  revokeAndDiscardAppleTokens,
  appleSignInDeletionOutcome,
  type AppleRevocationSummary,
  type AppleSignInDeletionOutcome,
} from '@pagespace/lib/auth/apple/revoke-apple-tokens';
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
  /** The subject has signed in with Apple (users.appleId is set). */
  subjectAppleLinked: boolean;
}

export interface LodgeErasureResult {
  requestId: string;
  jobId: string;
  slaDeadline: Date;
  /** What the delete flow must tell the user about Sign in with Apple. */
  appleSignIn: AppleSignInDeletionOutcome;
}

/**
 * Lodge a Right-to-Erasure request and hand it to the durable queue (#906).
 *
 * The DSR row is created FIRST so the request is evidenced within the Art 12(3)
 * SLA even if downstream steps fail. Stripe deletion runs here (its SDK lives in
 * the web app, not the processor) as a best-effort step recorded on the row,
 * and so does Sign in with Apple token revocation (the processor holds no
 * ENCRYPTION_KEY to decrypt the stored token);
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

  const appleSignIn = await revokeAppleSignIn(request.id, input);

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
    // request can be lodged, then surface the failure to the caller. The subject
    // is NOT locked out here: their erasure was not queued, so they must remain
    // able to use their account (and retry) — locking out on a 500 would log
    // them out behind a "deletion failed" error.
    const message = error instanceof Error ? error.message : String(error);
    await dataSubjectRequestRepository.markFailed(request.id, `enqueue failed: ${message}`);
    throw error;
  }

  // Lock the subject out immediately, now that the erasure is durably queued —
  // they (or an admin) have requested erasure and a worker will process it.
  try {
    await db
      .update(users)
      .set({ tokenVersion: sql`${users.tokenVersion} + 1` })
      .where(eq(users.id, input.subjectUserId));
  } catch (error) {
    loggers.auth.error('Could not bump tokenVersion during erasure lodge:', error as Error);
  }

  // Guarded pending|blocked -> queued: never regress a row the worker may have
  // already advanced to in_progress/completed in the time since enqueue.
  await dataSubjectRequestRepository.markQueued(request.id, jobId);

  return { requestId: request.id, jobId, slaDeadline: request.slaDeadline, appleSignIn };
}

/**
 * Guideline 5.1.1(v) / TN3194: revoke the subject's stored Sign in with Apple
 * tokens and discard them. Runs BEFORE the job is queued — the worker's
 * delete-user cascades the token rows away, so revoking afterwards could race
 * it and find nothing to revoke. Trade-off, accepted: if the enqueue then fails
 * the account survives with its Apple authorization already revoked; the user
 * simply consents again at their next Sign in with Apple. Best-effort: nothing here may stop the
 * deletion, and anything short of a full revocation tells the user to finish
 * in their Apple Account settings.
 */
async function revokeAppleSignIn(requestId: string, input: LodgeErasureInput): Promise<AppleSignInDeletionOutcome> {
  let summary: AppleRevocationSummary | null = null;
  let stepResult: Pick<DataSubjectRequestStepResult, 'status' | 'detail'>;
  try {
    summary = await revokeAndDiscardAppleTokens(input.subjectUserId);
    stepResult = !summary.hadTokens
      ? { status: 'skipped', detail: 'no stored Apple token' }
      : summary.unconfigured
        ? // Discarded but NOT revoked: the Apple authorization is still live.
          { status: 'failed', detail: 'tokens discarded unrevoked; Apple signing key not configured' }
        : { status: summary.failed > 0 ? 'failed' : 'ok', detail: `revoked=${summary.revoked} failed=${summary.failed}` };
  } catch (error) {
    loggers.auth.error('Could not revoke Sign in with Apple tokens during erasure:', error as Error);
    stepResult = { status: 'failed', detail: error instanceof Error ? error.message : String(error) };
  }

  // Recording is evidence only; its failure must neither stop the deletion nor
  // relabel a revocation that happened.
  await dataSubjectRequestRepository
    .appendStepResult(requestId, { step: 'revoke-apple-tokens', ...stepResult, at: new Date().toISOString() })
    .catch((error: unknown) => {
      loggers.auth.error('Could not record the Sign in with Apple revocation step:', error as Error);
    });

  return appleSignInDeletionOutcome({ appleLinked: input.subjectAppleLinked, summary });
}
