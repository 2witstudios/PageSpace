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
import { eq, inArray } from '@pagespace/db/operators';
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
} from './flaps-client';
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
  pageId: string;
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
  | { ok: false; reason: ProvisionDenial | 'fly_error'; error?: string };

/**
 * Provision a published app: row first, Fly second.
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

  const existing = await db
    .select({ id: publishedApps.id, status: publishedApps.status })
    .from(publishedApps)
    .where(eq(publishedApps.pageId, input.pageId))
    .limit(1);

  const plan = planProvision({ enabled: deps.isEnabled(), existingStatus: existing[0]?.status });

  if (plan.action === 'deny') {
    return { ok: false, reason: plan.reason };
  }

  if (plan.action === 'noop') {
    const [row] = await db
      .select()
      .from(publishedApps)
      .where(eq(publishedApps.pageId, input.pageId))
      .limit(1);
    return { ok: true, app: row, noop: true };
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
    const [updated] = await db
      .update(publishedApps)
      .set({ status: 'provisioning', networkName: network, lastError: null })
      .where(eq(publishedApps.id, existing[0].id))
      .returning();
    row = updated;
  } else {
    const [inserted] = await db
      .insert(publishedApps)
      .values({
        id,
        pageId: input.pageId,
        driveId: input.driveId,
        ownerId: input.ownerId,
        flyAppName,
        networkName: network,
        subdomain: input.subdomain,
        status: 'provisioning',
      })
      .returning();
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
 * Deleting the row fires the AFTER DELETE trigger, which enqueues the name into
 * `app_hosting_reclaims` even on this clean path. That is deliberate belt and
 * braces: the drain cron's kill is idempotent, so the redundant entry simply
 * confirms the death and drops itself — and it covers the case where `deleteApp`
 * returned success but Fly had not in fact finished.
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

  await db.delete(publishedApps).where(eq(publishedApps.id, publishedAppId));
  return { ok: true };
}

/**
 * Claim published apps for background work, one worker at a time per row.
 *
 * `FOR UPDATE SKIP LOCKED` rather than a plain `FOR UPDATE`: a second worker that
 * finds a row already claimed must move on to the NEXT app, not block behind the
 * first. Blocking would serialise the whole fleet behind one slow provision, which
 * is exactly what the per-object (not global) Fly rate limit is inviting us to
 * avoid. Rows already locked are invisible to this query, so two concurrent
 * workers get disjoint sets.
 *
 * This is the repo's first `SKIP LOCKED`, hence the explanation.
 */
export async function claimPublishedAppsForWork({
  statuses,
  limit,
  deps = defaultProvisionerDeps,
}: {
  statuses: PublishedAppStatus[];
  limit: number;
  deps?: ProvisionerDeps;
}): Promise<PublishedApp[]> {
  if (!deps.isEnabled()) return [];
  if (statuses.length === 0) return [];

  return db.transaction(async (tx: Tx) => {
    const rows = await tx
      .select()
      .from(publishedApps)
      .where(inArray(publishedApps.status, statuses))
      .orderBy(publishedApps.updatedAt)
      .limit(limit)
      .for('update', { skipLocked: true });
    return rows;
  });
}

export type TransitionResult =
  | { ok: true; app: PublishedApp }
  | { ok: false; reason: TransitionRefusal | 'disabled' | 'not_found' };

/**
 * Move a published app to a new status, refusing illegal edges.
 *
 * The row is locked for the read so the decision is made against state that cannot
 * change underneath it — two crons racing to move the same app produce one winner
 * and one refusal, rather than two writes where the second silently overwrites a
 * transition the first had already validated.
 */
export async function transitionPublishedApp(
  publishedAppId: string,
  to: PublishedAppStatus,
  deps: ProvisionerDeps = defaultProvisionerDeps,
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

    const plan = planTransition(row.status, to);
    if (!plan.allowed) return { ok: false, reason: plan.reason };

    const [updated] = await tx
      .update(publishedApps)
      .set({ status: to })
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

  let token: string;
  try {
    token = await deps.mintFlyDeployToken(row.flyAppName, expiry);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'unknown Fly error';
    return { ok: false, reason: 'fly_error', error: message };
  }

  await db.insert(appDeployTokenMints).values({
    publishedAppId: row.id,
    flyAppName: row.flyAppName,
    expiry,
    purpose,
  });

  return { ok: true, token };
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
