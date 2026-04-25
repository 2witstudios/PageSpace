/**
 * Next.js Instrumentation - Server-side initialization
 *
 * This file runs once when the Next.js server starts.
 * Used to initialize hooks and configure server-side behavior.
 */

export async function register() {
  // Only run on the server (Node.js runtime)
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    // Validate environment variables early to catch misconfig at startup
    const { validateEnv } = await import('@pagespace/lib/config/env-validation');
    validateEnv();
    console.log('[Instrumentation] Environment validation passed');

    // Initialize activity broadcast hook for real-time updates
    const { setActivityBroadcastHook } = await import('@pagespace/lib/monitoring/activity-logger');
    const { broadcastActivityEvent } = await import('@/lib/websocket/socket-utils');

    setActivityBroadcastHook(broadcastActivityEvent);

    console.log('[Instrumentation] Activity broadcast hook initialized');

    // Wire SIEM error delivery: ship application errors to the SIEM webhook when configured.
    // SIEM URL is operator-controlled (env var only — never user input).
    // Require both URL and non-empty secret: an empty secret produces HMAC signatures
    // that SIEM receivers configured for authentication will reject, causing silent drops.
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
}
