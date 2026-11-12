/**
 * Published-site visibility — the IO half (Spec POL-4). See published-visibility-core.ts for why a paused site is
 * moved, not marked, and why visibility is a function of the LIVE policy.
 *
 * Three things use this:
 *  - assertPrefixWritable: every write into `published/<prefix>/` asks first, so a hidden site can never be
 *    re-exposed by a republish, a site-file regeneration or a mirror (the write that would undo the pause).
 *  - reconcileOrgPublishedVisibility: after a policy change, park what is now hidden and restore what is visible.
 *  - reconcileAllPublishedVisibility: the sweep that retries anything a failed object-store call left behind.
 */
import { db } from '@pagespace/db/db';
import { and, eq, inArray, isNotNull, ne } from '@pagespace/db/operators';
import { drives } from '@pagespace/db/schema/core';
import { contentSiteHolds, type ContentSiteHoldSource } from '@pagespace/db/schema/content-safety';
import { customDomains } from '@pagespace/db/schema/custom-domains';
import { driveMembers } from '@pagespace/db/schema/members';
import { loggers } from '../logging/logger-config';
import { getOrgPolicies, listOrgsSettingPolicyKeys } from './policy-reader';
import {
  PARKED_PREFIX,
  PUBLISHED_PREFIX,
  movePrefix,
  prefixVisible,
  type PrefixKind,
  type PublishedObjectStore,
} from './published-visibility-core';

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
type Executor = typeof db | Tx;

export class PublishHiddenError extends Error {
  readonly code = 'org_policy' as const;
  readonly statusCode = 403 as const;
  constructor(
    readonly prefix: string,
    message = "This organization's policies pause publishing to the web, so this site cannot be written to.",
  ) {
    super(message);
    this.name = 'PublishHiddenError';
  }
}

/**
 * A write refused because the drive's sites are held by a content-safety takedown or a user suspension. Same
 * class as the policy refusal, so every caller that already answers 403 for a hidden site does so here too; the
 * wording gives no reason.
 */
export class PublishHeldError extends PublishHiddenError {
  constructor(prefix: string) {
    super(prefix, 'Publishing is not available for this site.');
    this.name = 'PublishHeldError';
  }
}

/** The subset of `driveIds` whose published sites are held (content_site_holds). */
async function heldDriveIds(driveIds: readonly string[], executor: Executor = db): Promise<Set<string>> {
  const held = new Set<string>();
  for (let i = 0; i < driveIds.length; i += 500) {
    const rows = await executor
      .select({ driveId: contentSiteHolds.driveId })
      .from(contentSiteHolds)
      .where(inArray(contentSiteHolds.driveId, driveIds.slice(i, i + 500)));
    for (const row of rows) held.add(row.driveId);
  }
  return held;
}

export async function isDriveSiteHeld(driveId: string, executor: Executor = db): Promise<boolean> {
  return (await heldDriveIds([driveId], executor)).has(driveId);
}

export interface PrefixOwner {
  orgId: string | null;
  kind: PrefixKind;
  driveId: string;
}

/** Who a `published/<prefix>/` belongs to: a drive's own subdomain, or a custom domain host. Null when nobody's. */
export async function resolvePrefixOwner(prefix: string, executor: Executor = db): Promise<PrefixOwner | null> {
  const [site] = await executor.select({ id: drives.id, orgId: drives.orgId }).from(drives).where(eq(drives.publishSubdomain, prefix)).limit(1);
  if (site) return { orgId: site.orgId, kind: 'site', driveId: site.id };
  const [domain] = await executor
    .select({ driveId: customDomains.driveId, platformOwned: customDomains.platformOwned, orgId: drives.orgId })
    .from(customDomains)
    .innerJoin(drives, eq(drives.id, customDomains.driveId))
    .where(eq(customDomains.hostname, prefix))
    .limit(1);
  if (domain) return { orgId: domain.orgId, kind: domain.platformOwned ? 'platform_domain' : 'domain', driveId: domain.driveId };
  return null;
}

/** Whether this owner's prefix should be public: no content-safety hold on the drive, and the org's live policy allows it. */
async function ownerVisible(owner: PrefixOwner, executor: Executor): Promise<boolean> {
  if (await isDriveSiteHeld(owner.driveId, executor)) return false;
  if (!owner.orgId) return true;
  return prefixVisible(await getOrgPolicies(owner.orgId, executor), owner.kind);
}

/**
 * Whether the prefix is publicly readable right now: its drive is not held, and the live policy of its owner's
 * org allows it. Unowned = visible.
 */
export async function isPrefixVisible(prefix: string, executor: Executor = db): Promise<boolean> {
  const owner = await resolvePrefixOwner(prefix, executor);
  if (!owner) return true;
  return ownerVisible(owner, executor);
}

/** Refuse a write into a hidden site. Called before every PUT or COPY into `published/<prefix>/`. */
export async function assertPrefixWritable(prefix: string, executor: Executor = db): Promise<void> {
  const owner = await resolvePrefixOwner(prefix, executor);
  if (!owner) return;
  if (await isDriveSiteHeld(owner.driveId, executor)) throw new PublishHeldError(prefix);
  if (owner.orgId && !prefixVisible(await getOrgPolicies(owner.orgId, executor), owner.kind)) throw new PublishHiddenError(prefix);
}

export interface PrefixOutcome {
  prefix: string;
  action: 'parked' | 'restored' | 'unchanged' | 'failed';
  objects: number;
  error?: string;
}

async function reconcilePrefix(store: PublishedObjectStore, prefix: string, visible: boolean): Promise<PrefixOutcome> {
  try {
    if (visible) {
      const res = await movePrefix(store, `${PARKED_PREFIX}${prefix}/`, `${PUBLISHED_PREFIX}${prefix}/`, { overwrite: false });
      const objects = res.moved + res.kept;
      return { prefix, action: objects > 0 ? 'restored' : 'unchanged', objects };
    }
    const res = await movePrefix(store, `${PUBLISHED_PREFIX}${prefix}/`, `${PARKED_PREFIX}${prefix}/`);
    return { prefix, action: res.moved > 0 ? 'parked' : 'unchanged', objects: res.moved };
  } catch (error) {
    loggers.api.error('Published visibility reconcile failed for a prefix', error as Error, { prefix });
    return { prefix, action: 'failed', objects: 0, error: error instanceof Error ? error.message : String(error) };
  }
}

/** The prefixes an org's drives publish under, with their kind: each drive's subdomain and each custom domain host. */
interface DrivePrefix {
  prefix: string;
  kind: PrefixKind;
  driveId: string;
}

/** The prefixes these drives publish under, with their kind: each drive's subdomain and each custom domain host. */
async function prefixesOfDrives(driveRows: ReadonlyArray<{ id: string; sub: string | null }>, executor: Executor): Promise<DrivePrefix[]> {
  const out: DrivePrefix[] = [];
  for (const d of driveRows) if (d.sub) out.push({ prefix: d.sub, kind: 'site', driveId: d.id });
  const driveIds = driveRows.map((d) => d.id);
  for (let i = 0; i < driveIds.length; i += 500) {
    const domains = await executor
      .select({ host: customDomains.hostname, platformOwned: customDomains.platformOwned, driveId: customDomains.driveId })
      .from(customDomains)
      .where(inArray(customDomains.driveId, driveIds.slice(i, i + 500)));
    for (const d of domains) out.push({ prefix: d.host, kind: d.platformOwned ? 'platform_domain' : 'domain', driveId: d.driveId });
  }
  return out;
}

async function orgPrefixes(orgId: string, executor: Executor): Promise<DrivePrefix[]> {
  const orgDrives = await executor.select({ id: drives.id, sub: drives.publishSubdomain }).from(drives).where(eq(drives.orgId, orgId));
  return prefixesOfDrives(orgDrives, executor);
}

/** Make the bucket match the org's live policies: park every hidden prefix, restore every visible one. */
export async function reconcileOrgPublishedVisibility(orgId: string, store: PublishedObjectStore, executor: Executor = db): Promise<PrefixOutcome[]> {
  const policies = await getOrgPolicies(orgId, executor);
  const prefixes = await orgPrefixes(orgId, executor);
  // A drive held by a takedown or suspension stays parked whatever the policy says.
  const held = await heldDriveIds([...new Set(prefixes.map((p) => p.driveId))], executor);
  const outcomes: PrefixOutcome[] = [];
  for (const { prefix, kind, driveId } of prefixes) {
    outcomes.push(await reconcilePrefix(store, prefix, !held.has(driveId) && prefixVisible(policies, kind)));
  }
  return outcomes;
}

/** Orgs whose stored policies restrict publishing or domains (a key is set; the live parse decides). */
export async function listOrgsRestrictingPublishing(executor: Executor = db): Promise<string[]> {
  const orgs = await listOrgsSettingPolicyKeys(['publishWeb', 'customDomains'], executor);
  return orgs.filter((o) => !o.policies.publishWeb || !o.policies.customDomains).map((o) => o.orgId);
}

/**
 * The retry sweep. (1) Every prefix sitting in `suspended/` is checked against its owner's LIVE policy and restored
 * only if it should be visible again, which is what finishes a restore whose object-store call failed after the
 * policy changed; a prefix that should stay hidden is left alone (never restored and re-parked). (2) Every org that
 * restricts publishing is reconciled, re-parking anything that reappeared in a hidden site's public prefix.
 * (3) Every drive under a content-safety hold is re-parked the same way.
 */
export async function reconcileAllPublishedVisibility(store: PublishedObjectStore, executor: Executor = db): Promise<PrefixOutcome[]> {
  const outcomes: PrefixOutcome[] = [];
  const seen = new Set<string>();
  for (const prefix of await store.listPrefixes(PARKED_PREFIX)) {
    const owner = await resolvePrefixOwner(prefix, executor);
    if (!owner) continue;
    if (!(await ownerVisible(owner, executor))) continue;
    outcomes.push(await reconcilePrefix(store, prefix, true));
    seen.add(prefix);
  }
  for (const orgId of await listOrgsRestrictingPublishing(executor)) {
    for (const o of await reconcileOrgPublishedVisibility(orgId, store, executor)) {
      if (!seen.has(o.prefix)) {
        outcomes.push(o);
        seen.add(o.prefix);
      }
    }
  }
  // (3) Every drive held by a takedown or a suspension is re-parked. A publish that passed the write guard just
  // before its hold was written can land an object after the move; this puts it back within one tick.
  const held = await executor.select({ id: contentSiteHolds.driveId, sub: drives.publishSubdomain }).from(contentSiteHolds).innerJoin(drives, eq(drives.id, contentSiteHolds.driveId));
  for (const { prefix } of await prefixesOfDrives(held, executor)) {
    if (seen.has(prefix)) continue;
    outcomes.push(await reconcilePrefix(store, prefix, false));
  }
  return outcomes;
}

// ---------------------------------------------------------------------------
// Content-safety holds: parking a drive's sites for a takedown or a suspension
// ---------------------------------------------------------------------------

export interface DriveSitesOutcome {
  driveId: string;
  prefixes: PrefixOutcome[];
}

const failedPrefixes = (outcome: DriveSitesOutcome) => outcome.prefixes.filter((p) => p.action === 'failed');

/**
 * Take every published site of a drive off the public bucket and keep it off.
 *
 * The hold row is written FIRST: from that moment every publish write into the drive's prefixes is refused and
 * the reconcile sweep will not restore them, so a failure part-way through the move leaves a site that can only
 * get more hidden, never less. Rerunning finishes the move. Throws when a prefix could not be moved, so the
 * caller's step is recorded as failed and retried; the hold stays.
 */
export async function parkDriveSites(
  input: { driveId: string; source: ContentSiteHoldSource; caseId?: string | null; userId?: string | null; createdBy?: string | null },
  store: PublishedObjectStore,
  executor: Executor = db,
): Promise<DriveSitesOutcome> {
  const hold = {
    driveId: input.driveId,
    source: input.source,
    caseId: input.caseId ?? null,
    userId: input.userId ?? null,
    createdBy: input.createdBy ?? null,
  };
  if (input.source === 'takedown') {
    // A takedown's hold supersedes a suspension's on the same drive. Otherwise the row would stay labelled
    // `user_suspension` and lifting the suspension would put a taken-down site back on the web.
    await executor
      .insert(contentSiteHolds)
      .values(hold)
      .onConflictDoUpdate({
        target: contentSiteHolds.driveId,
        set: { source: 'takedown', caseId: hold.caseId, userId: null, createdBy: hold.createdBy },
      });
  } else {
    // A suspension never relabels an existing hold: a takedown's hold must outlive the suspension.
    await executor.insert(contentSiteHolds).values(hold).onConflictDoNothing({ target: contentSiteHolds.driveId });
  }

  const [drive] = await executor.select({ id: drives.id, sub: drives.publishSubdomain }).from(drives).where(eq(drives.id, input.driveId)).limit(1);
  const prefixes = drive ? await prefixesOfDrives([drive], executor) : [];
  const outcome: DriveSitesOutcome = { driveId: input.driveId, prefixes: [] };
  for (const { prefix } of prefixes) outcome.prefixes.push(await reconcilePrefix(store, prefix, false));

  const failed = failedPrefixes(outcome);
  if (failed.length > 0) throw new Error(`Could not park ${failed.map((p) => p.prefix).join(', ')}: ${failed[0].error ?? 'unknown error'}`);
  return outcome;
}

/**
 * Lift a drive's hold and put back whatever its org's live policy allows. The objects move back BEFORE the hold
 * row is deleted, so a failure leaves the drive held (and hidden) rather than half-restored and unprotected.
 */
export async function restoreDriveSites(driveId: string, store: PublishedObjectStore, executor: Executor = db): Promise<DriveSitesOutcome> {
  const [drive] = await executor.select({ id: drives.id, sub: drives.publishSubdomain, orgId: drives.orgId }).from(drives).where(eq(drives.id, driveId)).limit(1);
  const outcome: DriveSitesOutcome = { driveId, prefixes: [] };
  if (drive) {
    const policies = drive.orgId ? await getOrgPolicies(drive.orgId, executor) : null;
    for (const { prefix, kind } of await prefixesOfDrives([drive], executor)) {
      outcome.prefixes.push(await reconcilePrefix(store, prefix, prefixVisible(policies, kind)));
    }
  }
  const failed = failedPrefixes(outcome);
  if (failed.length > 0) throw new Error(`Could not restore ${failed.map((p) => p.prefix).join(', ')}: ${failed[0].error ?? 'unknown error'}`);
  await executor.delete(contentSiteHolds).where(eq(contentSiteHolds.driveId, driveId));
  return outcome;
}

export interface UserSitesOutcome {
  parked: DriveSitesOutcome[];
  /** Drives left alone, for an admin to decide through a scoped takedown. */
  skipped: Array<{ driveId: string; reason: 'org_drive_with_other_members' }>;
}

/**
 * Park the published sites of the drives a user OWNS (used when suspending them). An org drive that other people
 * are members of is not the user's alone to lose: it is reported in `skipped` and left published.
 * Only drives that publish something are considered.
 */
export async function parkUserSites(
  input: { userId: string; caseId?: string | null; createdBy?: string | null },
  store: PublishedObjectStore,
  executor: Executor = db,
): Promise<UserSitesOutcome> {
  const owned = await executor
    .select({ id: drives.id, sub: drives.publishSubdomain, orgId: drives.orgId })
    .from(drives)
    .where(eq(drives.ownerId, input.userId));
  const publishing = new Set((await prefixesOfDrives(owned, executor)).map((p) => p.driveId));

  const result: UserSitesOutcome = { parked: [], skipped: [] };
  for (const drive of owned) {
    if (!publishing.has(drive.id)) continue;
    if (drive.orgId) {
      // "Other members" means people who really are members: an accepted row with a membership role. A pending
      // invitation or a GUEST row (a redeemed page share link) is not one, so a drive with only those is still
      // this user's alone and is parked.
      const [other] = await executor
        .select({ id: driveMembers.id })
        .from(driveMembers)
        .where(
          and(
            eq(driveMembers.driveId, drive.id),
            ne(driveMembers.userId, input.userId),
            isNotNull(driveMembers.acceptedAt),
            ne(driveMembers.role, 'GUEST'),
          ),
        )
        .limit(1);
      if (other) {
        result.skipped.push({ driveId: drive.id, reason: 'org_drive_with_other_members' });
        continue;
      }
    }
    result.parked.push(
      await parkDriveSites({ driveId: drive.id, source: 'user_suspension', caseId: input.caseId, userId: input.userId, createdBy: input.createdBy }, store, executor),
    );
  }
  return result;
}

/** Restore the sites a user's suspension parked. Holds placed by a takedown on the same drives are left in place. */
export async function restoreUserSites(userId: string, store: PublishedObjectStore, executor: Executor = db): Promise<DriveSitesOutcome[]> {
  const holds = await executor
    .select({ driveId: contentSiteHolds.driveId })
    .from(contentSiteHolds)
    .where(and(eq(contentSiteHolds.userId, userId), eq(contentSiteHolds.source, 'user_suspension')));
  const outcomes: DriveSitesOutcome[] = [];
  for (const hold of holds) outcomes.push(await restoreDriveSites(hold.driveId, store, executor));
  return outcomes;
}
