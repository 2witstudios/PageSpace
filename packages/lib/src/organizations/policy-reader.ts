/**
 * The ONE org policy reader (Spec POL-1) — the read half only, so a hot path (the credit gate) can ask
 * for a policy without importing the writer, the suspension machinery or the audit chain.
 *
 * No caching, by design: every call reads the row, so a change applies immediately in every process.
 */
import { db } from '@pagespace/db/db';
import { eq, or, sql } from '@pagespace/db/operators';
import { drives } from '@pagespace/db/schema/core';
import { organizations } from '@pagespace/db/schema/organizations';
import type { SpendPolicy } from '../billing/wallet-core';
import { orgPolicySpendPolicy, parseOrgPolicies, type OrgPolicies } from './policies-core';

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
type Executor = typeof db | Tx;

/**
 * The org's policies with a default for every key. An org that does not exist reads as the defaults:
 * callers establish that the org exists (and that the caller may act in it) before they ask.
 */
export async function getOrgPolicies(orgId: string, executor: Executor = db): Promise<OrgPolicies> {
  const [row] = await executor.select({ policies: organizations.policies }).from(organizations).where(eq(organizations.id, orgId)).limit(1);
  return parseOrgPolicies(row?.policies);
}

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
export async function getDrivePolicies(driveId: string, executor: Executor = db): Promise<{ orgId: string; policies: OrgPolicies } | null> {
  const [drive] = await executor.select({ orgId: drives.orgId }).from(drives).where(eq(drives.id, driveId)).limit(1);
  if (!drive?.orgId) return null;
  return { orgId: drive.orgId, policies: await getOrgPolicies(drive.orgId, executor) };
}
