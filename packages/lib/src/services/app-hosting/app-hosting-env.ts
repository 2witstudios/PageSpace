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
