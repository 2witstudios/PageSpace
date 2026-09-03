/**
 * provisioner — the imperative shell for published-app lifecycle.
 *
 * Pure decisions (name derivation, legal transitions, whether to provision at all)
 * come from `provisioner-core`; this file only does I/O. Same split as
 * credit-core/credit-consume.
 *
 * THE ORDERING INVARIANT, which is the reason this file is shaped the way it is:
 * the `published_apps` row is inserted BEFORE any Fly API call. A crash between
 * "row committed" and "Fly app created" leaves a harmless row we can retry; the
 * reverse ordering would leave a Fly app billing forever with nothing in our
 * database pointing at it. This is the warm-pool discipline from Fly's own
 * blueprint, and it is not negotiable — if you find yourself moving a Fly call
 * above an insert, you are reintroducing the exact failure the reclaim outbox
 * exists to clean up after.
 *
 * Every exported entry point is gated on `isAppHostingEnabled()` and returns a
 * denial value rather than throwing, so the feature is genuinely dark when off.
 */

import { createId } from '@paralleldrive/cuid2';
import { db } from '@pagespace/db/db';
import {
  publishedApps,
  appDeployTokenMints,
  type PublishedApp,
  type PublishedAppStatus,
} from '@pagespace/db/schema/published-apps';
import { driveEnvs } from '@pagespace/db/schema/drive-envs';
import { publishedAppSubscriptions } from '@pagespace/db/schema/published-app-subscriptions';
import { appHostingStripeReclaims } from '@pagespace/db/schema/app-hosting-stripe-reclaims';
import { and, eq, inArray, isNull, lt, or, sql } from '@pagespace/db/operators';
import {
  isAppHostingEnabled,
  resolveFlyMachinesToken,
  resolvePublishedAppsNetwork,
} from './app-hosting-env';
import {
  createApp as flapsCreateApp,
  deleteApp as flapsDeleteApp,
  createDeployToken as flapsCreateDeployToken,
  type FlapsTransport,
} from '../fly/flaps-client';
import { flyAppNameFor, planProvision, planTransition } from './provisioner-core';
import type { ProvisionDenial, TransitionRefusal } from './provisioner-core';
import { loggers } from '../../logging/logger-config';

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * IO dependencies, injected so tests exercise the composition logic with fakes
 * instead of mocking the database or the network. Defaults wire the real
 * implementations.
 */
export interface ProvisionerDeps {
  isEnabled: () => boolean;
  /** The shared network every published app is created on. */
  resolveNetwork: () => string;
  createFlyApp: (input: { appName: string; orgSlug: string; network: string }) => Promise<void>;
  deleteFlyApp: (appName: string) => Promise<void>;
  mintFlyDeployToken: (appName: string, expiry: string) => Promise<string>;
}

function defaultTransport(): FlapsTransport {
  return { token: resolveFlyMachinesToken() };
}

export const defaultProvisionerDeps: ProvisionerDeps = {
  isEnabled: isAppHostingEnabled,
  resolveNetwork: resolvePublishedAppsNetwork,
  createFlyApp: (input) => flapsCreateApp(defaultTransport(), input),
  deleteFlyApp: (appName) => flapsDeleteApp(defaultTransport(), appName),
  mintFlyDeployToken: (appName, expiry) =>
    flapsCreateDeployToken(defaultTransport(), appName, expiry),
};

export interface CreatePublishedAppInput {
  /** The environment being published. The hosting row's only structural key. */
  envId: string;
  /** The drive that owns the env — denormalized onto the row, and validated against it here. */
  driveId: string;
  ownerId: string;
  subdomain: string;
  orgSlug: string;
  deps?: ProvisionerDeps;
}

export type CreatePublishedAppResult =
  | { ok: true; app: PublishedApp }
  /** The row exists and provisioning was a no-op — not an error. */
  | { ok: true; app: PublishedApp; noop: true }
  | {
      ok: false;
      reason:
        | ProvisionDenial
        | 'fly_error'
        | 'env_not_found'
        | 'env_drive_mismatch'
        /**
         * Another publish won the insert race and its row was gone again before
         * this call could read it — so the env may well still be publishable.
         * NOTHING was created; the caller may simply try again.
         */
        | 'raced';
      error?: string;
    };

/**
 * Provision a published app for an ENVIRONMENT: row first, Fly second.
 *
 * The Fly app is created HERE — at first publish — and never when an env is
 * created. An env is a Sprite-backed machine that costs nothing on Fly's app
 * plane; a Fly app provisioned eagerly at env create would bill for every env
 * that is never published. This is also the only place the two planes meet: the
 * `drive_envs` row is READ (to check it exists and belongs to the drive) and
 * never written, because a hosting row must not be able to modify the
 * environment it serves.
 *
 * `driveId`/`ownerId` are denormalized onto the row so the claim and metering
 * queries skip a join, which makes them a second copy of a fact the env already
 * holds. The database cannot express "this envId's driveId equals that
 * driveId", so the check lives here, BEFORE the row is written — a row whose
 * denormalized drive disagrees with its env would bill the wrong drive and be
 * invisible to the drive that actually owns the app.
 *
 * On a Fly failure the row is stamped `failed` with the error and is NEVER
 * deleted. Deleting it would discard `flyAppName` — the only handle that can
 * destroy an app Fly may in fact have created before the call errored. (Deleting
 * is survivable today only because the AFTER DELETE trigger rescues the name into
 * `app_hosting_reclaims` first; don't design against that safety net, design
 * against needing it.)
 */
export async function createPublishedApp(
  input: CreatePublishedAppInput,
): Promise<CreatePublishedAppResult> {
  const deps = input.deps ?? defaultProvisionerDeps;

  // THE KILL SWITCH IS READ BEFORE THE DATABASE IS TOUCHED. `planProvision` denies
  // on it too, but only after this function has already queried — and a dark
  // deployment is exactly the one where `published_apps` may not exist yet (the
  // hosting migration unapplied, or the database unreachable). Querying first turns
  // the documented `disabled` denial into a thrown error, which is not failing
  // closed. Every other entry point checks first; this one now matches them.
  if (!deps.isEnabled()) return { ok: false, reason: 'disabled' };

  // The env has to exist and has to belong to the drive we are about to stamp on
  // the row. Read before anything else is decided: the denormalized `driveId` is
  // what billing and the claim queries trust, so a mismatch has to be refused
  // rather than recorded.
  const [env] = await db
    .select({ id: driveEnvs.id, driveId: driveEnvs.driveId })
    .from(driveEnvs)
    .where(eq(driveEnvs.id, input.envId))
    .limit(1);
  if (!env) return { ok: false, reason: 'env_not_found' };
  if (env.driveId !== input.driveId) return { ok: false, reason: 'env_drive_mismatch' };

  // The WHOLE row, in one read. An earlier cut selected {id, status} here and
  // re-read the full row on the no-op path, which returned `app: undefined` — typed
  // as `PublishedApp` — whenever the row was deleted between the two reads. One
  // read has no window to race.
  const existing = await db
    .select()
    .from(publishedApps)
    .where(eq(publishedApps.envId, input.envId))
    .limit(1);

  const plan = planProvision({ enabled: deps.isEnabled(), existingStatus: existing[0]?.status });

  if (plan.action === 'deny') {
    return { ok: false, reason: plan.reason };
  }

  if (plan.action === 'noop') {
    return { ok: true, app: existing[0], noop: true };
  }

  const network = deps.resolveNetwork();

  // STEP 1 — the row, before any Fly call. `flyAppName` is derived from the id,
  // so we generate the id here rather than letting the column default fill it:
  // the name has to be known and persisted in the same statement that creates the
  // pointer.
  const id = existing[0]?.id ?? createId();
  const flyAppName = flyAppNameFor(id);

  let row: PublishedApp;
  if (existing[0]) {
    // Retry of a previously failed provision — reuse the row (and therefore the
    // same Fly app name, which makes the create idempotent).
    //
    // `input.subdomain` is deliberately NOT re-applied. The row's subdomain is
    // the address the app is already published at; changing it is a rename, with
    // its own DNS and cache consequences, not something a retried provision
    // should do as a side effect.
    const [updated] = await db
      .update(publishedApps)
      .set({ status: 'provisioning', networkName: network, lastError: null })
      .where(eq(publishedApps.id, existing[0].id))
      .returning();
    row = updated;
  } else {
    // ON CONFLICT on `envId` ONLY, and it is the read above losing a race that
    // this handles: two publishes of one env arriving together both see no row,
    // and the unique index then rejects the second insert. Without this the
    // loser throws a constraint violation — while the env demonstrably HAS a
    // hosting row, which is the documented `noop`, not an error. Deliberately
    // narrow: a `subdomain` or `flyAppName` collision is a different fact about
    // a different resource and must keep surfacing rather than be absorbed into
    // "already published".
    const [inserted] = await db
      .insert(publishedApps)
      .values({
        id,
        envId: input.envId,
        driveId: input.driveId,
        ownerId: input.ownerId,
        flyAppName,
        networkName: network,
        subdomain: input.subdomain,
        status: 'provisioning',
      })
      .onConflictDoNothing({ target: publishedApps.envId })
      .returning();

    if (!inserted) {
      // The other publish won. Its row is the answer — including its Fly app
      // name, which is derived from ITS id, so continuing with the name derived
      // above would create a second Fly app for one env.
      const [winner] = await db
        .select()
        .from(publishedApps)
        .where(eq(publishedApps.envId, input.envId))
        .limit(1);
      // Deleted again between the conflict and this read — an unpublish landing
      // in the microseconds after the conflict, or the env itself going away.
      // `env_not_found` would be a guess about which; nothing was created either
      // way, so say exactly that and let the caller retry.
      if (!winner) return { ok: false, reason: 'raced' };
      return { ok: true, app: winner, noop: true };
    }

    row = inserted;
  }

  // STEP 2 — only now does anything reach Fly.
  try {
    await deps.createFlyApp({ appName: row.flyAppName, orgSlug: input.orgSlug, network });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'unknown Fly error';
    await db
      .update(publishedApps)
      .set({ status: 'failed', lastError: message })
      .where(eq(publishedApps.id, row.id));
    loggers.api.error('Published app Fly create failed; row retained for retry/reclaim', {
      publishedAppId: row.id,
      flyAppName: row.flyAppName,
      error: message,
    });
    return { ok: false, reason: 'fly_error', error: message };
  }

  const [ready] = await db
    .update(publishedApps)
    .set({ status: 'building' })
    .where(eq(publishedApps.id, row.id))
    .returning();

  return { ok: true, app: ready };
}

export type DestroyPublishedAppResult =
  | { ok: true }
  | { ok: false; reason: 'disabled' | 'not_found' | 'fly_error'; error?: string };

/**
 * Tear a published app down: mark `destroying`, delete the Fly app, then delete
 * the row.
 *
 * UNPUBLISHING IS NOT DELETING AN ENVIRONMENT. Nothing here reads or writes
 * `drive_envs`: the env outlives its hosting row, keeps its Sprite and its
 * sessions, and can be published again. The cascade runs one way only — deleting
 * the env destroys this row, never the reverse.
 *
 * Deleting the row fires the AFTER DELETE trigger, which enqueues the name into
 * `app_hosting_reclaims` even on this clean path. That is deliberate belt and
 * braces: the drain cron's kill is idempotent, so the redundant entry simply
 * confirms the death and drops itself — and it covers the case where `deleteApp`
 * returned success but Fly had not in fact finished.
 *
 * The row delete cascades away `published_app_subscriptions` (the dedicated-tier
 * Stripe mirror) WITHOUT cancelling anything at Stripe — see that table's
 * docblock. So before deleting, this reads any subscription mirror for the app
 * and, in the SAME transaction as the delete, writes its Stripe subscription id
 * into `app_hosting_stripe_reclaims`. Either both the row and the rescue land, or
 * neither does — a deleted app can never strand a still-billing subscription.
 */
export async function destroyPublishedApp(
  publishedAppId: string,
  deps: ProvisionerDeps = defaultProvisionerDeps,
): Promise<DestroyPublishedAppResult> {
  if (!deps.isEnabled()) return { ok: false, reason: 'disabled' };

  const [row] = await db
    .select()
    .from(publishedApps)
    .where(eq(publishedApps.id, publishedAppId))
    .limit(1);
  if (!row) return { ok: false, reason: 'not_found' };

  await db
    .update(publishedApps)
    .set({ status: 'destroying' })
    .where(eq(publishedApps.id, publishedAppId));

  try {
    await deps.deleteFlyApp(row.flyAppName);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'unknown Fly error';
    // Leave the row at `destroying` with the error: the pointer must survive a
    // failed kill so the teardown can be retried.
    await db
      .update(publishedApps)
      .set({ lastError: message })
      .where(eq(publishedApps.id, publishedAppId));
    return { ok: false, reason: 'fly_error', error: message };
  }

  await db.transaction(async (tx) => {
    // Locked FIRST, before reading `publishedAppSubscriptions` below — the
    // same row, same lock, same order as `recordDedicatedSubscription`'s own
    // guard (`dedicated-tier-service.ts`), which closes the race this
    // ordering exists for: a dedicated-tier PURCHASE racing this destroy
    // could otherwise insert a brand-new subscription mirror after this
    // transaction's subscription read but before its DELETE commits, and the
    // `ON DELETE CASCADE` would remove that mirror with no reclaim row ever
    // written for its Stripe subscription — a live, still-billing
    // subscription stranded with no local pointer at all. Whichever
    // transaction acquires this lock first now fully completes before the
    // other proceeds: if this one wins, the purchase blocks until after the
    // delete and then refuses (the app row is gone, or `status` already
    // reads `destroying`); if the purchase wins, its committed row is what
    // this transaction's subscription read below actually sees.
    await tx.execute(sql`SELECT 1 FROM ${publishedApps} WHERE ${publishedApps.id} = ${publishedAppId} FOR UPDATE`);

    const [subscription] = await tx
      .select({ stripeSubscriptionId: publishedAppSubscriptions.stripeSubscriptionId })
      .from(publishedAppSubscriptions)
      .where(eq(publishedAppSubscriptions.publishedAppId, publishedAppId))
      .limit(1);

    if (subscription) {
      await tx
        .insert(appHostingStripeReclaims)
        .values({ stripeSubscriptionId: subscription.stripeSubscriptionId, publishedAppId })
        .onConflictDoNothing();
    }

    await tx.delete(publishedApps).where(eq(publishedApps.id, publishedAppId));
  });

  return { ok: true };
}

/**
 * How long a claim holds a row before another worker may take it.
 *
 * Long enough that a healthy worker's unit of work — a Fly create plus a wait for
 * the machine to reach state — never expires mid-flight; short enough that a
 * crashed worker's apps are picked up again in minutes rather than never.
 */
export const PUBLISHED_APP_CLAIM_LEASE_MS = 5 * 60 * 1000;

/**
 * A batch of rows claimed by one worker, and the token proving the claim is his.
 *
 * The token is minted here and never read back, so the value the worker believes
 * it holds is by construction the value the rows carry — nothing is lost to driver
 * conversion on the round trip.
 */
export interface PublishedAppClaim {
  readonly token: string;
  readonly apps: PublishedApp[];
}

/**
 * The lease clock is POSTGRES'S, never a worker's. A lease stamped by one process
 * and judged by another is only as good as the agreement between their clocks, and
 * this is the mechanism preventing two workers from provisioning the same app.
 * Reading and writing the instant in the database removes the disagreement instead
 * of bounding it.
 *
 * `now()` unqualified is correct HERE specifically because these columns are
 * `timestamp with time zone`: the value is an absolute instant, so no session
 * TimeZone can reinterpret it. (Against a `timestamp without time zone` column the
 * same expression would silently store local wall-clock — see
 * `broadcast_recipients`, whose columns are naive and which must write
 * `now() at time zone 'utc'`.)
 */
function dbNow() {
  return sql`now()`;
}

/**
 * Claim published apps for background work, one worker at a time per row.
 *
 * TWO MECHANISMS, and both are load-bearing:
 *
 *  - `FOR UPDATE SKIP LOCKED` makes the claim RACE-FREE. A second worker that finds
 *    a row locked moves on to the NEXT app rather than blocking behind the first,
 *    so one slow provision cannot serialise the fleet — which is what the
 *    per-object (not global) Fly rate limit invites us to avoid.
 *  - The `claimedAt`/`claimedBy` WRITE makes the claim DURABLE. Row locks live and
 *    die with their transaction, and this transaction commits before the caller has
 *    done a single thing with the rows it got back. A select-only claim therefore
 *    hands the same rows to the next worker a millisecond later, and the two run
 *    duplicate Fly operations against the same app — the exact failure the lock
 *    appears to prevent. Persisting the claim inside the locking transaction is
 *    what makes "two concurrent workers get disjoint sets" true after the commit
 *    rather than only during it.
 *
 * The claim is a LEASE, not a flag: rows whose claim is older than `leaseMs` are
 * claimable again, so a worker that dies mid-provision costs one lease interval
 * instead of stranding its apps forever.
 *
 * Claiming bumps `updatedAt` (the ordering column), so a claimed-and-released row
 * goes to the back of the queue rather than being re-picked ahead of its peers.
 *
 * @returns the claimed rows and the token that owns them. Pass the token to
 *   `releasePublishedAppClaim` when the work is done; without it a release cannot
 *   tell "clear MY claim" from "revoke the claim of the worker that took over after
 *   my lease expired".
 */
export async function claimPublishedAppsForWork({
  statuses,
  limit,
  leaseMs = PUBLISHED_APP_CLAIM_LEASE_MS,
  staleForMs,
  deps = defaultProvisionerDeps,
}: {
  statuses: PublishedAppStatus[];
  limit: number;
  leaseMs?: number;
  /**
   * Only claim rows that have sat in their status at least this long.
   *
   * MUST BE EVALUATED IN THIS QUERY, and cannot be a filter the caller applies to
   * the returned rows: claiming WRITES `claimedAt`, which bumps `updatedAt` (the
   * ordering column, `$onUpdate`), so the very act of claiming destroys the age
   * signal a caller would filter on. The build reconciler's entire premise — "this
   * app has been building for twenty minutes, its worker is dead" — depends on the
   * age being read before the claim rewrites it.
   */
  staleForMs?: number;
  deps?: ProvisionerDeps;
}): Promise<PublishedAppClaim> {
  const token = createId();
  if (!deps.isEnabled()) return { token, apps: [] };
  if (statuses.length === 0) return { token, apps: [] };

  return db.transaction(async (tx: Tx) => {
    const rows = await tx
      .select({ id: publishedApps.id })
      .from(publishedApps)
      .where(
        and(
          inArray(publishedApps.status, statuses),
          // Unclaimed, or claimed by a worker whose lease has expired.
          or(
            isNull(publishedApps.claimedAt),
            lt(publishedApps.claimedAt, sql`${dbNow()} - make_interval(secs => ${leaseMs / 1000})`),
          ),
          ...(staleForMs === undefined
            ? []
            : [
                lt(
                  publishedApps.updatedAt,
                  sql`${dbNow()} - make_interval(secs => ${staleForMs / 1000})`,
                ),
              ]),
        ),
      )
      .orderBy(publishedApps.updatedAt)
      .limit(limit)
      .for('update', { skipLocked: true });

    if (rows.length === 0) return { token, apps: [] };

    const apps = await tx
      .update(publishedApps)
      .set({ claimedAt: dbNow(), claimedBy: token })
      .where(inArray(publishedApps.id, rows.map((row) => row.id)))
      .returning();

    return { token, apps };
  });
}

/**
 * Release a claim, so the rows are workable again before their lease expires.
 *
 * FENCED ON THE TOKEN. A worker whose work outlived its lease has already been
 * superseded, and an unfenced release would clear the NEW holder's claim and hand
 * the row to a third worker while the second is still mid-flight. Matching on
 * `claimedBy` makes "I once held this" fail and "I still hold this" succeed.
 *
 * @returns how many rows this claim actually still held.
 */
export async function releasePublishedAppClaim(
  publishedAppIds: string[],
  token: string,
  deps: ProvisionerDeps = defaultProvisionerDeps,
): Promise<number> {
  if (!deps.isEnabled()) return 0;
  if (publishedAppIds.length === 0) return 0;

  const released = await db
    .update(publishedApps)
    .set({ claimedAt: null, claimedBy: null })
    .where(and(inArray(publishedApps.id, publishedAppIds), eq(publishedApps.claimedBy, token)))
    .returning({ id: publishedApps.id });

  return released.length;
}

export type TransitionResult =
  | { ok: true; app: PublishedApp }
  | { ok: false; reason: TransitionRefusal | 'disabled' | 'not_found' };

/**
 * The columns a transition may write ALONGSIDE the status.
 *
 * Not a convenience: `running` requires a machine id and `running`/`deploying`
 * require an image digest, as CHECK constraints. Those columns therefore have to
 * land in the SAME statement as the status they license, or the write is rejected
 * by the database no matter what order the caller does it in.
 */
export interface TransitionPatch {
  machineId?: string | null;
  imageDigest?: string | null;
  /**
   * Travels with `imageDigest` and never alone — a size attributed to the wrong
   * digest is worse than an absent one.
   *
   * Supplying this also STAMPS `imageSizeMeasuredAt` (see `transitionPublishedApp`):
   * the storage meter cannot use a measurement it cannot date, and the pair is a
   * CHECK constraint, so the caller never sets the timestamp itself.
   */
  imageSizeBytes?: number | null;
  lastError?: string | null;
}

/**
 * Move a published app to a new status, refusing illegal edges.
 *
 * The row is locked for the read so the decision is made against state that cannot
 * change underneath it — two crons racing to move the same app produce one winner
 * and one refusal, rather than two writes where the second silently overwrites a
 * transition the first had already validated.
 *
 * THE DECISION IS MADE AGAINST THE POST-WRITE ROW, not just the edge. `planTransition`
 * is handed the columns as they will be after `patch` is applied, so a transition
 * the database's CHECK constraints would reject comes back as a refusal VALUE
 * (`serving_requires_image`, `running_requires_machine`, …) rather than a thrown
 * constraint violation that aborts the transaction. Every entry point here returns
 * a denial rather than throwing, and a legal-by-the-table edge that the database
 * then refuses was the one hole in that contract.
 */
export async function transitionPublishedApp(
  publishedAppId: string,
  to: PublishedAppStatus,
  {
    patch = {},
    deps = defaultProvisionerDeps,
  }: { patch?: TransitionPatch; deps?: ProvisionerDeps } = {},
): Promise<TransitionResult> {
  if (!deps.isEnabled()) return { ok: false, reason: 'disabled' };

  return db.transaction(async (tx: Tx) => {
    const [row] = await tx
      .select()
      .from(publishedApps)
      .where(eq(publishedApps.id, publishedAppId))
      .limit(1)
      .for('update');
    if (!row) return { ok: false, reason: 'not_found' as const };

    const plan = planTransition(row.status, to, {
      imageDigest: patch.imageDigest === undefined ? row.imageDigest : patch.imageDigest,
      machineId: patch.machineId === undefined ? row.machineId : patch.machineId,
      // A transition never changes the tier; the plan reads it only because
      // `parked` is metered-only.
      tier: row.tier,
    });
    if (!plan.allowed) return { ok: false, reason: plan.reason };

    const [updated] = await tx
      .update(publishedApps)
      .set({
        status: to,
        ...patch,
        // The size and its timestamp are one fact and land in one statement, which
        // is what `published_apps_image_size_measured_coherent` enforces. Stamped
        // HERE rather than by each caller because this is the only writer of
        // `imageSizeBytes`, and a size the storage meter cannot date reads to it as
        // "never measured" — billing the 0 floor forever while the watermark
        // advances over real rootfs. Clearing the size clears the stamp with it.
        ...(patch.imageSizeBytes === undefined
          ? {}
          : { imageSizeMeasuredAt: patch.imageSizeBytes === null ? null : new Date() }),
      })
      .where(eq(publishedApps.id, publishedAppId))
      .returning();
    return { ok: true as const, app: updated };
  });
}

export type MintDeployTokenResult =
  | { ok: true; token: string }
  | { ok: false; reason: 'disabled' | 'not_found' | 'fly_error'; error?: string };

/**
 * Mint an app-scoped Fly deploy token and record that the mint happened.
 *
 * Fly's response carries the token and nothing else — no id, no expires_at — so
 * the `app_deploy_token_mints` row written here is THE ONLY EVIDENCE this
 * credential was ever created. Writing it is part of minting, not a follow-up
 * step: a token handed out with no record is one nobody can audit, and since a
 * deploy token can renew itself indefinitely, the only revocation is destroying
 * the app it belongs to.
 *
 * The token VALUE is returned to the caller and never persisted. Storing a
 * self-renewing app-scoped credential would make this audit table worth more to an
 * attacker than the apps it documents.
 *
 * TWO-PHASE, for the same reason the `published_apps` row precedes the Fly app: the
 * intent row is written BEFORE the mint and settled after it. Minting first and
 * recording second loses the entire record if the process dies in between — and
 * what is lost is a live credential nobody can account for. Recording first inverts
 * that: the worst case becomes a `pending` row for a token that was never issued,
 * which is noise a reconciler can read.
 *
 * A row left `pending` means MAYBE MINTED. It is not evidence of failure, and the
 * only safe remediation is at the app level — Fly returns no token id, so a
 * suspected stray token is revoked by destroying its app, never by assuming the
 * call did not land.
 */
export async function mintDeployToken({
  publishedAppId,
  expiry,
  purpose,
  deps = defaultProvisionerDeps,
}: {
  publishedAppId: string;
  /** The lifetime requested of Fly, e.g. '48h'. Sent verbatim and recorded verbatim. */
  expiry: string;
  purpose: 'build' | 'rotate';
  deps?: ProvisionerDeps;
}): Promise<MintDeployTokenResult> {
  if (!deps.isEnabled()) return { ok: false, reason: 'disabled' };

  const [row] = await db
    .select({ id: publishedApps.id, flyAppName: publishedApps.flyAppName })
    .from(publishedApps)
    .where(eq(publishedApps.id, publishedAppId))
    .limit(1);
  if (!row) return { ok: false, reason: 'not_found' };

  // PHASE 1 — the intent, before Fly is called. Its id is generated here so phase 2
  // settles exactly this row without a read-back.
  const mintId = createId();
  await db.insert(appDeployTokenMints).values({
    id: mintId,
    publishedAppId: row.id,
    flyAppName: row.flyAppName,
    expiry,
    purpose,
    outcome: 'pending',
  });

  let token: string;
  try {
    token = await deps.mintFlyDeployToken(row.flyAppName, expiry);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'unknown Fly error';
    // PHASE 2 (failure) — settled, not deleted. A Fly error that arrived after the
    // mint committed would still leave a token, so the attempt stays on the record.
    await settleMint(mintId, 'failed', row);
    return { ok: false, reason: 'fly_error', error: message };
  }

  // PHASE 2 (success).
  await settleMint(mintId, 'minted', row);

  return { ok: true, token };
}

/**
 * Move a mint intent out of `pending`. `settledAt` and `outcome` move together —
 * a CHECK requires it.
 *
 * NEVER THROWS, and that is why the try/catch lives in here rather than at the two
 * call sites. Settling is bookkeeping that happens after the outcome is already
 * decided: on the success path the caller holds a working token, and on the failure
 * path it holds a `fly_error` denial. Letting a failed bookkeeping write replace
 * either of those with a thrown database error breaks the module's contract that
 * every entry point returns a value — and on the failure path it would do so while
 * discarding the reason Fly gave. The row simply stays `pending`, which already
 * carries the fact worth keeping ("a credential may exist for this app"), logged at
 * error level so an unsettled row is detectable rather than merely present.
 */
async function settleMint(
  mintId: string,
  outcome: 'minted' | 'failed',
  row: { id: string; flyAppName: string },
): Promise<void> {
  try {
    await db
      .update(appDeployTokenMints)
      .set({ outcome, settledAt: dbNow() })
      .where(eq(appDeployTokenMints.id, mintId));
  } catch (error) {
    loggers.api.error('Deploy token mint could not be settled; audit row left pending', {
      publishedAppId: row.id,
      flyAppName: row.flyAppName,
      mintId,
      intendedOutcome: outcome,
      error: error instanceof Error ? error.message : 'unknown database error',
    });
  }
}

/**
 * Load one published app by id. Returns null when hosting is disabled, so a
 * background worker reading this row is dark too.
 */
export async function getPublishedApp(
  publishedAppId: string,
  deps: ProvisionerDeps = defaultProvisionerDeps,
): Promise<PublishedApp | null> {
  if (!deps.isEnabled()) return null;
  const [row] = await db
    .select()
    .from(publishedApps)
    .where(eq(publishedApps.id, publishedAppId))
    .limit(1);
  return row ?? null;
}

/**
 * Record why work could not proceed, WITHOUT moving the status.
 *
 * Status-free on purpose. The writer is a build the worker could not even attempt
 * (no Docker builder on the host): that is our infrastructure failing, not the
 * user's app, and marking their app `failed` would both misattribute the fault and
 * cost them the automatic retry — `failed` re-enters the pipeline only through an
 * explicit provisioning retry. The row stays `building`, the reason is legible,
 * and the reconciler stays responsible for it.
 */
export async function annotatePublishedApp(
  publishedAppId: string,
  fields: { lastError?: string | null },
  deps: ProvisionerDeps = defaultProvisionerDeps,
): Promise<void> {
  if (!deps.isEnabled()) return;
  if (Object.keys(fields).length === 0) return;
  await db
    .update(publishedApps)
    .set(fields)
    .where(eq(publishedApps.id, publishedAppId));
}

/**
 * Look up a published app by the subdomain it serves — the router's read.
 * Returns null when hosting is disabled, so the routing tier is dark too.
 */
export async function findPublishedAppBySubdomain(
  subdomain: string,
  deps: ProvisionerDeps = defaultProvisionerDeps,
): Promise<PublishedApp | null> {
  if (!deps.isEnabled()) return null;
  const [row] = await db
    .select()
    .from(publishedApps)
    .where(eq(publishedApps.subdomain, subdomain))
    .limit(1);
  return row ?? null;
}
