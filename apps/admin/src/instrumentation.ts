/**
 * Admin composition root (Next.js instrumentation hook).
 *
 * ClickHouse analytics wiring (#890 Phase 3): this process both reads the
 * analytics tier (monitoring queries) and writes to it (logger-database →
 * insert adapters), so it must fail-fast on a half-configured deploy — the
 * adapters absorb per-row errors by design, and a running process with the
 * flag on but creds missing would silently black out all 4 tables. It must
 * also drain the insert buffers on shutdown so deploys don't lose the
 * in-memory window (up to 500 rows/table).
 */
import * as Sentry from '@sentry/nextjs';

export async function register() {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    await import('../sentry.server.config');

    const { requireSentryDsn } = await import('@pagespace/lib/config/env-validation');
    requireSentryDsn('admin');

    const { probeClickHouseStartup } = await import('@pagespace/lib/observability/clickhouse-client');
    const chMode = probeClickHouseStartup();
    console.log(`[Instrumentation] ClickHouse analytics tier: ${chMode.mode}`);

    // Initialize the shared logger so its flush → drain → exit shutdown handler
    // (logging/logger.ts → createShutdownHandler) is installed at boot. That
    // handler is the single, terminating owner of graceful shutdown: on
    // SIGTERM/SIGINT it flushes buffered logs, drains the ClickHouse insert
    // buffers (up to 500 rows/table, including direct adapter inserts), then
    // exits. Initializing it here means an idle process that receives a signal
    // before serving any request still drains and terminates, rather than a
    // bespoke drain-only listener that suppresses Node's default termination
    // without ever exiting.
    await import('@pagespace/lib/logging/logger');

    // Route security-audit trust-plane alerts to Sentry. `alertHandler` in
    // security-audit-alerting.ts is a module-local variable, so the web and
    // processor registrations do nothing for THIS process — and admin calls
    // `audit()` from 19 routes, which reaches securityAudit.logEvent() and can
    // therefore fire notifyAdminDbBreakGlass from its break-glass bind point.
    // Without this, that alert is a silent no-op here: audit writes would be
    // degraded to the main application database and nobody would be told.
    const { setChainAlertHandler } = await import('@pagespace/lib/audit/security-audit-alerting');
    const { buildChainAlertHandler } = await import('@pagespace/lib/audit/chain-alert-payload');
    setChainAlertHandler(
      buildChainAlertHandler((error, context) => Sentry.captureException(error, context), 'admin')
    );
    console.log('[Instrumentation] Security-audit chain alert handler initialized (Sentry)');
  }

  if (process.env.NEXT_RUNTIME === 'edge') {
    await import('../sentry.edge.config');
  }
}

export const onRequestError = Sentry.captureRequestError;
