/**
 * router — the imperative shell of the published-app serving edge.
 *
 * Hostname in, {@link AppRouteDecision} out. Everything that touches the world —
 * the `published_apps` read, resolving who pays, the balance read, deriving the
 * replay key — happens here; every rule about what those facts MEAN lives in the
 * pure `router-core.ts` next door.
 *
 * WHERE THIS RUNS, and why it is an app endpoint rather than proxy config: the
 * decision needs a database row and a credit balance, and the edge is Caddy. So
 * the proxy forwards published-app requests to the web app's router route, which
 * calls this, and answers either with a `fly-replay` header (Fly then replays the
 * ORIGINAL request to the target app — the proxy's rewrite to the router path is
 * not what gets replayed) or with the parked/unavailable page itself.
 *
 * THE COST OF THAT SHAPE IS REAL AND DELIBERATE: with no replay cache on the
 * metered tier, EVERY request to a published app — every asset, not just the
 * document — pays one hop to the web app plus, for a servable metered app, three
 * single-row indexed reads: the `published_apps` lookup, the payer's tier, and
 * the payer's funded balance. No aggregates: `hasSpendableBalance` deliberately
 * does NOT go through `getCreditBalance`, which would add a `SUM` over active
 * `credit_holds` whose result the gate discards. A refusal costs fewer — an app
 * refused on status alone never reaches the ledger at all.
 *
 * That is the price of the enforcement property (see `router-core.ts`), and it is
 * bounded by the fact that the replayed response never returns through us: only
 * the decision is ours, the bytes are not.
 *
 * ⚠️ A REPLAYED RESPONSE BYPASSES THE EDGE ENTIRELY. Fly's proxy hands the
 * request straight to the target app and returns its response to the client, so
 * NONE of the Caddyfile's header stanzas apply to a published app's own output.
 * A published app owns its security headers. Nothing at this layer can add,
 * strip, or sanitize them — do not add a header here expecting it to reach a
 * served app's pages, because it never will.
 */

import { db } from '@pagespace/db/db';
import { eq } from '@pagespace/db/operators';
import { publishedApps } from '@pagespace/db/schema/published-apps';
import { hasSpendableBalance } from '../../billing/credit-gate';
import { resolveTier } from '../../billing/credit-balance';
import { defaultAppBillingDeps } from './app-billing';
import { isAppHostingEnabled } from './app-hosting-env';
import { defaultAppLifecycleMeteringDeps, wakePublishedApp, type WakePublishedAppResult } from './app-lifecycle-metering';
import { derivePublishedAppReplayKey } from './app-replay-key';
import { resolveAppReplaySecret, resolvePublishedAppsApex } from './routing-env';
import {
  decideAppRoute,
  parseAppHost,
  type AppRouteDecision,
  type RoutableApp,
} from './router-core';

/** What the router needs from the world, injected so the shell is testable. */
export interface AppRouterDeps {
  isEnabled: () => boolean;
  /** The published-apps apex the hostname is resolved against. */
  apex: () => string;
  /** Server secret the per-app replay `state` key is derived from. */
  replaySecret: () => string;
  /** `published_apps` row for a subdomain, or null. */
  findAppBySubdomain: (subdomain: string) => Promise<PublishedAppRouteRow | null>;
  /**
   * Wake a `stopped` app through the real seam — gate, hold, start, stamp — rather
   * than letting Fly's `autostart` silently start an unmetered machine. See the
   * `SERVABLE_STATUSES` comment in `router-core.ts` for why `'stopped'` never
   * reaches the pure decision directly.
   */
  wakePublishedApp: (publishedAppId: string) => Promise<WakePublishedAppResult>;
  /**
   * Who pays — resolved the SAME way the awake-seconds meter resolves it
   * (`drives.ownerId`, via `resolveEnvPayerId`). Null means unresolvable (a stale
   * read of a drive mid-delete); the caller refuses rather than substituting a
   * payer or falling back to a denormalized column the meter does not charge.
   */
  resolvePayerId: (input: { driveId: string }) => Promise<string | null>;
  /** The payer's subscription tier — the allowance the balance is judged against. */
  resolveTier: (userId: string) => Promise<string>;
  /** Whether the payer can still spend. */
  hasSpendableBalance: (userId: string, tier: string) => Promise<boolean>;
}

/** The columns the routing decision reads. Narrower than the row on purpose. */
export interface PublishedAppRouteRow {
  id: string;
  flyAppName: string;
  status: string;
  tier: string;
  machineId: string | null;
  /**
   * The app's owning drive — NOT `published_apps.ownerId`. The balance gate must
   * ask about the SAME payer the awake-seconds meter charges, and the meter
   * charges `drives.ownerId` (via `resolveEnvPayerId`), never the denormalized
   * `ownerId` column, which exists only for indexing and cascade reach and can
   * drift from the drive's real owner (a transfer, a stale write). Gating on the
   * wrong payer would decide admission against one person's balance while the
   * charge lands on another's.
   */
  driveId: string;
}

async function findAppBySubdomainRow(subdomain: string): Promise<PublishedAppRouteRow | null> {
  const [row] = await db
    .select({
      id: publishedApps.id,
      flyAppName: publishedApps.flyAppName,
      status: publishedApps.status,
      tier: publishedApps.tier,
      machineId: publishedApps.machineId,
      driveId: publishedApps.driveId,
    })
    .from(publishedApps)
    .where(eq(publishedApps.subdomain, subdomain))
    .limit(1);
  return row ?? null;
}

export const defaultAppRouterDeps: AppRouterDeps = {
  isEnabled: isAppHostingEnabled,
  apex: resolvePublishedAppsApex,
  replaySecret: resolveAppReplaySecret,
  findAppBySubdomain: findAppBySubdomainRow,
  wakePublishedApp: (publishedAppId) => wakePublishedApp(publishedAppId, defaultAppLifecycleMeteringDeps),
  // The SAME resolver `app-billing.ts`'s `defaultAppBillingDeps` hands the meter
  // and the wake gate — not an equivalent, the identical function — so a drift
  // between "who the router asks" and "who the meter charges" is structurally
  // impossible rather than merely kept in sync by convention.
  resolvePayerId: defaultAppBillingDeps.resolvePayerId,
  resolveTier: (userId) => resolveTier(userId),
  hasSpendableBalance: (userId, tier) =>
    hasSpendableBalance(userId, tier as Parameters<typeof hasSpendableBalance>[1]),
};

/**
 * Resolve one request hostname to a routing decision.
 *
 * Never throws for an ordinary miss — an unknown host, a disabled feature, a
 * hostname that is not ours — because each of those is a normal answer at a
 * serving edge, not an exception. A genuine failure (the database is down)
 * still propagates: the caller turns it into a 503, which is honest, whereas
 * swallowing it here would present an outage as "no such app".
 */
export async function resolveAppRoute(
  rawHost: string,
  deps: AppRouterDeps = defaultAppRouterDeps,
): Promise<AppRouteDecision> {
  // The kill switch is checked FIRST, before anything reads the database. While
  // hosting is dark, this endpoint must be inert rather than merely fruitless.
  if (!deps.isEnabled()) return { kind: 'unavailable', reason: 'hosting_disabled' };

  const host = parseAppHost(rawHost, deps.apex());
  if (host.kind === 'apex') return { kind: 'not_found', reason: 'apex' };
  if (host.kind === 'foreign') {
    // A custom domain reaches the edge as a hostname that is not under our apex.
    // Binding one to a published app needs a pointer that does not exist yet:
    // `custom_domains` carries `driveId` and resolves to a drive's STATIC
    // published site, with no column naming a `published_apps` row. Answering
    // `not_found` here (rather than guessing a drive's app) is what keeps the
    // existing custom-domain behaviour intact — those hosts are served by the
    // proxy's own custom-domain block and never reach this route.
    return { kind: 'not_found', reason: 'custom_host' };
  }

  const app = await deps.findAppBySubdomain(host.subdomain);
  if (!app) return { kind: 'not_found', reason: 'no_such_app' };

  // A STOPPED app never goes to `decideAppRoute` as-is: replaying to it would let
  // Fly's own `autostart` start the machine with no bookkeeping behind it — no
  // status flip, no `awakeBilledThrough` stamp, no hold — and the awake meter,
  // which only reads `status = 'running'` rows, would never see it running at
  // all. `wakePublishedApp` is the seam that does that bookkeeping alongside the
  // balance gate, so it runs here, BEFORE the row is ever handed to the pure
  // decision. A woken app is decided on as `running`; anything else answers the
  // request directly.
  let effectiveStatus = app.status;
  if (app.status === 'stopped') {
    const wakeResult = await deps.wakePublishedApp(app.id);
    switch (wakeResult.outcome) {
      case 'woken':
        effectiveStatus = 'running';
        break;
      case 'parked':
        return { kind: 'parked', reason: 'out_of_credits' };
      case 'start_failed':
        return { kind: 'unavailable', reason: 'failed' };
      case 'refused':
        // 'disabled' means hosting was switched off between this route's own
        // `isEnabled()` check above and this call — answer exactly as that check
        // would have. Every other refusal ('not_found', 'no_machine',
        // 'not_wakeable', 'unresolved_payer') means this row cannot be woken
        // right now, which a router that has never heard of it would call
        // "not serving yet".
        return wakeResult.reason === 'disabled'
          ? { kind: 'unavailable', reason: 'hosting_disabled' }
          : { kind: 'unavailable', reason: 'failed' };
    }
  }

  const routable: RoutableApp = {
    flyAppName: app.flyAppName,
    status: effectiveStatus,
    tier: app.tier,
    hasMachine: app.machineId !== null,
  };

  // Decide as far as the ROW alone allows, with the balance optimistically OK.
  // Anything already refused at this point — parked, destroying, failed, an
  // unknown status, no machine yet — never reaches the ledger. That is not only
  // an optimization: a parked app is exactly the one that keeps receiving
  // crawler and monitor traffic, and charging each of those requests a balance
  // read would make the cheapest possible answer the most expensive one.
  const preliminary = decideAppRoute({ app: routable, balanceOk: true, replayState: 'pending' });
  if (preliminary.kind !== 'replay') return preliminary;

  // Only a servable METERED app is worth asking the ledger about; a dedicated
  // app is billed flat and has no gate. The refusal returns from inside the
  // branch, so past this block the payer is known to be able to spend — which is
  // what lets the final decision below pass `balanceOk: true` as a fact rather
  // than a hope. `decideAppRoute` still re-checks the tier itself, so the skip
  // here can never quietly become the policy.
  if (app.tier === 'metered') {
    const payerId = await deps.resolvePayerId({ driveId: app.driveId });
    // An unresolvable drive fails CLOSED here — the router has no honest payer to
    // ask, so it refuses exactly as the wake gate does for the same condition,
    // rather than assuming a balance nobody can vouch for.
    const balanceOk = payerId
      ? await deps.hasSpendableBalance(payerId, await deps.resolveTier(payerId))
      : false;
    if (!balanceOk) {
      return decideAppRoute({ app: routable, balanceOk: false, replayState: 'pending' });
    }
  }

  // Derive the state key only once the route is otherwise decided-servable: an
  // unset or too-short `APP_REPLAY_SECRET` throws, and a router that cannot
  // authenticate its replays must refuse to emit them rather than send traffic
  // to a published app with a blank state it has no way to distinguish from a
  // direct 6PN caller.
  let replayState: string;
  try {
    replayState = derivePublishedAppReplayKey({
      flyAppName: app.flyAppName,
      secret: deps.replaySecret(),
    });
  } catch {
    return { kind: 'unavailable', reason: 'failed' };
  }

  return decideAppRoute({ app: routable, balanceOk: true, replayState });
}
