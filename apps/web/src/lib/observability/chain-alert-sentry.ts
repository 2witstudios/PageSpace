import * as Sentry from '@sentry/nextjs';
import type { ChainVerificationAlert } from '@pagespace/lib/audit/security-audit-alerting';

/**
 * Sentry delivery for security-audit trust-plane alerts.
 *
 * Why this exists: `security-audit-alerting.ts` exposes a rich set of
 * `notify*` helpers (chain preflight, verify-on-append, anchor publish/verify,
 * missing receipts, Admin-DB break-glass) that all funnel through one
 * registered handler — and every one of them opens with
 * `if (!alertHandler) return`. Nothing in the codebase ever called
 * `setChainAlertHandler`, so all of them were silent no-ops in production, and
 * `cron/verify-audit-chain` "alerted" only by writing
 * `loggers.security.error` to a logfile that no drain forwards anywhere.
 *
 * That gap is what let the daily database backup fail unnoticed for 44 days
 * (2026-06-26 → 2026-08-08): the deployment has alerting interfaces but no
 * delivery. Sentry is the one channel that reaches a human here — `SENTRY_DSN`
 * is boot-required in production by `validateEnv()` — so this plugs the
 * existing handler interface into it. No detection logic changes; only the
 * previously-dropped alerts now leave the process.
 */
export function buildSentryChainAlertHandler(): (alert: ChainVerificationAlert) => void {
  return (alert: ChainVerificationAlert) => {
    const { result, source, triggeredAt } = alert;
    const description = result.breakPoint?.description ?? 'Chain verification reported invalid.';

    // Fingerprint by source (+ break position where known) rather than by the
    // message: descriptions embed ids and counts, which would otherwise open a
    // new Sentry issue per occurrence and bury a recurring alert in noise.
    Sentry.captureException(new Error(`[SECURITY ALERT] ${source}: ${description}`), {
      level: 'fatal',
      fingerprint: ['security-audit-chain', source],
      tags: {
        check: 'security_audit_chain',
        source,
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
    });
  };
}
