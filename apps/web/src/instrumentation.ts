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
    const { validateEnv } = await import('@pagespace/lib/server');
    validateEnv();
    console.log('[Instrumentation] Environment validation passed');

    // Initialize activity broadcast hook for real-time updates
    const { setActivityBroadcastHook } = await import('@pagespace/lib');
    const { broadcastActivityEvent } = await import('@/lib/websocket/socket-utils');

    setActivityBroadcastHook(broadcastActivityEvent);

    console.log('[Instrumentation] Activity broadcast hook initialized');
  }
}
