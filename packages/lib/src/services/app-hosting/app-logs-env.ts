/**
 * app-logs-env — connection details for the org's Fly NATS log firehose
 * (`logs.<fly-app>.<region>.<machine>`, per the epic's Fly-blueprint research).
 *
 * CONFIRMED (founder, [A-publish]): the firehose is Fly's ORG-WIDE 6PN NATS
 * endpoint at `nats://[fdaa::3]:4223` — a fixed, well-known address on Fly's
 * private network, not a per-deployment value, so it is a constant here rather
 * than a required env var (an override still exists for a non-standard org
 * setup, but nothing should normally set it). Auth is the org slug (reused from
 * `resolvePublishedAppsOrgSlug` — the same org every published app lives in,
 * not a second identity) plus a READ-ONLY token, which — per the founder's
 * explicit "Fly-secret-only provisioning" — MUST come from a Fly secret and
 * has no default. `FLY_LOGS_NATS_TOKEN` unset means the firehose is simply not
 * configured: `isAppLogsNatsConfigured()` reports that and every caller fails
 * CLOSED (no subscription opened, logs don't stream) rather than crashing the
 * realtime process — same shape as `resolveFlyMachinesToken`.
 *
 * Reaching `[fdaa::3]:4223` requires the caller to actually be attached to the
 * org's 6PN network (Fly Machines are; a non-Fly-hosted `apps/realtime` is not
 * and this will simply fail to connect — see the app-hosting logs runbook note
 * in `ROUTING.md`).
 */

import { isOnPrem } from '../../deployment-mode';

const DEFAULT_NATS_URL = 'nats://[fdaa::3]:4223';

export function resolveAppLogsNatsUrl(): string {
  const configured = process.env.APP_HOSTING_LOGS_NATS_URL;
  return configured && configured.length > 0 ? configured : DEFAULT_NATS_URL;
}

/** Readonly token for the log firehose subscription (never a publish-capable credential). Fly-secret-only — no default. */
export function resolveAppLogsNatsToken(): string {
  return process.env.FLY_LOGS_NATS_TOKEN ?? '';
}

/**
 * The firehose is "configured" once a read-only token is present — the URL
 * always has a value (the fixed Fly address), so the token is the actual
 * on/off signal. Gated on `isOnPrem()` first, never `!isCloud()` (see
 * CLAUDE.md's deployment-mode guard rule): an on-prem deployment must never
 * reach an external Fly integration even if `FLY_LOGS_NATS_TOKEN` happens to
 * be set in its environment — self-hosted means no external calls, full
 * stop. Tenant deployments (dedicated-image cloud, not on-prem) are
 * unaffected and still gate on the token alone.
 */
export function isAppLogsNatsConfigured(): boolean {
  if (isOnPrem()) return false;
  return resolveAppLogsNatsToken().length > 0;
}
