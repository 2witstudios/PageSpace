/**
 * `planeBindingsFor` — the `PlaneScope` and `PlaneBindings` an account
 * reference row stands for (ADR 0005 §2.2, §2.4). The ingress `put` pins
 * exactly this record in the plane, and the authority signs
 * `digestBindings(bindings)` into every grant, so both derive it here — one
 * function, or every grant would be `binding_mismatch`.
 *
 * Bound agent pages: the owner page of an agent-page-owned account, plus the
 * unrevoked `agent_account_bindings` the repository read. NOTE (review LOW-6):
 * no G2 path creates a binding; whatever later does MUST write the new scope
 * to the plane through `rebind`, or every grant for that account is
 * `binding_mismatch` at resolve; deduplicated and
 * sorted (the plane digest sorts them too, but the record is stored as
 * built). The approval policy is taken VERBATIM from the row — the plane
 * digests the stored bytes, so any normalization here would diverge. Pure.
 */
import type { AccountOwnerRef, AgentAccountRecord } from '@pagespace/db/schema/agent-accounts';
import type { AgentPageId, HashBytes } from './grant';
import type { AccountApprovalPolicy } from './approval';
import type { CanonicalOrigin, ResourceRestrictions } from './canonical-request';
import type { PlaneBindings, PlaneScope } from './store/store-adapter';
import type { PolicyVersion, TenantId } from '@pagespace/db/schema/agent-accounts';
import { digestPlaneScope } from './store/digest-plane-scope';

export type PlaneBindingsForRow = Pick<
  AgentAccountRecord,
  | 'kind'
  | 'ownerKind'
  | 'ownerUserId'
  | 'ownerAgentPageId'
  | 'ownerDriveId'
  | 'tenantId'
  | 'providerSlug'
  | 'allowedOrigins'
  | 'auxiliaryOrigins'
  | 'resourceRestrictions'
  | 'approvalPolicy'
  | 'policyVersion'
  | 'sessionHttpEnabled'
>;

const sortedUnique = <T extends string>(values: readonly T[]): T[] => [...new Set(values)].sort();

export function ownerRefOf(row: Pick<AgentAccountRecord, 'ownerKind' | 'ownerUserId' | 'ownerAgentPageId' | 'ownerDriveId'>): AccountOwnerRef {
  return row.ownerKind === 'user'
    ? { kind: 'user', userId: row.ownerUserId ?? '' }
    : { kind: 'agent_page', agentPageId: row.ownerAgentPageId ?? '', driveId: row.ownerDriveId ?? '' };
}

export function planeBindingsFor({
  row,
  boundAgentPageIds,
  hash,
}: {
  readonly row: PlaneBindingsForRow;
  readonly boundAgentPageIds: readonly AgentPageId[];
  readonly hash: HashBytes;
}): { readonly scope: PlaneScope; readonly bindings: PlaneBindings } {
  const ownerPage = row.ownerKind === 'agent_page' && row.ownerAgentPageId !== null ? [row.ownerAgentPageId as AgentPageId] : [];
  const allowedOrigins = sortedUnique(row.allowedOrigins as CanonicalOrigin[]);
  const scope: PlaneScope = {
    approvalPolicy: (row.approvalPolicy ?? null) as AccountApprovalPolicy | null,
    resourceRestrictions: row.resourceRestrictions as ResourceRestrictions,
    boundAgentPageIds: sortedUnique([...ownerPage, ...boundAgentPageIds]),
    allowedOrigins,
    auxiliaryOrigins: sortedUnique(row.auxiliaryOrigins as CanonicalOrigin[]),
    sessionHttpEnabled: row.sessionHttpEnabled,
    providerSlug: row.providerSlug,
  };
  const bindings: PlaneBindings = {
    tenantId: row.tenantId as TenantId,
    ownerRef: ownerRefOf(row),
    allowedOrigins,
    policyVersion: row.policyVersion as PolicyVersion,
    policyDigest: digestPlaneScope({ scope, hash }),
    kind: row.kind,
  };
  return { scope, bindings };
}
