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
import { eq, inArray, sql } from '@pagespace/db/operators';
import { drives } from '@pagespace/db/schema/core';
import { customDomains } from '@pagespace/db/schema/custom-domains';
import { organizations } from '@pagespace/db/schema/organizations';
import { loggers } from '../logging/logger-config';
import { getOrgPolicies } from './policy-reader';
import { parseOrgPolicies } from './policies-core';
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
  constructor(readonly prefix: string) {
    super("This organization's policies pause publishing to the web, so this site cannot be written to.");
    this.name = 'PublishHiddenError';
  }
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

/** Whether the prefix is publicly readable right now: the live policy of its owner's org. Unowned = visible. */
export async function isPrefixVisible(prefix: string, executor: Executor = db): Promise<boolean> {
  const owner = await resolvePrefixOwner(prefix, executor);
  if (!owner || !owner.orgId) return true;
  return prefixVisible(await getOrgPolicies(owner.orgId, executor), owner.kind);
}

/** Refuse a write into a hidden site. Called before every PUT or COPY into `published/<prefix>/`. */
export async function assertPrefixWritable(prefix: string, executor: Executor = db): Promise<void> {
  if (!(await isPrefixVisible(prefix, executor))) throw new PublishHiddenError(prefix);
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
async function orgPrefixes(orgId: string, executor: Executor): Promise<Array<{ prefix: string; kind: PrefixKind }>> {
  const orgDrives = await executor.select({ id: drives.id, sub: drives.publishSubdomain }).from(drives).where(eq(drives.orgId, orgId));
  const out: Array<{ prefix: string; kind: PrefixKind }> = [];
  for (const d of orgDrives) if (d.sub) out.push({ prefix: d.sub, kind: 'site' });
  const driveIds = orgDrives.map((d) => d.id);
  for (let i = 0; i < driveIds.length; i += 500) {
    const domains = await executor
      .select({ host: customDomains.hostname, platformOwned: customDomains.platformOwned })
      .from(customDomains)
      .where(inArray(customDomains.driveId, driveIds.slice(i, i + 500)));
    for (const d of domains) out.push({ prefix: d.host, kind: d.platformOwned ? 'platform_domain' : 'domain' });
  }
  return out;
}

/** Make the bucket match the org's live policies: park every hidden prefix, restore every visible one. */
export async function reconcileOrgPublishedVisibility(orgId: string, store: PublishedObjectStore, executor: Executor = db): Promise<PrefixOutcome[]> {
  const policies = await getOrgPolicies(orgId, executor);
  const outcomes: PrefixOutcome[] = [];
  for (const { prefix, kind } of await orgPrefixes(orgId, executor)) {
    outcomes.push(await reconcilePrefix(store, prefix, prefixVisible(policies, kind)));
  }
  return outcomes;
}

/** Orgs whose stored policies restrict publishing or domains (a key is set; the live parse decides). */
export async function listOrgsRestrictingPublishing(executor: Executor = db): Promise<string[]> {
  const rows = await executor
    .select({ id: organizations.id, policies: organizations.policies })
    .from(organizations)
    .where(sql`${organizations.policies} ? 'publishWeb' OR ${organizations.policies} ? 'customDomains'`);
  return rows.filter((r) => {
    const p = parseOrgPolicies(r.policies);
    return !p.publishWeb || !p.customDomains;
  }).map((r) => r.id);
}

/**
 * The retry sweep. (1) Every org that restricts publishing is reconciled, re-parking anything that reappeared.
 * (2) Every prefix sitting in `suspended/` is checked against its owner's LIVE policy and restored if it should
 * be visible again, which is what finishes a restore whose object-store call failed after the policy changed.
 */
export async function reconcileAllPublishedVisibility(store: PublishedObjectStore, executor: Executor = db): Promise<PrefixOutcome[]> {
  const outcomes: PrefixOutcome[] = [];
  const seen = new Set<string>();
  for (const orgId of await listOrgsRestrictingPublishing(executor)) {
    for (const o of await reconcileOrgPublishedVisibility(orgId, store, executor)) {
      outcomes.push(o);
      seen.add(o.prefix);
    }
  }
  for (const prefix of await store.listPrefixes(PARKED_PREFIX)) {
    if (seen.has(prefix)) continue;
    const owner = await resolvePrefixOwner(prefix, executor);
    if (!owner) continue;
    const visible = !owner.orgId || prefixVisible(await getOrgPolicies(owner.orgId, executor), owner.kind);
    if (visible) outcomes.push(await reconcilePrefix(store, prefix, true));
  }
  return outcomes;
}
