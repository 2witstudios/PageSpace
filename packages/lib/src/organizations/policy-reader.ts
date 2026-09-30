/**
 * The ONE org policy reader (Spec POL-1) — the read half only, so a hot path (the credit gate) can ask
 * for a policy without importing the writer, the suspension machinery or the audit chain.
 *
 * No caching, by design: every call reads the row, so a change applies immediately in every process.
 */
import { db } from '@pagespace/db/db';
import { eq } from '@pagespace/db/operators';
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
 * The org's spend policy for the credit gate (POL-7): the seat allowance amount and the wallet fallback
 * rule. With no stored policy this is the default allowance and `refuse` — never unlimited: the amount is
 * always a whole non-negative number of cents.
 */
export async function readOrgSpendPolicy(executor: Executor, orgId: string): Promise<SpendPolicy & { seatAllowanceCents: number }> {
  const policies = await getOrgPolicies(orgId, executor);
  return { ...orgPolicySpendPolicy(policies), seatAllowanceCents: policies.seatAllowanceCents };
}
