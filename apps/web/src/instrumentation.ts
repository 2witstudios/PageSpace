import * as Sentry from "@sentry/nextjs";

export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    await import("../sentry.server.config");

    const { validateEnv } = await import('@pagespace/lib/config/env-validation');
    validateEnv();
    console.log('[Instrumentation] Environment validation passed');

    // Fail-fast: a half-configured ClickHouse deploy (flag on, creds missing)
    // must crash at boot — the insert adapters absorb per-row errors, so a
    // running process would silently black out all 4 analytics tables
    // (#890 Phase 3). Throws ClickHouseMisconfiguredError on 'misconfigured'.
    const { probeClickHouseStartup } = await import('@pagespace/lib/observability/clickhouse-client');
    const chMode = probeClickHouseStartup();
    console.log(`[Instrumentation] ClickHouse analytics tier: ${chMode.mode}`);

    // Initialize the shared logger in this composition root. Constructing the
    // singleton (module top-level `Logger.getInstance()`) installs its
    // flush → drain → exit shutdown handler (logging/logger.ts →
    // createShutdownHandler): on SIGTERM/SIGINT it flushes buffered logs, then
    // drains the ClickHouse insert buffers (up to 500 rows/table — including
    // rows buffered by direct adapter calls), then exits. It is the single,
    // terminating owner of graceful shutdown; initializing it deterministically
    // at boot means even an idle process that receives a signal before serving
    // any request still drains its analytics buffers and terminates — rather
    // than a bespoke drain-only listener that suppresses Node's default
    // termination but never exits (#890 Phase 3).
    await import('@pagespace/lib/logging/logger');

    const { setActivityBroadcastHook } = await import('@pagespace/lib/monitoring/activity-logger');
    const { broadcastActivityEvent } = await import('@/lib/websocket/socket-utils');
    setActivityBroadcastHook(broadcastActivityEvent);
    console.log('[Instrumentation] Activity broadcast hook initialized');

    if (
      process.env.AUDIT_SIEM_ENABLED === 'true' &&
      process.env.AUDIT_WEBHOOK_URL &&
      process.env.AUDIT_WEBHOOK_SECRET
    ) {
      const { setSiemErrorHook, buildWebhookSiemErrorHook } = await import('@pagespace/lib/logging/siem-error-hook');
      setSiemErrorHook(buildWebhookSiemErrorHook(
        process.env.AUDIT_WEBHOOK_URL,
        process.env.AUDIT_WEBHOOK_SECRET,
      ));
      console.log('[Instrumentation] SIEM error hook initialized');
    }
  }

  if (process.env.NEXT_RUNTIME === "edge") {
    await import("../sentry.edge.config");
  }
}

export const onRequestError = Sentry.captureRequestError;
