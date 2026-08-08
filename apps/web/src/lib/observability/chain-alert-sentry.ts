import * as Sentry from '@sentry/nextjs';
import { buildChainAlertPayload } from '@pagespace/lib/audit/chain-alert-payload';
import type { ChainVerificationAlert } from '@pagespace/lib/audit/security-audit-alerting';

/**
 * Sentry delivery for security-audit trust-plane alerts, web process.
 *
 * Why this exists: `security-audit-alerting.ts` exposes a set of `notify*`
 * helpers that all funnel through one registered handler — and every one opens
 * with `if (!alertHandler) return`. Nothing in the codebase ever called
 * `setChainAlertHandler`, so all of them were silent no-ops in production, and
 * `cron/verify-audit-chain` "alerted" only by writing `loggers.security.error`
 * to a logfile that no drain forwards anywhere.
 *
 * That gap is what let the daily database backup fail unnoticed for 44 days
 * (2026-06-26 → 2026-08-08): the deployment has alerting interfaces but no
 * delivery. Sentry is the one channel that reaches a human here — `SENTRY_DSN`
 * is boot-required in production — so this plugs the existing handler interface
 * into it. No detection logic changes; only previously-dropped alerts now leave
 * the process.
 *
 * `alertHandler` is process-local, so this covers the web process ONLY. The
 * processor registers its own equivalent (apps/processor/src/observability/
 * chain-alert-sentry.ts) for the worker-side alerts; the payload itself is
 * built by the shared pure builder so the two cannot drift.
 */
export function buildSentryChainAlertHandler(): (alert: ChainVerificationAlert) => void {
  return (alert: ChainVerificationAlert) => {
    const { message, ...context } = buildChainAlertPayload(alert, 'web');
    Sentry.captureException(new Error(message), context);
  };
}
