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
import { and, eq, isNull, or, sql } from '@pagespace/db/operators';
import { publishedApps } from '@pagespace/db/schema/published-apps';
import { hasSpendableBalance } from '../../billing/credit-gate';
import { resolveTier } from '../../billing/credit-balance';
import { loggers } from '../../logging/logger-config';
import { isAppHostingEnabled, resolveHitStampIntervalSeconds } from './app-hosting-env';
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
  /** The payer's subscription tier — the allowance the balance is judged against. */
  resolveTier: (userId: string) => Promise<string>;
  /** Whether the payer can still spend. */
  hasSpendableBalance: (userId: string, tier: string) => Promise<boolean>;
  /**
   * Record that this app was just served — the idle reaper's only evidence of
   * demand. Throttled inside; see {@link stampAppHit}.
   */
  stampHit: (publishedAppId: string) => Promise<void>;
}

/** The columns the routing decision reads. Narrower than the row on purpose. */
export interface PublishedAppRouteRow {
  id: string;
  flyAppName: string;
  status: string;
  tier: string;
  machineId: string | null;
  /**
   * Who pays — `published_apps.ownerId`, denormalized at publish time to the
   * drive owner (`resolveEnvPayerId` semantics).
   *
   * Read from the row rather than re-resolved through the env and drive on every
   * request, and that is a correctness point as much as a performance one: the
   * balance gate must ask about the SAME payer the awake-seconds meter charges,
   * and the meter charges this column. Re-deriving the payer here could disagree
   * with it mid-flight (a drive ownership transfer between the two reads) and
   * park an app whose actual payer is solvent.
   */
  ownerId: string;
}

async function findAppBySubdomainRow(subdomain: string): Promise<PublishedAppRouteRow | null> {
  const [row] = await db
    .select({
      id: publishedApps.id,
      flyAppName: publishedApps.flyAppName,
      status: publishedApps.status,
      tier: publishedApps.tier,
      machineId: publishedApps.machineId,
      ownerId: publishedApps.ownerId,
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
  resolveTier: (userId) => resolveTier(userId),
  hasSpendableBalance: (userId, tier) =>
    hasSpendableBalance(userId, tier as Parameters<typeof hasSpendableBalance>[1]),
  stampHit: stampAppHit,
};

/**
 * Stamp `lastHitAt`, at most once per app per throttle interval.
 *
 * THE THROTTLE IS THE POINT, not an optimization. This runs once per ASSET of every
 * published page, so an unconditional write would turn a single page load into
 * dozens of updates to one row — every one of them contending with the awake
 * meter's own writes to that row, on the hottest path in the system. The age
 * predicate makes all but one of them a statement that matches nothing.
 *
 * `now()` is used rather than a JS clock deliberately: every reader of this column
 * (the reaper's cutoff, this predicate) then compares instants from the same
 * source, and the column is `timestamptz`, so there is no wall-clock/UTC hazard to
 * work around.
 *
 * The interval is read per call so an operator can retune it without a deploy; at
 * 0 every replayed request stamps.
 */
async function stampAppHit(publishedAppId: string): Promise<void> {
  const intervalSeconds = resolveHitStampIntervalSeconds();
  const stale = sql`${publishedApps.lastHitAt} < now() - make_interval(secs => ${intervalSeconds})`;
  await db
    .update(publishedApps)
    .set({ lastHitAt: sql`now()` })
    .where(
      and(
        eq(publishedApps.id, publishedAppId),
        // A never-stamped row always writes: NULL fails every comparison, so the
        // age predicate alone would leave `lastHitAt` NULL forever on exactly the
        // apps that have never been reaped and most need the stamp.
        intervalSeconds > 0 ? or(isNull(publishedApps.lastHitAt), stale) : undefined,
      ),
    );
}

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

  const routable: RoutableApp = {
    flyAppName: app.flyAppName,
    status: app.status,
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
    const tier = await deps.resolveTier(app.ownerId);
    const balanceOk = await deps.hasSpendableBalance(app.ownerId, tier);
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

  const decision = decideAppRoute({ app: routable, balanceOk: true, replayState });

  // Recorded ONLY for a request that is actually being served. A refusal is not
  // demand: stamping one would keep a parked app's machine — and every crawler that
  // keeps hitting it — looking busy to the reaper forever.
  if (decision.kind === 'replay') {
    try {
      await deps.stampHit(app.id);
    } catch (error) {
      // A recency stamp is not worth a failed page. The cost of losing one is that
      // the app looks idle up to one throttle interval earlier than it is, and the
      // next served request corrects it — whereas a 503 here would take a working
      // app off the internet because a bookkeeping write failed.
      loggers.api.warn('Published-app router could not stamp last-hit recency', {
        publishedAppId: app.id,
        error: error instanceof Error ? error.message : 'unknown error',
      });
    }
  }

  return decision;
}
