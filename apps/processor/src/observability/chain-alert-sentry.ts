import * as Sentry from '@sentry/node';
import { buildChainAlertPayload } from '@pagespace/lib/audit/chain-alert-payload';
import type { ChainVerificationAlert } from '@pagespace/lib/audit/security-audit-alerting';

/**
 * Sentry delivery for security-audit trust-plane alerts, processor process.
 *
 * `alertHandler` in security-audit-alerting.ts is a module-local variable, so
 * registering it in the web app's Next.js instrumentation does NOT cover this
 * process. Three of the loudest alerts fire from here:
 *
 *   - notifyChainPreflightFailure          — workers/siem-delivery-worker.ts
 *   - notifyChainAppendVerificationFailure — workers/audit-chainer-worker.ts
 *   - notifyAnchorPublishFailure           — workers/audit-chainer-worker.ts
 *
 * plus notifyAdminDbBreakGlass whenever this process performs an audit write.
 * Without this registration every one of them hits `if (!alertHandler) return`
 * and a detected chain tamper reaches nobody — the workers' own console.error
 * being the only trace.
 *
 * The payload is built by the shared pure builder in @pagespace/lib so this and
 * the web adapter cannot drift; only the SDK differs (@sentry/node here,
 * @sentry/nextjs there).
 */
export function buildSentryChainAlertHandler(): (alert: ChainVerificationAlert) => void {
  return (alert: ChainVerificationAlert) => {
    const { message, ...context } = buildChainAlertPayload(alert, 'processor');
    Sentry.captureException(new Error(message), context);
  };
}
