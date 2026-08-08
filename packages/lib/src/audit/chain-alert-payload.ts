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
 * The two processes use different Sentry SDKs (@sentry/nextjs vs @sentry/node),
 * so the payload is built here, once, and each app's thin adapter hands it to
 * its own `captureException`. Keeping this pure means the alert shape cannot
 * drift between the two runtimes.
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

export function buildChainAlertPayload(
  alert: ChainVerificationAlert,
  /** Which process is reporting — distinguishes web from processor in Sentry. */
  process: 'web' | 'processor'
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
