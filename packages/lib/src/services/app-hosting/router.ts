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
import { defaultAppBillingDeps } from './app-billing';
import { isAppHostingEnabled, resolveHitStampIntervalSeconds } from './app-hosting-env';
import {
  DAILY_CAP_PARK_REASON,
  wakePublishedAppSerialized,
  type WakePublishedAppRunResult,
} from './app-lifecycle-metering';
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
  /**
   * Record that this app was just served — the idle reaper's only evidence of
   * demand. Throttled inside; see {@link stampAppHit}.
   */
  stampHit: (publishedAppId: string) => Promise<void>;
  /**
   * Start a STOPPED app's machine through the metering seam, opening an awake
   * window — see {@link resolveAppRoute} for why the edge, and only the edge, can
   * do this.
   */
  wake: (publishedAppId: string) => Promise<WakePublishedAppRunResult>;
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
  // The SAME resolver `app-billing.ts`'s `defaultAppBillingDeps` hands the meter
  // and the wake gate — not an equivalent, the identical function — so a drift
  // between "who the router asks" and "who the meter charges" is structurally
  // impossible rather than merely kept in sync by convention.
  resolvePayerId: defaultAppBillingDeps.resolvePayerId,
  resolveTier: (userId) => resolveTier(userId),
  hasSpendableBalance: (userId, tier) =>
    hasSpendableBalance(userId, tier as Parameters<typeof hasSpendableBalance>[1]),
  stampHit: stampAppHit,
  wake: (publishedAppId) => wakePublishedAppSerialized(publishedAppId),
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
 * What the edge should answer when a wake did not straightforwardly succeed, or
 * `null` to carry on and replay.
 *
 * TWO outcomes carry on. `woken` is the ordinary one. `wake_in_progress` is the
 * cold-start burst: a page's other twenty requests arrive while the first is still
 * starting the machine, and the honest answer for them is the same as for the
 * winner — the app is starting, replay and let Fly's proxy hold the request for it.
 * `not_wakeable` is the same fact seen a moment later (the winner's status write
 * already landed, so the row is `running` and this wake has nothing to do), and it
 * is the DOMINANT path on a cold app, which is why it may not be treated as a
 * failure.
 *
 * Everything else refuses. Each is a state where replaying would hand Fly a request
 * for a machine we have decided not to pay for — the unmetered start this whole
 * wiring exists to close.
 */
function refusalForWake(wake: WakePublishedAppRunResult, driveId: string): AppRouteDecision | null {
  switch (wake.outcome) {
    case 'woken':
    case 'wake_in_progress':
      return null;
    case 'parked':
      // The gate refused, and the app is now genuinely parked. `daily_cap` is told
      // apart from an empty balance because the two ask different things of the
      // owner (top up, versus wait for tomorrow).
      return {
        kind: 'parked',
        reason: wake.reason === DAILY_CAP_PARK_REASON ? 'daily_cap' : 'out_of_credits',
        driveId,
      };
    case 'start_failed':
      // Fly refused the start. Nothing is billed and nothing is stamped; replaying
      // would ask the proxy to start the same machine outside the seam.
      return { kind: 'unavailable', reason: 'failed', driveId };
    case 'refused':
      switch (wake.reason) {
        case 'not_wakeable':
          return null;
        case 'not_found':
          // The row was deleted between our read and the wake.
          return { kind: 'not_found', reason: 'no_such_app' };
        case 'no_machine':
          // Mid blue/green swap: there is nothing to start yet, and the next
          // deploy finishes in seconds.
          return { kind: 'unavailable', reason: 'deploying', driveId };
        case 'disabled':
          return { kind: 'unavailable', reason: 'hosting_disabled', driveId };
        case 'unresolved_payer':
          // No honest payer, so no start. Refusing costs one visitor a page;
          // serving would bill a machine to somebody who may not own the drive.
          return { kind: 'unavailable', reason: 'failed', driveId };
      }
  }
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
    driveId: app.driveId,
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

  const decision = decideAppRoute({ app: routable, balanceOk: true, replayState });

  // A STOPPED app is servable, and serving it means STARTING ITS MACHINE. Fly's
  // proxy does that by itself the moment a replay reaches it — which is exactly the
  // problem: a machine started that way opens an awake window nobody recorded, on a
  // row that still says `stopped`, so the heartbeat never bills it (it lists
  // `running` rows) and the reaper never stops it (so does it). The app would run
  // free, forever, from its first visit after any idle stop.
  //
  // So the wake goes through the metering seam HERE, at the only place that knows a
  // stopped app is about to be served. That is also where the credit gate was
  // always meant to consume its hold: `wakePublishedApp` gates the payer, places
  // the reservation, starts the machine and moves the row to `running` with its
  // boundary stamped.
  //
  // A wake that does NOT succeed must not fall through to a replay, because a
  // replay is exactly the unmetered start this exists to prevent.
  if (app.status === 'stopped' && decision.kind === 'replay') {
    const wake = await deps.wake(app.id);
    const refusal = refusalForWake(wake, app.driveId);
    if (refusal) return refusal;
  }

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
