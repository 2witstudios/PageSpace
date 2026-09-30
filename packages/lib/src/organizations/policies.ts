/**
 * The org policy store and its ONE reader (Spec POL-1). IO only: what a policy may hold and what a
 * change forbids are decided in policies-core.ts.
 *
 * No route reads the organizations row for policy (seam: policy-reads.seam.test.ts). Callers ask
 * getOrgPolicies at the moment of the decision, every time: there is deliberately no module-level cache,
 * so a change applies immediately and in every process (Spec POL-1, leaf E3 "no restart").
 */
import { db } from '@pagespace/db/db';
import { eq } from '@pagespace/db/operators';
import { organizations, type SuspensionKind } from '@pagespace/db/schema/organizations';
import { recordOrgAuditEvent } from '../audit/org-audit';
import { loggers } from '../logging/logger-config';
import {
  mergeOrgPolicies,
  ORG_POLICY_KEYS,
  parseOrgPolicies,
  suspensionKindsChanged,
  type OrgPolicies,
  type OrgPoliciesPatch,
  type OrgPolicyKey,
} from './policies-core';
import { getOrgPolicies } from './policy-reader';
import { applySuspension, type PolicySuspensionItem } from './policy-suspension';

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
type Executor = typeof db | Tx;

export { getOrgPolicies };

export interface PolicyChange {
  key: OrgPolicyKey;
  from: unknown;
  to: unknown;
}

export type UpdateOrgPoliciesResult =
  | {
      ok: true;
      policies: OrgPolicies;
      changes: PolicyChange[];
      suspended: PolicySuspensionItem[];
      restored: PolicySuspensionItem[];
      /** False when the change committed but the audit chain rejected an append; the caller must surface it. */
      auditRecorded: boolean;
    }
  | { ok: false; reason: 'not_found' };

const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

/** Ids listed inline on an audit row; the full set is always available from the list endpoint. */
export const AUDIT_LISTED_IDS = 200;

function countsByKind(items: readonly PolicySuspensionItem[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const item of items) out[item.kind] = (out[item.kind] ?? 0) + 1;
  return out;
}

/**
 * Apply a validated patch. The row lock, the stored policies and every suspension or restore commit in
 * ONE transaction, so there is no moment where the policy says off and an existing link is still live
 * for lack of a marker. The audit rows are written after commit (the audit chain is a different store).
 */
export async function updateOrgPolicies(input: { orgId: string; actorId: string; patch: OrgPoliciesPatch }): Promise<UpdateOrgPoliciesResult> {
  const { orgId, actorId, patch } = input;
  const done = await db.transaction(async (tx) => {
    const [row] = await tx.select({ policies: organizations.policies }).from(organizations).where(eq(organizations.id, orgId)).for('update').limit(1);
    if (!row) return null;
    const before = parseOrgPolicies(row.policies);
    const stored = mergeOrgPolicies(row.policies, patch);
    const after = parseOrgPolicies(stored);
    const kinds = suspensionKindsChanged(before, after);
    const outcome = await applySuspension(tx, orgId, after, kinds);
    await tx.update(organizations).set({ policies: stored }).where(eq(organizations.id, orgId));
    const changes: PolicyChange[] = ORG_POLICY_KEYS.filter((k) => !same(before[k], after[k])).map((key) => ({ key, from: before[key], to: after[key] }));
    return { after, changes, outcome };
  });
  if (!done) return { ok: false, reason: 'not_found' };

  const { after, changes, outcome } = done;
  let auditRecorded = true;
  if (changes.length > 0) {
    try {
      await recordOrgAuditEvent({
        orgId,
        eventType: 'org.policy.changed',
        actorId,
        resourceType: 'organization',
        resourceId: orgId,
        details: { changes: changes.map((c) => ({ key: c.key, from: c.from, to: c.to })) },
      });
      for (const [eventType, items] of [['org.policy.suspended', outcome.suspended], ['org.policy.restored', outcome.restored]] as const) {
        if (items.length === 0) continue;
        await recordOrgAuditEvent({
          orgId,
          eventType,
          actorId,
          resourceType: 'organization',
          resourceId: orgId,
          details: {
            counts: countsByKind(items),
            total: items.length,
            listed: items.slice(0, AUDIT_LISTED_IDS).map((i) => ({ kind: i.kind, type: i.resourceType, id: i.id, driveId: i.driveId })),
            truncated: items.length > AUDIT_LISTED_IDS,
          },
        });
      }
    } catch (error) {
      auditRecorded = false;
      loggers.security.error('Org policy change committed but its audit event was not recorded', error as Error, { orgId });
    }
  }
  return { ok: true, policies: after, changes, suspended: outcome.suspended, restored: outcome.restored, auditRecorded };
}

export type { SuspensionKind };
