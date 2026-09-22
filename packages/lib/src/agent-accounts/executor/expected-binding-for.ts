/**
 * `expectedBindingFor` — the facts the HTTP executor hands `verifyGrant`
 * (ADR 0004 §2.1 "What the verifier compares against"; L2·G2). Pure.
 *
 * Three sources, each used only for what it can attest:
 * - the RUN envelope: the principals of the run being served (human, agent
 *   page, conversation, run) — a grant issued for another run is
 *   `principal_mismatch`;
 * - the MAIN-DB row: status, drive, current policy version — facts compared
 *   against the signed grant, never plane state;
 * - the PLANE's record: current and previous credential version, rotation
 *   time, revocation — plane-attested (G1c R3/M7). A revocation the plane
 *   records makes the account `revoked` whatever the main-DB row says.
 * An account missing from either side is an `UnknownAccountBinding`.
 * The ceiling is evaluated over the grant's OWN signed `allowedDriveIds`.
 */
import type { AgentAccountRecord, CredentialVersion, PolicyVersion, TenantId } from '@pagespace/db/schema/agent-accounts';
import type { AccountId } from '@pagespace/db/schema/agent-accounts';
import type { AgentPageId, ConversationId, DriveId, ExpectedBinding, GrantHuman, GrantPresenter, RunId } from '../grant';
import { isDriveWithinCredentialScope } from '../../agent-workspaces/credential-scope';

export type RunEnvelope = {
  readonly human: GrantHuman;
  readonly agentPageId: AgentPageId | null;
  readonly conversationId: ConversationId;
  readonly runId: RunId;
};

export type PlaneAttestedFacts = {
  readonly version: CredentialVersion;
  readonly previousVersion: CredentialVersion | null;
  readonly rotatedAt: number | null;
  readonly revokedAt: number | null;
};

export function expectedBindingFor({
  run,
  presenter,
  row,
  plane,
  allowedDriveIds,
}: {
  readonly run: RunEnvelope;
  readonly presenter: GrantPresenter & { readonly channel: 'http-executor' };
  readonly row: Pick<AgentAccountRecord, 'id' | 'kind' | 'status' | 'ownerDriveId' | 'tenantId' | 'policyVersion'> | null;
  readonly plane: PlaneAttestedFacts | null;
  readonly allowedDriveIds: readonly string[];
}): ExpectedBinding<'http-executor'> {
  const accountDriveId = (row?.ownerDriveId ?? null) as DriveId | null;
  const runBinding = {
    aud: 'http-executor' as const,
    presenter,
    human: run.human,
    agentPageId: run.agentPageId,
    conversationId: run.conversationId,
    runId: run.runId,
    tenantId: (row?.tenantId ?? '') as TenantId,
    delegation: run.human.sessionId !== null ? ({ kind: 'live_session' } as const) : ({ kind: 'none' } as const),
    sandbox: null,
    ceilingAdmitsAccount: isDriveWithinCredentialScope(allowedDriveIds, accountDriveId),
  };
  if (row === null || plane === null) {
    return {
      ...runBinding,
      accountId: null,
      accountKind: null,
      accountStatus: null,
      accountDriveId: null,
      currentCredentialVersion: null,
      previousCredentialVersion: null,
      rotatedAt: null,
      currentPolicyVersion: null,
    };
  }
  return {
    ...runBinding,
    accountId: row.id as AccountId,
    accountKind: row.kind,
    accountStatus: plane.revokedAt !== null ? 'revoked' : row.status,
    accountDriveId,
    currentCredentialVersion: plane.version,
    previousCredentialVersion: plane.previousVersion,
    rotatedAt: plane.rotatedAt,
    currentPolicyVersion: row.policyVersion as PolicyVersion,
  };
}
