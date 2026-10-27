/**
 * Durable admin-console email-broadcast worker.
 *
 * pg-boss invokes this for each `email-broadcast` job. It re-reads the
 * email_broadcasts row for the authoritative state (the job payload carries only
 * the id), wires the concrete side effects — the transactional engine, the
 * broadcast_recipients ledger, the audience keyset walk — and hands each page of
 * rows to the pure `runBroadcast` orchestrator from @pagespace/lib.
 *
 * The safety contract, in one place:
 *  - A thrown error propagates to pg-boss and the job retries with backoff. A
 *    retry is safe because resume state lives in the ledger: already-sent
 *    addresses are loaded up front, each recipient is CLAIMED (DB-clock lease)
 *    before the provider call, and `UNIQUE(broadcastId, userId)` plus the
 *    `broadcast:<id>:<userId>` idempotency key backstop the races.
 *  - A refusal (on-prem live send, failed preflight, unresolvable content,
 *    unreachable CTA) is terminal-for-retry: the row is marked `failed` with the
 *    reason in `blockedReason` and the worker RETURNS, because retrying a config
 *    problem just re-fails it. Retryable failures set `lastError` and THROW.
 *  - Per-recipient send failures — including sendEmail's 3/hr rate-limit throw —
 *    are recorded `failed` (never `sent`) by the ledger and the run continues;
 *    the terminal `failed` + rethrow at the end is what makes pg-boss come back
 *    for them.
 *  - Cancel/pause: the worker re-reads the row before every page and halts when
 *    an admin has cancelled or paused the broadcast, and every status write it
 *    makes refuses to overturn those two states. Halting ENDS the pg-boss job
 *    (a paused job deliberately does not burn retries waiting) — resuming a
 *    paused broadcast means re-enqueueing it via POST /api/broadcast/enqueue,
 *    which is safe because the ledger resume set skips everyone already mailed.
 */

import { broadcastRepository } from '@pagespace/lib/repositories/broadcast-repository';
import {
  findUnreachableUrls,
  resolveBaseUrl,
  runBroadcast,
  ON_PREM_LIVE_SEND_REFUSAL,
  type SkipReason,
} from '@pagespace/lib/services/broadcast/core';
import {
  resolveAudience,
  loadOptedOutUserIds,
  loadRightsRestrictedUserIds,
} from '@pagespace/lib/services/broadcast/audience';
import {
  extractCtaUrls,
  renderMarkdownToSafeHtml,
  resolveBroadcastContent,
} from '@pagespace/lib/services/broadcast/content';
import { createTransactionalEngine } from '@pagespace/lib/services/broadcast/transactional-engine';
import { listSuppressedEmails } from '@pagespace/lib/compliance/erasure/resend-suppression-client';
import { decryptUserRow } from '@pagespace/lib/auth/user-repository';
import { isValidEmail } from '@pagespace/lib/validators/email';
import { isOnPrem } from '@pagespace/lib/deployment-mode';
import type { EmailBroadcastJobData } from '../types';

/** Audience page size for the keyset walk — never materialize the whole table. */
const AUDIENCE_PAGE_SIZE = 500;

/**
 * The admin-set states this worker must never overturn. An operator's cancel or
 * pause can land at any instant between one of our reads and one of our writes;
 * every status write below carries this guard so the race loses to the human.
 */
const OPERATOR_STATES = ['cancelled', 'paused'] as const;

const nowIso = () => new Date().toISOString();

const totalSkips = (skips: Record<SkipReason, number>) =>
  Object.values(skips).reduce((a, b) => a + b, 0);

/**
 * Mark the broadcast failed for a reason no retry can fix, and record the step
 * that refused. Returning (not throwing) afterwards is what keeps pg-boss from
 * re-running a config problem. Refusals live in `blockedReason` (a terminal
 * diagnosis), never `lastError` (a retryable one).
 */
async function refuse(broadcastId: string, step: string, reason: string): Promise<void> {
  console.error(`[email-broadcast] ${broadcastId} refused at ${step}: ${reason}`);
  await broadcastRepository.appendStepResult(broadcastId, {
    step,
    status: 'failed',
    detail: reason,
    at: nowIso(),
  });
  await broadcastRepository.updateStatus(
    broadcastId,
    'failed',
    { blockedReason: reason, completedAt: new Date() },
    { unlessStatus: [...OPERATOR_STATES] },
  );
}

export async function runEmailBroadcastJob(data: EmailBroadcastJobData): Promise<void> {
  const { broadcastId } = data;

  const broadcast = await broadcastRepository.findById(broadcastId);
  if (!broadcast) {
    console.warn(`[email-broadcast] broadcast ${broadcastId} not found; dropping job`);
    return;
  }
  if (
    broadcast.status === 'completed' ||
    broadcast.status === 'cancelled' ||
    broadcast.status === 'paused'
  ) {
    // Returning completes the pg-boss job, ending any retry chain. For
    // cancelled/completed that is exactly right; for paused it is a deliberate
    // trade — a pause of unknown length must not sit burning retries — so
    // resuming is a fresh enqueue (see module doc), not a retry.
    console.log(`[email-broadcast] broadcast ${broadcastId} is ${broadcast.status}; nothing to do`);
    return;
  }

  await broadcastRepository.incrementAttempts(broadcastId);

  const live = !broadcast.dryRun;

  // On-prem guard FIRST, before any status transition or provider read. sendEmail
  // is a silent no-op on-prem, so a "successful" live run would record everyone as
  // sent while sending nothing — poisoning the ledger for the real send. The
  // reason text is core's own (preflight repeats this check); refusing here just
  // spares the row a doomed in_progress transition.
  if (live && isOnPrem()) {
    await refuse(broadcastId, 'preflight', ON_PREM_LIVE_SEND_REFUSAL);
    return;
  }

  // blockedReason is cleared here for the refused-then-rerun path: a broadcast
  // refused for a since-fixed config problem (say FROM_EMAIL) is re-enqueued, and
  // a stale refusal must not survive onto a row that then completes.
  const advanced = await broadcastRepository.updateStatus(
    broadcastId,
    'in_progress',
    {
      startedAt: broadcast.startedAt ?? new Date(),
      lastError: null,
      blockedReason: null,
    },
    { unlessStatus: [...OPERATOR_STATES, 'completed'] },
  );
  if (advanced === 0) {
    console.log(`[email-broadcast] ${broadcastId} was cancelled/paused/completed before start`);
    return;
  }

  // --- Resolve what this broadcast says (compose vs template). A failure here
  // means the admin's intent is ambiguous; the safe reading is "don't send". ---
  let content: { subject: string; bodyMarkdown: string };
  try {
    content = await resolveBroadcastContent(broadcast, async (templateId) => {
      const template = await broadcastRepository.findTemplateById(templateId);
      return template
        ? {
            subject: template.subject,
            bodyMarkdown: template.bodyMarkdown,
            isActive: template.isActive,
          }
        : null;
    });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    await refuse(broadcastId, 'resolve-content', msg);
    return;
  }

  const baseUrl = resolveBaseUrl();
  const fromEmail = process.env.FROM_EMAIL;
  const postalAddress = process.env.COMPANY_POSTAL_ADDRESS?.trim() || undefined;

  const engine = createTransactionalEngine({
    broadcastId,
    subject: content.subject,
    bodyMarkdown: content.bodyMarkdown,
    notificationType: broadcast.notificationType,
    baseUrl,
    postalAddress,
  });

  // --- Exclusion sets. The suppression read is deliberately loud: a SHORT list
  // looks exactly like a complete one, so an unreadable list throws (transient →
  // pg-boss retry), while an unconfigured one returns null and preflight refuses
  // the live send below. ---
  let suppressed: Set<string> | null;
  try {
    suppressed = await listSuppressedEmails();
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    await broadcastRepository.updateStatus(
      broadcastId,
      'failed',
      { lastError: msg },
      { unlessStatus: [...OPERATOR_STATES] },
    );
    throw error;
  }

  const preflightResult = await engine.preflight({
    live,
    suppressed,
    isOnPrem: isOnPrem(),
    fromEmail,
  });
  if (!preflightResult.ok) {
    await refuse(broadcastId, 'preflight', preflightResult.reason);
    return;
  }

  // --- CTA reachability, only when the authored content actually carries links.
  // Extracted from the BODY html (not the full shell) so the per-recipient
  // unsubscribe link — a placeholder until a token is minted — is never probed. ---
  if (live) {
    const ctaUrls = extractCtaUrls(renderMarkdownToSafeHtml(content.bodyMarkdown));
    if (ctaUrls.length > 0) {
      const unreachable = await findUnreachableUrls(ctaUrls);
      if (unreachable.length > 0) {
        await refuse(
          broadcastId,
          'link-check',
          `email links did not resolve: ${unreachable.join(', ')}`,
        );
        return;
      }
      await broadcastRepository.appendStepResult(broadcastId, {
        step: 'link-check',
        status: 'ok',
        detail: `${ctaUrls.length} link(s) reachable`,
        at: nowIso(),
      });
    }
  }

  const [optedOut, rightsRestricted, alreadySent] = await Promise.all([
    loadOptedOutUserIds(broadcast.notificationType),
    loadRightsRestrictedUserIds(),
    // Keyed by normalized ADDRESS — what decideRecipient compares against. This is
    // the resume set: a retry walks the same audience and skips everyone a prior
    // attempt already mailed.
    broadcastRepository.loadAlreadySentEmails(broadcastId),
  ]);

  // The canary budget counts attempts across EVERY run of this broadcast, so it
  // has to start from the ledger, not from zero: this worker rethrows when
  // recipients fail, pg-boss retries with backoff, and a per-process counter
  // would hand each retry a fresh budget — a 25-person canary quietly walking
  // 250 people across ten retries. Ledger rows that consumed budget are exactly
  // the sent + failed ones (skips never count; dry runs write no rows and send
  // nothing, so zero is right for them).
  const priorAttempts =
    live && broadcast.sendLimit !== null
      ? await broadcastRepository
          .countRecipientsByStatus(broadcastId)
          .then((c) => c.sent + c.failed)
      : 0;

  // The durable ledger for this run: claim-before-send (DB-clock lease) plus the
  // sent/skip/failure records. This — not the in-memory set — is the double-send guard.
  const ledger = broadcastRepository.createBroadcastLedger(broadcastId, broadcast.notificationType);

  // --- The send, one keyset page at a time. ---
  const totals = { sent: 0, attempted: 0, skipped: 0, claimedElsewhere: 0 };
  const errors: string[] = [];
  let totalTargeted = 0;
  let cursor: string | null = null;
  let batch = 0;

  try {
    do {
      // Honour a mid-run cancel/pause before every page: a multi-hour live send
      // must stop when the admin says stop, not when the audience runs out.
      const current = await broadcastRepository.findById(broadcastId);
      const halt = !current ? 'row deleted' : OPERATOR_STATES.find((s) => s === current.status);
      if (halt) {
        console.log(`[email-broadcast] ${broadcastId} halted mid-run (${halt})`);
        await broadcastRepository.appendStepResult(broadcastId, {
          step: 'halted',
          status: 'skipped',
          detail: `stopped after batch ${batch}: broadcast is ${halt}`,
          at: nowIso(),
        });
        return;
      }

      const page = await resolveAudience(broadcast.audienceDefinition, {
        limit: AUDIENCE_PAGE_SIZE,
        after: cursor,
      });
      cursor = page.nextCursor;
      if (page.rows.length === 0) break;
      totalTargeted += page.rows.length;
      batch++;

      const remainingLimit =
        broadcast.sendLimit === null
          ? null
          : broadcast.sendLimit - priorAttempts - totals.attempted;

      const result = await runBroadcast({
        live,
        limit: remainingLimit,
        delayMs: broadcast.delayMs,
        rows: page.rows,
        decrypt: (row) => decryptUserRow(row),
        isValidEmail,
        // Shared across pages on purpose: runBroadcast adds each sent address, so
        // two accounts sharing one address in different pages still get one email.
        alreadySent,
        suppressed,
        optedOut,
        rightsRestricted,
        sendOne: (r) => engine.sendOne(r),
        renderOne: (r) => engine.renderOne(r),
        // Ledger hooks only bind a live run: a dry run must leave no recipient rows.
        // (record is never invoked on a dry run — the live gate precedes it.)
        claim: live ? ledger.claim : undefined,
        record: ledger.record,
        // 'already-sent' skips are deliberately not persisted: they only arise on
        // a resumed run (users.emailBidx keeps addresses unique), where the row is
        // already `sent` — recordSkip's own guard would refuse the demotion — and
        // a 49k-sent resume would otherwise burn one guaranteed-no-op round trip
        // per already-mailed recipient before reaching the ones it exists to retry.
        onSkip: live
          ? (skip) => (skip.reason === 'already-sent' ? Promise.resolve() : ledger.onSkip(skip))
          : undefined,
        onFailure: live ? ledger.onFailure : undefined,
        now: nowIso,
        sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
        log: (message) => console.log(`[email-broadcast] ${broadcastId} ${message}`),
        logError: (message) => console.error(`[email-broadcast] ${broadcastId} ${message}`),
      });

      totals.sent += result.sent;
      totals.attempted += result.attempted;
      totals.skipped += totalSkips(result.skipped);
      totals.claimedElsewhere += result.claimedElsewhere;
      errors.push(...result.errors);

      // Progress after every page, so the admin UI polls live numbers. Live counts
      // come from the ledger (a retry re-walks part of the audience; recounting is
      // what keeps the numbers true); a dry run has no ledger rows to count.
      const counts = live
        ? await broadcastRepository.countRecipientsByStatus(broadcastId)
        : { sent: totals.sent, skipped: totals.skipped, failed: errors.length };
      await broadcastRepository.updateCounts(broadcastId, {
        totalTargeted,
        sentCount: counts.sent,
        skippedCount: counts.skipped,
        failedCount: counts.failed,
      });
      await broadcastRepository.appendStepResult(broadcastId, {
        step: `batch-${batch}`,
        status: result.errors.length > 0 ? 'failed' : 'ok',
        detail:
          `rows=${page.rows.length} sent=${result.sent} attempted=${result.attempted} ` +
          `skipped=${totalSkips(result.skipped)} failed=${result.errors.length} ` +
          `claimedElsewhere=${result.claimedElsewhere}`,
        at: nowIso(),
      });

      if (
        broadcast.sendLimit !== null &&
        priorAttempts + totals.attempted >= broadcast.sendLimit
      ) {
        await broadcastRepository.appendStepResult(broadcastId, {
          step: 'send-limit',
          status: 'ok',
          detail:
            `stopped at sendLimit=${broadcast.sendLimit} attempts` +
            (priorAttempts > 0 ? ` (${priorAttempts} from earlier runs)` : ''),
          at: nowIso(),
        });
        break;
      }
    } while (cursor !== null);
  } catch (error) {
    // A LedgerWriteFailed (send recorded nowhere) or any other unexpected throw:
    // surface the reason on the row, then let pg-boss retry with backoff. The
    // resume set + claims make the retry pick up where this attempt stopped.
    const msg = error instanceof Error ? error.message : String(error);
    await broadcastRepository.updateStatus(
      broadcastId,
      'failed',
      { lastError: msg },
      { unlessStatus: [...OPERATOR_STATES] },
    );
    throw error;
  }

  const summary =
    `sent=${totals.sent} attempted=${totals.attempted} targeted=${totalTargeted} ` +
    `skipped=${totals.skipped} failed=${errors.length} ` +
    `claimedElsewhere=${totals.claimedElsewhere}`;

  // Recipients a rival worker held when we walked past them have an UNKNOWN
  // outcome: the rival may finish sending — or may have died mid-send, leaving a
  // lease that expires in minutes and a recipient nobody will ever return for if
  // this run declares the broadcast `completed` (the terminal short-circuit would
  // then drop every future job for it). Not `completed`, so: retry. The retry
  // re-walks cheaply (resume set skips everyone sent) and either finds the rival
  // recorded them `sent` — clean finish — or reclaims them once the lease lapses.
  if (errors.length === 0 && totals.claimedElsewhere > 0) {
    const lastError =
      `${totals.claimedElsewhere} recipient(s) were claimed by another worker; ` +
      'retrying to confirm their outcome';
    await broadcastRepository.appendStepResult(broadcastId, {
      step: 'finalize',
      status: 'failed',
      detail: summary,
      at: nowIso(),
    });
    await broadcastRepository.updateStatus(
      broadcastId,
      'failed',
      { lastError },
      { unlessStatus: [...OPERATOR_STATES] },
    );
    throw new Error(`email-broadcast ${broadcastId}: ${lastError}`);
  }

  if (errors.length > 0) {
    // Per-recipient failures (rate limits, provider errors) are retryable: they are
    // recorded `failed` in the ledger, never `sent`, and the rethrow below makes
    // pg-boss re-run the job and re-attempt exactly them.
    const lastError =
      `${errors.length} recipient(s) failed; latest: ${errors[errors.length - 1]}`;
    await broadcastRepository.appendStepResult(broadcastId, {
      step: 'finalize',
      status: 'failed',
      detail: summary,
      at: nowIso(),
    });
    await broadcastRepository.updateStatus(
      broadcastId,
      'failed',
      { lastError },
      { unlessStatus: [...OPERATOR_STATES] },
    );
    throw new Error(`email-broadcast ${broadcastId} finished with failures: ${lastError}`);
  }

  await broadcastRepository.appendStepResult(broadcastId, {
    step: 'finalize',
    status: 'ok',
    detail: summary,
    at: nowIso(),
  });
  await broadcastRepository.updateStatus(
    broadcastId,
    'completed',
    { completedAt: new Date(), lastError: null },
    { unlessStatus: [...OPERATOR_STATES] },
  );
  console.log(`[email-broadcast] ${broadcastId} -> completed (${summary})`);
}
