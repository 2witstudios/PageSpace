/**
 * Pure Sentry payload shaping for security-audit trust-plane alerts.
 *
 * The `notify*` helpers in security-audit-alerting.ts all funnel through one
 * process-local `alertHandler`, and they fire from TWO different processes:
 *
 *   - apps/web  — verifyAndAlert / notifyAnchorVerificationFailure /
 *                 notifyAnchorReceiptsMissing (cron/verify-audit-chain)
 *   - apps/processor — notifyChainPreflightFailure (siem-delivery-worker),
 *                 notifyChainAppendVerificationFailure and
 *                 notifyAnchorPublishFailure (audit-chainer-worker)
 *
 * plus notifyAdminDbBreakGlass from security-audit.ts, which runs in whichever
 * process performs the audit write. Because `alertHandler` is a module-level
 * variable, EACH process must register its own handler — registering only in
 * Next.js instrumentation leaves every processor-side worker alert a silent
 * no-op, which is the exact class of gap that let the daily database backup
 * fail unnoticed for 44 days.
 *
 * THREE processes write audit events and can therefore raise these alerts:
 * apps/web, apps/processor, and apps/admin (which calls `audit()` from 19 call
 * sites; `audit()` → `securityAudit.logEvent()` → the break-glass bind point →
 * notifyAdminDbBreakGlass). Each must register its own handler.
 *
 * They do not share a Sentry SDK (@sentry/nextjs in the two Next apps,
 * @sentry/node in the processor), so this module owns the payload AND the
 * handler, taking `captureException` as a parameter. That keeps one tested
 * implementation instead of a near-identical adapter per app, and means the
 * alert shape cannot drift between runtimes. Deliberately no Sentry import
 * here — lib stays SDK-agnostic.
 */

import type { ChainVerificationAlert } from './security-audit-alerting';

export interface ChainAlertSentryPayload {
  /** Message for the synthetic Error handed to captureException. */
  message: string;
  level: 'fatal';
  /**
   * Grouping key. Deliberately keyed on `source` rather than the message:
   * descriptions embed entry ids and counts, so message-based grouping would
   * open a fresh Sentry issue per occurrence and bury a recurring alert in
   * noise instead of escalating one.
   */
  fingerprint: string[];
  tags: Record<string, string>;
  extra: Record<string, unknown>;
}

/** Which process is reporting — tagged so Sentry shows the origin. */
export type ChainAlertProcess = 'web' | 'processor' | 'admin';

export function buildChainAlertPayload(
  alert: ChainVerificationAlert,
  process: ChainAlertProcess
): ChainAlertSentryPayload {
  const { result, source, triggeredAt } = alert;
  const description = result.breakPoint?.description ?? 'Chain verification reported invalid.';

  return {
    message: `[SECURITY ALERT] ${source}: ${description}`,
    level: 'fatal',
    fingerprint: ['security-audit-chain', source],
    tags: {
      check: 'security_audit_chain',
      source,
      process,
    },
    extra: {
      triggeredAt: triggeredAt.toISOString(),
      totalEntries: result.totalEntries,
      entriesVerified: result.entriesVerified,
      validEntries: result.validEntries,
      invalidEntries: result.invalidEntries,
      breakPointEntryId: result.breakPoint?.entryId ?? null,
      breakPointPosition: result.breakPoint?.position ?? null,
      lastEntryId: result.lastEntryId,
      durationMs: result.durationMs,
    },
  };
}

/**
 * A Sentry `captureException`, narrowed to what this bridge passes it. Typed
 * structurally rather than against a Sentry SDK so lib takes no SDK dependency
 * and both @sentry/nextjs and @sentry/node satisfy it.
 */
export type ChainAlertCapture = (
  error: Error,
  context: Omit<ChainAlertSentryPayload, 'message'>
) => unknown;

/**
 * Build the handler to hand to `setChainAlertHandler` in a process's
 * composition root:
 *
 *   setChainAlertHandler(
 *     buildChainAlertHandler((e, c) => Sentry.captureException(e, c), 'web')
 *   );
 *
 * Register this in EVERY process that raises trust-plane alerts. `alertHandler`
 * in security-audit-alerting.ts is a module-local variable, so one process's
 * registration does nothing for another — the original fix wired only the web
 * app and left every processor-side worker alert a silent no-op.
 */
export function buildChainAlertHandler(
  capture: ChainAlertCapture,
  process: ChainAlertProcess
): (alert: ChainVerificationAlert) => void {
  return (alert: ChainVerificationAlert) => {
    const { message, ...context } = buildChainAlertPayload(alert, process);
    capture(new Error(message), context);
  };
}
