/**
 * routing-env — the configuration surface of the published-app SERVING EDGE.
 *
 * Reads `process.env` DIRECTLY, for the same reason `app-hosting-env.ts` does:
 * these values are resolved from more than one service, and `getValidatedEnv()`
 * THROWS in a service with a lean env (realtime, processor) — which would blank
 * the apex and the router secret even when both are correctly configured. See
 * that file's header; this module is its routing-tier sibling and deliberately
 * copies its shape.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * THE ONE INVARIANT THIS MODULE EXISTS TO NAME
 *
 * The ROUTER APP and every PUBLISHED APP must live on the SAME Fly 6PN network.
 *
 * fly-replay cannot cross networks — the proxy answers
 * `502 cross-network replays are not allowed`, which is exactly what the Phase 0
 * spike found and why `resolvePublishedAppsNetwork()` exists as one shared
 * constant rather than a per-app value. That constraint binds the router too:
 * the app that EMITS the `fly-replay` header is `resolveAppRouterFlyAppName()`,
 * and if it was created on a different network than `resolvePublishedAppsNetwork()`
 * every replay 502s.
 *
 * A Fly app's network is FIXED AT CREATE TIME, so this cannot be repaired by
 * redeploying. It is satisfied one of two ways, both of them pure configuration:
 *   (a) create published apps on the existing router's network
 *       (`PUBLISHED_APPS_NETWORK=<router's network>`), or
 *   (b) point `APP_ROUTER_FLY_APP_NAME` at a router app that was itself created
 *       on `PUBLISHED_APPS_NETWORK`.
 *
 * Nothing in this repo can verify which of those is true — the network an app
 * was created on is a Fly-side fact. {@link describeRouterNetworkInvariant} is
 * therefore a documentation/diagnostics helper, not a check: it renders the pair
 * that has to agree so a 502 is one log line away from its cause instead of a
 * day of bisecting.
 * ────────────────────────────────────────────────────────────────────────────
 */

import { resolvePublishedAppsNetwork } from './app-hosting-env';

/**
 * The apex published apps are served from: an app answers at
 * `<published_apps.subdomain>.<apex>`.
 *
 * A SEPARATE apex from `*.pagespace.site` (where `drives.publishSubdomain` static
 * canvas sites live), and that separation is a security requirement rather than
 * tidiness. `pagespace.site` is not on the Public Suffix List, so a document
 * served from `a.pagespace.site` can set a `domain=.pagespace.site` cookie that
 * every other published site then sends. Static canvas pages already carry that
 * risk; a published app is strictly worse, because it runs arbitrary
 * customer-authored SERVER code on its own origin — it can set, read and act on
 * those cookies without a user ever visiting the victim site.
 *
 * So published apps get their own apex, and that apex MUST be on the PSL before
 * GA. This constant is the wiring for that decision; submitting the apex to the
 * PSL is an out-of-band action that is NOT performed by this repo. See
 * `ROUTING.md` in this directory for the submission checklist.
 */
export const PUBLISHED_APPS_APEX_DEFAULT = 'pagespace.app';

/**
 * The apex, normalized: lowercased, trailing dot and any leading `*.`/`.`
 * stripped, so `PUBLISHED_APPS_APEX=*.pagespace.app` and `pagespace.app.` both
 * resolve to the same value. An empty or whitespace-only override falls back to
 * the default rather than yielding `''` — an empty apex would make
 * {@link parseAppHost} treat EVERY hostname as a published-app subdomain.
 */
export function resolvePublishedAppsApex(): string {
  const configured = (process.env.PUBLISHED_APPS_APEX ?? '').trim().toLowerCase();
  const normalized = configured.replace(/^\*?\./, '').replace(/\.$/, '');
  return normalized.length > 0 ? normalized : PUBLISHED_APPS_APEX_DEFAULT;
}

/** The Fly app that terminates the published-apps apex and emits fly-replay. */
export const APP_ROUTER_FLY_APP_DEFAULT = 'pagespace-proxy';

/**
 * Name of the Fly app that emits the replays and holds the custom-domain certs.
 *
 * Falls back through `FLY_PROXY_APP_NAME` — the variable `reconcile-cert.ts`
 * already uses to name the app certs attach to — so a deployment that has only
 * ever configured the one proxy keeps working, and a deployment that splits the
 * router onto its own app (option (b) in the file header) sets exactly one new
 * variable. The two must name the SAME app: a cert issued on app A does not
 * TLS-terminate traffic arriving at app B.
 */
export function resolveAppRouterFlyAppName(): string {
  const explicit = (process.env.APP_ROUTER_FLY_APP_NAME ?? '').trim();
  if (explicit.length > 0) return explicit;
  const legacy = (process.env.FLY_PROXY_APP_NAME ?? '').trim();
  return legacy.length > 0 ? legacy : APP_ROUTER_FLY_APP_DEFAULT;
}

/**
 * Server-held secret the per-app fly-replay `state` key is derived from.
 *
 * Returns '' when unset, so the router fails CLOSED: `derivePublishedAppReplayKey`
 * throws below its length floor, the route answers "unavailable", and no traffic
 * is replayed WITHOUT a state key. Failing open here would hand every published
 * app unauthenticated traffic it cannot distinguish from router-issued traffic —
 * the exact property the key exists to provide.
 */
export function resolveAppReplaySecret(): string {
  return process.env.APP_REPLAY_SECRET ?? '';
}

/**
 * Shared secret proving a router request actually came from the edge proxy.
 *
 * The router endpoint lives on `pagespace-web`, which is also reachable at
 * `pagespace.ai/api/...`. Without this, ANY internet caller could hand the app
 * an arbitrary published-app hostname and receive a `fly-replay` header — i.e.
 * turn our own web app into a general-purpose replay emitter for the org, and
 * wake (and bill) any published app they can name. So the router answers only
 * requests carrying this value in `X-PageSpace-App-Router-Key`, set by the proxy
 * from its own Fly secret.
 *
 * Returns '' when unset, and the router treats '' as "refuse everything" rather
 * than "no check" — an unconfigured secret must not silently disable the check
 * that stops the endpoint being world-callable.
 */
export function resolveAppRouterProxySecret(): string {
  return process.env.APP_ROUTER_PROXY_SECRET ?? '';
}

/** The request header the edge proxy carries the real published-app hostname in. */
export const APP_ROUTER_HOST_HEADER = 'x-pagespace-app-host';

/** The request header the edge proxy carries {@link resolveAppRouterProxySecret} in. */
export const APP_ROUTER_KEY_HEADER = 'x-pagespace-app-router-key';

/**
 * The router/published-app network pair that has to agree, rendered for logs and
 * ops docs. NOT a check — see the file header for why one is not possible here.
 */
export function describeRouterNetworkInvariant(): {
  routerApp: string;
  publishedAppsNetwork: string;
  note: string;
} {
  return {
    routerApp: resolveAppRouterFlyAppName(),
    publishedAppsNetwork: resolvePublishedAppsNetwork(),
    note:
      'fly-replay cannot cross Fly 6PN networks: the router app must have been CREATED on publishedAppsNetwork, ' +
      'or every replay answers 502 "cross-network replays are not allowed". A Fly app\'s network is fixed at create time.',
  };
}
