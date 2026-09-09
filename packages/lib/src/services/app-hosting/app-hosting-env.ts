/**
 * app-hosting-env — the kill switch, the credential, and the one network name.
 *
 * All three read `process.env` DIRECTLY rather than going through
 * `getValidatedEnv()`. This mirrors `resolveSpritesToken()` and
 * `isCodeExecutionEnabled()` and is deliberate: these values are resolved from
 * more than one service, and a service with a lean env (realtime, processor) makes
 * `getValidatedEnv()` THROW — which would blank the token and flip the kill switch
 * OFF even when both are correctly configured. That exact bug denied every terminal
 * once already. A direct, service-agnostic read is the correct shape here.
 */

/**
 * Global kill switch for published-app hosting. Default OFF: only the literal
 * string 'true' enables it, so an unset value — or a stray `APP_HOSTING_ENABLED=1`
 * or `=TRUE` — keeps the whole feature dark. Every exported provisioner entry point
 * checks this first.
 */
export function isAppHostingEnabled(): boolean {
  return process.env.APP_HOSTING_ENABLED === 'true';
}

/**
 * Fly Machines org token (Bearer) for the Flaps client. Returns '' when unset, so
 * the client fails CLOSED with an auth error surfaced as a provisioning failure
 * rather than crashing app startup.
 */
export function resolveFlyMachinesToken(): string {
  return process.env.FLY_MACHINES_ORG_TOKEN ?? '';
}

/**
 * The ONE Fly network every published app is created on.
 *
 * The original design (epic decision D2) gave each published app its own 6PN
 * network for isolation. The Phase 0 spike REFUTED that as architecture-breaking:
 * fly-replay cannot cross networks — the proxy answers
 * `502 cross-network replays are not allowed` — so per-app networks and the
 * fly-replay routing tier cannot both exist. Routing wins, and every published app
 * therefore shares one network.
 *
 * This constant is the single source of that name. Nothing derives a network from
 * an app id; there is deliberately no `networkNameFor(id)` anywhere in this module.
 */
export const PUBLISHED_APPS_NETWORK_DEFAULT = 'published-apps';

/**
 * Resolve the shared network name. The env override exists so a staging org can
 * use a separate network without a code change — it is NOT a per-app knob.
 * An empty or unset value falls back to the default rather than sending Fly an
 * empty `network`, which would silently place the app on the org default network
 * and break replay for that app alone.
 */
export function resolvePublishedAppsNetwork(): string {
  const configured = process.env.PUBLISHED_APPS_NETWORK;
  return configured && configured.length > 0 ? configured : PUBLISHED_APPS_NETWORK_DEFAULT;
}

/** The Fly org every published app is created in. Same override shape as the network name above. */
export const PUBLISHED_APPS_ORG_SLUG_DEFAULT = 'pagespace';

export function resolvePublishedAppsOrgSlug(): string {
  const configured = process.env.FLY_MACHINES_ORG_SLUG;
  return configured && configured.length > 0 ? configured : PUBLISHED_APPS_ORG_SLUG_DEFAULT;
}

/**
 * Parse a positive-integer env knob, falling back to `fallback` for anything that
 * is not one.
 *
 * Read at CALL TIME, not at module load, for the same reason
 * `dailyExposureCapForTier` is a function: these are operational knobs that an
 * operator turns without a deploy, and a module-load read would freeze whatever
 * value the first import saw — including in tests, where a per-case override is
 * the only way to exercise a threshold without waiting for it.
 *
 * A malformed value takes the DEFAULT rather than throwing or disabling: these
 * knobs bound money and machine lifetime, and a typo must not silently switch off
 * the reaper (leaving the fleet awake) or the cap (leaving it unbounded). Zero is
 * accepted where the constant's own docblock says zero means something.
 */
function envSeconds(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim().length === 0) return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed) || parsed < 0) return fallback;
  return parsed;
}

/** Default idle threshold before the reaper stops a published app: 15 minutes. */
export const PUBLISHED_APP_IDLE_STOP_SECONDS_DEFAULT = 900;

/**
 * How long a published app may go without a routed request before the idle reaper
 * stops its machine.
 *
 * This is the number that turns "scale to zero" from a claim into a behaviour: the
 * machines run with `autostop: "off"` so that every billing boundary is an API
 * call we made, which means NOTHING stops an app except this reaper. Too long and
 * every app bills for idle time; too short and every visitor after a lull pays a
 * cold start (sub-second — the rootfs assembles at machine CREATE, not at start —
 * plus the replay's own `timeout=`).
 *
 * 15 minutes because the recency signal it is compared against is itself throttled
 * to a minute (see {@link resolveHitStampIntervalSeconds}) and the cron
 * fires every five: a threshold near either of those would reap apps that were
 * being used seconds ago. Set to 0 to disable idle reaping entirely — a machine
 * then stays awake until it is stopped by hand, by the credit gate, or by the
 * daily cap.
 */
export function resolveIdleStopSeconds(): number {
  return envSeconds('PUBLISHED_APP_IDLE_STOP_SECONDS', PUBLISHED_APP_IDLE_STOP_SECONDS_DEFAULT);
}

/** Default throttle on the router's recency stamp: one write per app per minute. */
export const PUBLISHED_APP_HIT_STAMP_INTERVAL_SECONDS_DEFAULT = 60;

/**
 * The minimum age of `published_apps.lastHitAt` before the router rewrites it.
 *
 * The router runs once per ASSET of every published page, so an unconditional
 * stamp would put a row write on the hottest path in the system and turn one
 * visitor's page load into dozens of writes to the same row — contending with the
 * meter's own writes to it. The throttle makes all but one of those an indexed
 * statement that matches nothing.
 *
 * The cost is precision: this column trails real traffic by up to this interval,
 * which is why {@link resolveIdleStopSeconds} is an order of magnitude larger. Set
 * to 0 to stamp on every replayed request (accurate, and much more expensive).
 */
export function resolveHitStampIntervalSeconds(): number {
  return envSeconds('PUBLISHED_APP_HIT_STAMP_INTERVAL_SECONDS', PUBLISHED_APP_HIT_STAMP_INTERVAL_SECONDS_DEFAULT);
}

/** Default per-app daily awake budget: 12 hours per UTC day. */
export const PUBLISHED_APP_DAILY_AWAKE_SECONDS_CAP_DEFAULT = 43_200;

/**
 * The most awake-seconds one METERED app may bill in a single UTC day before it is
 * stopped and PARKED — the per-app analog of `dailyExposureCapForTier`, which
 * bounds a payer rather than an app.
 *
 * Both bounds are needed and neither subsumes the other: the payer cap is a
 * ceiling on a person's whole day across every app they own, so a single runaway
 * app can exhaust it and take every other app that payer owns down with it. This
 * one contains the damage to the app that caused it.
 *
 * 12 hours by default, which — with the idle reaper working — an app can only
 * reach by genuinely serving traffic around the clock. That is the intended
 * signal, not an accident: a metered app awake half of every day has outgrown the
 * metered tier, and the epic's answer for always-on is the flat-rate DEDICATED
 * tier (no balance gate, `min_machines_running = 1`, exempt from this cap because
 * `parked` is metered-only by CHECK). Set to 0 to disable, which leaves the payer
 * cap and the credit balance as the only bounds.
 */
export function resolveDailyAwakeSecondsCap(): number {
  return envSeconds('PUBLISHED_APP_DAILY_AWAKE_SECONDS_CAP', PUBLISHED_APP_DAILY_AWAKE_SECONDS_CAP_DEFAULT);
}
