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
 *    reason and the worker RETURNS, because retrying a config problem just
 *    re-fails it.
 *  - Per-recipient send failures — including sendEmail's 3/hr rate-limit throw —
 *    are recorded `failed` (never `sent`) by the ledger and the run continues;
 *    the terminal `failed` + rethrow at the end is what makes pg-boss come back
 *    for them.
 */

import { broadcastRepository } from '@pagespace/lib/repositories/broadcast-repository';
import {
  findUnreachableUrls,
  resolveBaseUrl,
  runBroadcast,
  type BroadcastResult,
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

const nowIso = () => new Date().toISOString();

const emptySkips = (): Record<SkipReason, number> => ({
  'invalid-email': 0,
  'already-sent': 0,
  suppressed: 0,
  'opted-out': 0,
  'rights-restricted': 0,
});

function addSkips(into: Record<SkipReason, number>, from: Record<SkipReason, number>): void {
  for (const key of Object.keys(from) as SkipReason[]) into[key] += from[key];
}

const totalSkips = (skips: Record<SkipReason, number>) =>
  Object.values(skips).reduce((a, b) => a + b, 0);

/**
 * Mark the broadcast failed for a reason no retry can fix, and record the step
 * that refused. Returning (not throwing) afterwards is what keeps pg-boss from
 * re-running a config problem.
 */
async function refuse(broadcastId: string, step: string, reason: string): Promise<void> {
  console.error(`[email-broadcast] ${broadcastId} refused at ${step}: ${reason}`);
  await broadcastRepository.appendStepResult(broadcastId, {
    step,
    status: 'failed',
    detail: reason,
    at: nowIso(),
  });
  await broadcastRepository.updateStatus(broadcastId, 'failed', {
    blockedReason: reason,
    completedAt: new Date(),
  });
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
    console.log(`[email-broadcast] broadcast ${broadcastId} is ${broadcast.status}; nothing to do`);
    return;
  }

  await broadcastRepository.incrementAttempts(broadcastId);

  const live = !broadcast.dryRun;

  // On-prem guard FIRST, before any status transition or provider read. sendEmail
  // is a silent no-op on-prem, so a "successful" live run would record everyone as
  // sent while sending nothing — poisoning the ledger for the real send.
  if (live && isOnPrem()) {
    await refuse(
      broadcastId,
      'preflight',
      'DEPLOYMENT_MODE is on-prem, where sendEmail() silently drops mail. The run would send ' +
        'nothing while recording every recipient as already-sent.',
    );
    return;
  }

  await broadcastRepository.updateStatus(broadcastId, 'in_progress', {
    ...(broadcast.startedAt ? {} : { startedAt: new Date() }),
    lastError: null,
  });

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
    await broadcastRepository.updateStatus(broadcastId, 'failed', { lastError: msg });
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

  // The durable ledger for this run: claim-before-send (DB-clock lease) plus the
  // sent/skip/failure records. This — not the in-memory set — is the double-send guard.
  const ledger = broadcastRepository.createBroadcastLedger(broadcastId, broadcast.notificationType);

  // --- The send, one keyset page at a time. ---
  const totals: BroadcastResult = {
    sent: 0,
    attempted: 0,
    skipped: emptySkips(),
    claimedElsewhere: 0,
    errors: [],
  };
  let totalTargeted = 0;
  let cursor: string | null = null;
  let batch = 0;

  try {
    do {
      const page = await resolveAudience(broadcast.audienceDefinition, {
        limit: AUDIENCE_PAGE_SIZE,
        after: cursor,
      });
      cursor = page.nextCursor;
      if (page.rows.length === 0) break;
      totalTargeted += page.rows.length;
      batch++;

      // The canary cap counts ATTEMPTS across the whole run, not per page.
      const remainingLimit =
        broadcast.sendLimit === null ? null : Math.max(0, broadcast.sendLimit - totals.attempted);
      if (remainingLimit !== null && remainingLimit === 0) break;

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
        onSkip: live ? ledger.onSkip : undefined,
        onFailure: live ? ledger.onFailure : undefined,
        now: nowIso,
        sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
        log: (message) => console.log(`[email-broadcast] ${broadcastId} ${message}`),
        logError: (message) => console.error(`[email-broadcast] ${broadcastId} ${message}`),
      });

      totals.sent += result.sent;
      totals.attempted += result.attempted;
      totals.claimedElsewhere += result.claimedElsewhere;
      totals.errors.push(...result.errors);
      addSkips(totals.skipped, result.skipped);

      // Progress after every page, so the admin UI polls live numbers. Live counts
      // come from the ledger (a retry re-walks part of the audience; recounting is
      // what keeps the numbers true); a dry run has no ledger rows to count.
      if (live) {
        const counts = await broadcastRepository.countRecipientsByStatus(broadcastId);
        await broadcastRepository.updateCounts(broadcastId, {
          totalTargeted,
          sentCount: counts.sent,
          skippedCount: counts.skipped,
          failedCount: counts.failed,
        });
      } else {
        await broadcastRepository.updateCounts(broadcastId, {
          totalTargeted,
          sentCount: totals.sent,
          skippedCount: totalSkips(totals.skipped),
          failedCount: totals.errors.length,
        });
      }
      await broadcastRepository.appendStepResult(broadcastId, {
        step: `batch-${batch}`,
        status: result.errors.length > 0 ? 'failed' : 'ok',
        detail:
          `rows=${page.rows.length} sent=${result.sent} attempted=${result.attempted} ` +
          `skipped=${totalSkips(result.skipped)} failed=${result.errors.length} ` +
          `claimedElsewhere=${result.claimedElsewhere}`,
        at: nowIso(),
      });

      if (broadcast.sendLimit !== null && totals.attempted >= broadcast.sendLimit) {
        await broadcastRepository.appendStepResult(broadcastId, {
          step: 'send-limit',
          status: 'ok',
          detail: `stopped at sendLimit=${broadcast.sendLimit} attempts`,
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
    await broadcastRepository.updateStatus(broadcastId, 'failed', { lastError: msg });
    throw error;
  }

  const summary =
    `sent=${totals.sent} attempted=${totals.attempted} targeted=${totalTargeted} ` +
    `skipped=${totalSkips(totals.skipped)} failed=${totals.errors.length} ` +
    `claimedElsewhere=${totals.claimedElsewhere}`;

  if (totals.errors.length > 0) {
    // Per-recipient failures (rate limits, provider errors) are retryable: they are
    // recorded `failed` in the ledger, never `sent`, so the rethrow below makes
    // pg-boss re-run the job and re-attempt exactly them.
    const lastError =
      `${totals.errors.length} recipient(s) failed; ` +
      `latest: ${totals.errors[totals.errors.length - 1]}`;
    await broadcastRepository.appendStepResult(broadcastId, {
      step: 'finalize',
      status: 'failed',
      detail: summary,
      at: nowIso(),
    });
    await broadcastRepository.updateStatus(broadcastId, 'failed', { lastError });
    throw new Error(`email-broadcast ${broadcastId} finished with failures: ${lastError}`);
  }

  await broadcastRepository.appendStepResult(broadcastId, {
    step: 'finalize',
    status: 'ok',
    detail: summary,
    at: nowIso(),
  });
  await broadcastRepository.updateStatus(broadcastId, 'completed', {
    completedAt: new Date(),
    lastError: null,
  });
  console.log(`[email-broadcast] ${broadcastId} -> completed (${summary})`);
}
