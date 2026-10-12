/**
 * The ONE org policy reader (Spec POL-1) — the read half only, so a hot path (the credit gate) can ask
 * for a policy without importing the writer, the suspension machinery or the audit chain.
 *
 * No caching, by design: every call reads the row, so a change applies immediately in every process.
 */
import { db } from '@pagespace/db/db';
import { asc, eq, inArray, or, sql } from '@pagespace/db/operators';
import { drives, pages } from '@pagespace/db/schema/core';
import { organizations } from '@pagespace/db/schema/organizations';
import type { SpendPolicy } from '../billing/wallet-core';
import { orgPolicySpendPolicy, parseOrgPolicies, type OpenRoleFloor, type OrgPolicies } from './policies-core';
import type { OrgAuthenticationPolicy } from './authentication-policy-core';

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
type Executor = typeof db | Tx;

/**
 * The org's policies with a default for every key. An org that does not exist reads as the defaults:
 * callers establish that the org exists (and that the caller may act in it) before they ask.
 */
export async function getOrgPolicies(orgId: string, executor: Executor = db, options: ReadLock = {}): Promise<OrgPolicies> {
  const query = executor.select({ policies: organizations.policies }).from(organizations).where(eq(organizations.id, orgId));
  const [row] = await (options.forShare ? query.for('share') : query).limit(1);
  return parseOrgPolicies(row?.policies);
}

/**
 * `forShare` (inside a transaction only): hold the org row FOR SHARE until the caller commits. The policy writer
 * takes the row FOR UPDATE, so a decision made under this lock and the write it guards serialize with a policy
 * change: either the write commits first and the change's suspension sees it, or the decision sees the new policy.
 */
export interface ReadLock {
  forShare?: boolean;
}

/**
 * POL-6: each org's Open-drive role floor, for the implicit-membership resolver, which may resolve many drives (of
 * many orgs) at once: one read per chunk of orgs, never one per drive or page. Every id asked for gets an answer,
 * parsed as getOrgPolicies parses it (unset: the default, damaged: view, the value that adds nothing).
 */
export async function getOpenDriveRoleFloors(orgIds: readonly string[], executor: Executor = db): Promise<Map<string, OpenRoleFloor>> {
  const unique = [...new Set(orgIds)];
  const stored = new Map<string, unknown>();
  for (let i = 0; i < unique.length; i += ORG_ID_CHUNK) {
    const rows = await executor
      .select({ id: organizations.id, policies: organizations.policies })
      .from(organizations)
      .where(inArray(organizations.id, unique.slice(i, i + ORG_ID_CHUNK)));
    for (const row of rows) stored.set(row.id, row.policies);
  }
  return new Map(unique.map((orgId) => [orgId, parseOrgPolicies(stored.get(orgId)).openDriveRoleFloor]));
}

/** Chunk size for org id IN lists (Postgres bind parameter limit). */
const ORG_ID_CHUNK = 500;

/**
 * The orgs whose STORED policies set any of these keys, each with its parsed policies. A narrowing for sweeps
 * (an org that never set the key is at the default and needs no work); the parse, not the stored shape, decides
 * what the value is. The only place, besides the writer's locked read, that touches the column.
 */
export async function listOrgsSettingPolicyKeys(keys: readonly string[], executor: Executor = db): Promise<Array<{ orgId: string; policies: OrgPolicies }>> {
  if (keys.length === 0) return [];
  const rows = await executor
    .select({ id: organizations.id, policies: organizations.policies })
    .from(organizations)
    .where(or(...keys.map((key) => sql`${organizations.policies} ? ${key}`)));
  return rows.map((r) => ({ orgId: r.id, policies: parseOrgPolicies(r.policies) }));
}

/**
 * The org's spend policy for the credit gate (POL-7): the seat allowance amount and the wallet fallback
 * rule. With no stored policy this is the default allowance and `refuse` — never unlimited: the amount is
 * always a whole non-negative number of cents.
 */
export async function readOrgSpendPolicy(executor: Executor, orgId: string): Promise<SpendPolicy & { seatAllowanceCents: number }> {
  const policies = await getOrgPolicies(orgId, executor);
  return { ...orgPolicySpendPolicy(policies), seatAllowanceCents: policies.seatAllowanceCents };
}

/**
 * The policies that govern what happens INSIDE a drive, read at the moment of the decision: the drive's org and
 * that org's policies, or null when the drive has no org (a personal drive, which no org policy restricts) or
 * does not exist (the caller's own not-found handling stands).
 */
export async function getDrivePolicies(driveId: string, executor: Executor = db, options: ReadLock = {}): Promise<{ orgId: string; policies: OrgPolicies } | null> {
  const [drive] = await executor.select({ orgId: drives.orgId }).from(drives).where(eq(drives.id, driveId)).limit(1);
  if (!drive?.orgId) return null;
  return { orgId: drive.orgId, policies: await getOrgPolicies(drive.orgId, executor, options) };
}

/**
 * Hold, FOR SHARE and in id order, the org rows of every drive (and every page's drive) a multi-step write will touch,
 * before it writes anything (re-verify N6). A rollback-to-point or AI undo replays many activities in one
 * transaction, and each re-entering grant asks the guests policy under the org share lock; taking that lock only
 * after earlier steps wrote can deadlock with a policy change (org FOR UPDATE, then its suspension). Taken first,
 * the two simply queue.
 */
export async function lockOrgsOfDrivesForShare(executor: Tx, input: { driveIds: Array<string | null | undefined>; pageIds: Array<string | null | undefined> }): Promise<void> {
  const driveIds = new Set(input.driveIds.filter((d): d is string => typeof d === 'string'));
  const pageIds = [...new Set(input.pageIds.filter((p): p is string => typeof p === 'string'))];
  if (pageIds.length > 0) {
    for (const row of await executor.select({ driveId: pages.driveId }).from(pages).where(inArray(pages.id, pageIds))) driveIds.add(row.driveId);
  }
  if (driveIds.size === 0) return;
  const orgIds = [...new Set((await executor.select({ orgId: drives.orgId }).from(drives).where(inArray(drives.id, [...driveIds]))).flatMap((d) => (d.orgId ? [d.orgId] : [])))].sort();
  if (orgIds.length === 0) return;
  await executor.select({ id: organizations.id }).from(organizations).where(inArray(organizations.id, orgIds)).orderBy(asc(organizations.id)).for('share');
}

/**
 * SEC-2/3: the sign-in policy governing each drive, for many drives in one read per chunk: null for a drive no org
 * governs (a personal drive) and for an id that is no drive (the caller's own not-found handling stands). Every id
 * asked for gets an answer. The keys parse as getOrgPolicies parses them, so a damaged value reads as its strictest.
 */
export async function getDriveAuthenticationPolicies(
  driveIds: readonly string[],
  executor: Executor = db,
): Promise<Map<string, OrgAuthenticationPolicy | null>> {
  const unique = [...new Set(driveIds)];
  const out = new Map<string, OrgAuthenticationPolicy | null>(unique.map((id) => [id, null]));
  for (let i = 0; i < unique.length; i += ORG_ID_CHUNK) {
    const rows = await executor
      .select({ driveId: drives.id, orgId: drives.orgId, policies: organizations.policies })
      .from(drives)
      .leftJoin(organizations, eq(organizations.id, drives.orgId))
      .where(inArray(drives.id, unique.slice(i, i + ORG_ID_CHUNK)));
    for (const row of rows) {
      if (!row.orgId) continue;
      const { requireStrongSignIn, maximumSessionAgeMinutes } = parseOrgPolicies(row.policies);
      out.set(row.driveId, { requireStrongSignIn, maximumSessionAgeMinutes });
    }
  }
  return out;
}

/**
 * The drive each permission resource lives in: a page's drive, or the id itself when it is no page (the permission
 * APIs accept a drive id as the root resource). One read per chunk.
 */
export async function getResourceDriveIds(resourceIds: readonly string[], executor: Executor = db): Promise<Map<string, string>> {
  const unique = [...new Set(resourceIds)];
  const out = new Map<string, string>(unique.map((id) => [id, id]));
  for (let i = 0; i < unique.length; i += ORG_ID_CHUNK) {
    const rows = await executor
      .select({ id: pages.id, driveId: pages.driveId })
      .from(pages)
      .where(inArray(pages.id, unique.slice(i, i + ORG_ID_CHUNK)));
    for (const row of rows) out.set(row.id, row.driveId);
  }
  return out;
}
