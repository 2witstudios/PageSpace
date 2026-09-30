/**
 * Policy suspension (Spec POL-1; Vision principle 7 "suspend, never delete").
 *
 * When a policy newly forbids something that already exists, the row is MARKED, not deleted and not
 * edited: `suspendedByPolicy` names the rule. Turning the policy back on clears exactly the rows that
 * rule marked. Because the marker sits beside the row's own state (an inactive or expired link stays
 * inactive or expired), restoring can never revive something a person had turned off, and suspending
 * never destroys anything.
 *
 * `applySuspension` is a reconcile against the policies in force, not a diff: for each kind it marks
 * what is forbidden and unmarked, then clears what is marked by that kind and no longer forbidden.
 * Run twice it changes nothing, and it heals a partial earlier run.
 *
 * Guests live in permissions/guest-suspension.ts because they are drive_members rows.
 */
import type { AnyPgColumn } from 'drizzle-orm/pg-core';
import { db } from '@pagespace/db/db';
import { and, eq, inArray, isNotNull, isNull, notInArray, or, gt, sql } from '@pagespace/db/operators';
import { drives, pages } from '@pagespace/db/schema/core';
import { customDomains } from '@pagespace/db/schema/custom-domains';
import { integrationConnections, integrationProviders } from '@pagespace/db/schema/integrations';
import type { SuspensionKind } from '@pagespace/db/schema/organizations';
import { publishedPages } from '@pagespace/db/schema/published-pages';
import { driveShareLinks, pageShareLinks } from '@pagespace/db/schema/share-links';
import { listSuspendedOrgGuests, restoreOrgGuests, suspendOrgGuests } from '../permissions/guest-suspension';
import { suspensionTargets, type OrgPolicies } from './policies-core';

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
type Executor = typeof db | Tx;

export const SUSPENDED_RESOURCE_TYPES = [
  'drive_share_link',
  'page_share_link',
  'published_page',
  'custom_domain',
  'integration_connection',
  'drive_member',
] as const;
export type SuspendedResourceType = (typeof SUSPENDED_RESOURCE_TYPES)[number];

/** One suspended (or restored) row: enough to list it and find it again, no content. */
export interface PolicySuspensionItem {
  kind: SuspensionKind;
  resourceType: SuspendedResourceType;
  id: string;
  driveId: string;
  /** Only guests: the person whose access is suspended. */
  userId?: string;
}

export interface SuspensionOutcome {
  suspended: PolicySuspensionItem[];
  restored: PolicySuspensionItem[];
}

const EMPTY: SuspensionOutcome = { suspended: [], restored: [] };

const orgDriveIds = (executor: Executor, orgId: string) =>
  executor.select({ id: drives.id }).from(drives).where(eq(drives.orgId, orgId));

const orgPageIds = (executor: Executor, orgId: string) =>
  executor.select({ id: pages.id }).from(pages).where(inArray(pages.driveId, orgDriveIds(executor, orgId)));

const notNow = (expiresAt: AnyPgColumn) => or(isNull(expiresAt), gt(expiresAt, sql`(now() at time zone 'utc')`));

/** Providers a drive connection may use: connections whose provider slug is outside `allowed`. */
const disallowedProviderIds = (executor: Executor, allowed: string[]) =>
  executor
    .select({ id: integrationProviders.id })
    .from(integrationProviders)
    .where(allowed.length === 0 ? sql`true` : notInArray(integrationProviders.slug, allowed));

async function reconcileShareLinks(executor: Executor, orgId: string, forbidden: boolean): Promise<SuspensionOutcome> {
  const kind: SuspensionKind = 'publicShareLinks';
  const item = (resourceType: SuspendedResourceType) => (r: { id: string; driveId: string }): PolicySuspensionItem => ({ kind, resourceType, id: r.id, driveId: r.driveId });
  if (forbidden) {
    // Only links that are live now: an inactive or expired link is already refused and stays as it is.
    const drivesLinks = await executor
      .update(driveShareLinks)
      .set({ suspendedByPolicy: kind })
      .where(and(isNull(driveShareLinks.suspendedByPolicy), eq(driveShareLinks.isActive, true), notNow(driveShareLinks.expiresAt), inArray(driveShareLinks.driveId, orgDriveIds(executor, orgId))))
      .returning({ id: driveShareLinks.id, driveId: driveShareLinks.driveId });
    const pageLinks = await executor
      .update(pageShareLinks)
      .set({ suspendedByPolicy: kind })
      .where(and(isNull(pageShareLinks.suspendedByPolicy), eq(pageShareLinks.isActive, true), notNow(pageShareLinks.expiresAt), inArray(pageShareLinks.pageId, orgPageIds(executor, orgId))))
      .returning({ id: pageShareLinks.id, pageId: pageShareLinks.pageId });
    const pageDrives = await driveIdsOfPages(executor, pageLinks.map((r) => r.pageId));
    return {
      suspended: [
        ...drivesLinks.map(item('drive_share_link')),
        ...pageLinks.map((r) => ({ kind, resourceType: 'page_share_link' as const, id: r.id, driveId: pageDrives.get(r.pageId) ?? '' })),
      ],
      restored: [],
    };
  }
  const drivesLinks = await executor
    .update(driveShareLinks)
    .set({ suspendedByPolicy: null })
    .where(and(eq(driveShareLinks.suspendedByPolicy, kind), inArray(driveShareLinks.driveId, orgDriveIds(executor, orgId))))
    .returning({ id: driveShareLinks.id, driveId: driveShareLinks.driveId });
  const pageLinks = await executor
    .update(pageShareLinks)
    .set({ suspendedByPolicy: null })
    .where(and(eq(pageShareLinks.suspendedByPolicy, kind), inArray(pageShareLinks.pageId, orgPageIds(executor, orgId))))
    .returning({ id: pageShareLinks.id, pageId: pageShareLinks.pageId });
  const pageDrives = await driveIdsOfPages(executor, pageLinks.map((r) => r.pageId));
  return {
    suspended: [],
    restored: [
      ...drivesLinks.map(item('drive_share_link')),
      ...pageLinks.map((r) => ({ kind, resourceType: 'page_share_link' as const, id: r.id, driveId: pageDrives.get(r.pageId) ?? '' })),
    ],
  };
}

const IN_CHUNK = 500;

async function driveIdsOfPages(executor: Executor, pageIds: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for (let i = 0; i < pageIds.length; i += IN_CHUNK) {
    const rows = await executor
      .select({ id: pages.id, driveId: pages.driveId })
      .from(pages)
      .where(inArray(pages.id, pageIds.slice(i, i + IN_CHUNK)));
    for (const r of rows) out.set(r.id, r.driveId);
  }
  return out;
}

async function reconcilePublishedPages(executor: Executor, orgId: string, forbidden: boolean): Promise<SuspensionOutcome> {
  const kind: SuspensionKind = 'publishedPages';
  const scope = inArray(publishedPages.driveId, orgDriveIds(executor, orgId));
  const shape = (r: { id: string; driveId: string }): PolicySuspensionItem => ({ kind, resourceType: 'published_page', id: r.id, driveId: r.driveId });
  if (forbidden) {
    const rows = await executor.update(publishedPages).set({ suspendedByPolicy: kind }).where(and(isNull(publishedPages.suspendedByPolicy), scope)).returning({ id: publishedPages.id, driveId: publishedPages.driveId });
    return { suspended: rows.map(shape), restored: [] };
  }
  const rows = await executor.update(publishedPages).set({ suspendedByPolicy: null }).where(and(eq(publishedPages.suspendedByPolicy, kind), scope)).returning({ id: publishedPages.id, driveId: publishedPages.driveId });
  return { suspended: [], restored: rows.map(shape) };
}

async function reconcileCustomDomains(executor: Executor, orgId: string, forbidden: boolean): Promise<SuspensionOutcome> {
  const kind: SuspensionKind = 'customDomains';
  const scope = inArray(customDomains.driveId, orgDriveIds(executor, orgId));
  const shape = (r: { id: string; driveId: string }): PolicySuspensionItem => ({ kind, resourceType: 'custom_domain', id: r.id, driveId: r.driveId });
  if (forbidden) {
    // Platform-owned aliases are the platform's, not the org's: the org's policy does not reach them.
    const rows = await executor
      .update(customDomains)
      .set({ suspendedByPolicy: kind })
      .where(and(isNull(customDomains.suspendedByPolicy), eq(customDomains.platformOwned, false), scope))
      .returning({ id: customDomains.id, driveId: customDomains.driveId });
    return { suspended: rows.map(shape), restored: [] };
  }
  const rows = await executor.update(customDomains).set({ suspendedByPolicy: null }).where(and(eq(customDomains.suspendedByPolicy, kind), scope)).returning({ id: customDomains.id, driveId: customDomains.driveId });
  return { suspended: [], restored: rows.map(shape) };
}

async function reconcileIntegrations(executor: Executor, orgId: string, restrictTo: string[] | null): Promise<SuspensionOutcome> {
  const kind: SuspensionKind = 'integrations';
  const scope = inArray(integrationConnections.driveId, orgDriveIds(executor, orgId));
  const shape = (r: { id: string; driveId: string | null }): PolicySuspensionItem => ({ kind, resourceType: 'integration_connection', id: r.id, driveId: r.driveId ?? '' });
  const out: SuspensionOutcome = { suspended: [], restored: [] };
  if (restrictTo !== null) {
    const rows = await executor
      .update(integrationConnections)
      .set({ suspendedByPolicy: kind })
      .where(and(isNull(integrationConnections.suspendedByPolicy), isNotNull(integrationConnections.driveId), scope, inArray(integrationConnections.providerId, disallowedProviderIds(executor, restrictTo))))
      .returning({ id: integrationConnections.id, driveId: integrationConnections.driveId });
    out.suspended = rows.map(shape);
  }
  // Restore what is marked and is now allowed: everything when there is no restriction, else the
  // connections whose provider the allowlist now names.
  const allowedNow =
    restrictTo === null
      ? undefined
      : notInArray(integrationConnections.providerId, disallowedProviderIds(executor, restrictTo));
  const restored = await executor
    .update(integrationConnections)
    .set({ suspendedByPolicy: null })
    .where(and(eq(integrationConnections.suspendedByPolicy, kind), scope, allowedNow))
    .returning({ id: integrationConnections.id, driveId: integrationConnections.driveId });
  out.restored = restored.map(shape);
  return out;
}

/**
 * Reconcile the named kinds against `policies`. Call inside the transaction that stored the policies, so
 * a policy and its suspensions commit together or not at all.
 */
export async function applySuspension(executor: Executor, orgId: string, policies: OrgPolicies, kinds: readonly SuspensionKind[]): Promise<SuspensionOutcome> {
  const targets = suspensionTargets(policies);
  const outcome: SuspensionOutcome = { suspended: [], restored: [] };
  const add = (part: SuspensionOutcome) => {
    outcome.suspended.push(...part.suspended);
    outcome.restored.push(...part.restored);
  };
  for (const kind of kinds) {
    switch (kind) {
      case 'publicShareLinks':
        add(await reconcileShareLinks(executor, orgId, targets.publicShareLinks));
        break;
      case 'publishedPages':
        add(await reconcilePublishedPages(executor, orgId, targets.publishedPages));
        break;
      case 'customDomains':
        add(await reconcileCustomDomains(executor, orgId, targets.customDomains));
        break;
      case 'integrations':
        add(await reconcileIntegrations(executor, orgId, targets.integrations.restrictTo));
        break;
      case 'guests': {
        const toGuest = (r: { memberRowId: string; driveId: string; userId: string }): PolicySuspensionItem => ({ kind: 'guests', resourceType: 'drive_member', id: r.memberRowId, driveId: r.driveId, userId: r.userId });
        if (targets.guests) add({ suspended: (await suspendOrgGuests(executor, orgId)).map(toGuest), restored: [] });
        else add({ suspended: [], restored: (await restoreOrgGuests(executor, orgId)).map(toGuest) });
        break;
      }
    }
  }
  return outcome ?? EMPTY;
}

/** Everything currently suspended by policy in the org, bounded per kind. */
export interface SuspendedListing {
  kind: SuspensionKind;
  resourceType: SuspendedResourceType;
  total: number;
  items: PolicySuspensionItem[];
}

export const SUSPENSION_LIST_LIMIT = 200;

async function listTable<T extends { id: string; driveId: string | null }>(
  kind: SuspensionKind,
  resourceType: SuspendedResourceType,
  total: Promise<number>,
  items: Promise<T[]>,
): Promise<SuspendedListing> {
  const [t, rows] = await Promise.all([total, items]);
  return { kind, resourceType, total: t, items: rows.map((r) => ({ kind, resourceType, id: r.id, driveId: r.driveId ?? '' })) };
}

const countOf = async (q: Promise<{ n: number }[]>): Promise<number> => (await q)[0]?.n ?? 0;
const n = sql<number>`count(*)::int`;

/** The suspended rows the org's policies are holding, for the list endpoint and the audit trail. */
export async function listPolicySuspensions(orgId: string, limit: number = SUSPENSION_LIST_LIMIT, executor: Executor = db): Promise<SuspendedListing[]> {
  const kinds = (kind: SuspensionKind) => ({ kind });
  void kinds;
  const dl = and(eq(driveShareLinks.suspendedByPolicy, 'publicShareLinks'), inArray(driveShareLinks.driveId, orgDriveIds(executor, orgId)));
  const pl = and(eq(pageShareLinks.suspendedByPolicy, 'publicShareLinks'), inArray(pageShareLinks.pageId, orgPageIds(executor, orgId)));
  const pp = and(eq(publishedPages.suspendedByPolicy, 'publishedPages'), inArray(publishedPages.driveId, orgDriveIds(executor, orgId)));
  const cd = and(eq(customDomains.suspendedByPolicy, 'customDomains'), inArray(customDomains.driveId, orgDriveIds(executor, orgId)));
  const ic = and(eq(integrationConnections.suspendedByPolicy, 'integrations'), inArray(integrationConnections.driveId, orgDriveIds(executor, orgId)));

  const pageLinkRows = await executor.select({ id: pageShareLinks.id, pageId: pageShareLinks.pageId }).from(pageShareLinks).where(pl).orderBy(pageShareLinks.id).limit(limit);
  const pageDrives = await driveIdsOfPages(executor, pageLinkRows.map((r) => r.pageId));

  const guests = await listSuspendedOrgGuests(orgId, limit, executor);
  return Promise.all([
    listTable('publicShareLinks', 'drive_share_link', countOf(executor.select({ n }).from(driveShareLinks).where(dl)), executor.select({ id: driveShareLinks.id, driveId: driveShareLinks.driveId }).from(driveShareLinks).where(dl).orderBy(driveShareLinks.id).limit(limit)),
    Promise.resolve<SuspendedListing>({
      kind: 'publicShareLinks',
      resourceType: 'page_share_link',
      total: await countOf(executor.select({ n }).from(pageShareLinks).where(pl)),
      items: pageLinkRows.map((r) => ({ kind: 'publicShareLinks', resourceType: 'page_share_link', id: r.id, driveId: pageDrives.get(r.pageId) ?? '' })),
    }),
    listTable('publishedPages', 'published_page', countOf(executor.select({ n }).from(publishedPages).where(pp)), executor.select({ id: publishedPages.id, driveId: publishedPages.driveId }).from(publishedPages).where(pp).orderBy(publishedPages.id).limit(limit)),
    listTable('customDomains', 'custom_domain', countOf(executor.select({ n }).from(customDomains).where(cd)), executor.select({ id: customDomains.id, driveId: customDomains.driveId }).from(customDomains).where(cd).orderBy(customDomains.id).limit(limit)),
    listTable('integrations', 'integration_connection', countOf(executor.select({ n }).from(integrationConnections).where(ic)), executor.select({ id: integrationConnections.id, driveId: integrationConnections.driveId }).from(integrationConnections).where(ic).orderBy(integrationConnections.id).limit(limit)),
    Promise.resolve<SuspendedListing>({
      kind: 'guests',
      resourceType: 'drive_member',
      total: guests.total,
      items: guests.items.map((g) => ({ kind: 'guests', resourceType: 'drive_member', id: g.memberRowId, driveId: g.driveId, userId: g.userId })),
    }),
  ]);
}
