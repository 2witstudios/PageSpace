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

    // Drain the CH insert buffers on shutdown — deploys must not lose the
    // up-to-500-rows/table in-memory window. The logger's own SIGTERM/SIGINT
    // handler sequences flush→drain→exit when database logging is on; this
    // registration covers stdout-only processes where that handler never
    // installs.
    const { drainAnalyticsInserts } = await import('@pagespace/lib/observability/analytics-inserts');
    for (const signal of ['SIGTERM', 'SIGINT'] as const) {
      process.on(signal, () => {
        void drainAnalyticsInserts();
      });
    }

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
