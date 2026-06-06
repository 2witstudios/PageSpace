import * as Sentry from "@sentry/nextjs";

export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    await import("../sentry.server.config");

    const { validateEnv } = await import('@pagespace/lib/config/env-validation');
    validateEnv();
    console.log('[Instrumentation] Environment validation passed');

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
