/**
 * Timing constants for the env-bridge socket route. They live here rather
 * than in `app/api/env-bridge/ws/route.ts` because a Next.js route module may
 * export only its HTTP handlers and the route-segment config — any other
 * export fails `next build`'s route type check (tsc does not catch it).
 */

/** How long a socket may sit without a valid signed hello before it is closed. */
export const ENV_BRIDGE_HELLO_TIMEOUT_MS = 10_000;
/** Server → daemon heartbeat cadence; well inside LOCAL_ENV_HEARTBEAT_WINDOW_MS (90 s). */
export const ENV_BRIDGE_PING_INTERVAL_MS = 30_000;
