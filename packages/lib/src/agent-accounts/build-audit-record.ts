/**
 * `buildAuditRecord` — the audit row for one credentialed operation (ADR
 * 0004 §5; Control Board §1 "Audit record shape").
 *
 * What it carries: every principal by id, the account and its versions, the
 * policy and approval ids, the presenter, the request DIGEST, and a
 * normalized action. What it never carries: a raw credential, a request or
 * response body, any header VALUE (only header NAMES, and only the ones the
 * canonical projection already admitted), the URL PATH, or a resource key the
 * operation did not declare. The body and the path are provable without being
 * stored, because `bodySha256` and `pathDigest` are part of the projection.
 *
 * The record is REBUILT field by field from the typed grant and canonical
 * request, so nothing outside the frozen shape can reach the row even if a
 * caller hands in an object carrying more. That is what makes the property
 * test in `__tests__/audit.test.ts` — random bodies, random secrets, the
 * serialized record never contains either — an actual guarantee rather than
 * a spot check.
 *
 * Pure: the clock is a parameter.
 */
import type { AgentAccountAuditRecord, BuildAuditRecord, NormalizedAction } from './audit';
import type { CanonicalRequest } from './canonical-request';
import type { HashBytes } from './grant';

function normalize(canonical: CanonicalRequest, hash: HashBytes, auditResourceKeys: readonly string[]): NormalizedAction {
  const allowed = new Set(auditResourceKeys);
  return {
    channel: canonical.channel,
    method: canonical.method,
    origin: canonical.origin,
    // The path is DIGESTED, never stored: plenty of real APIs carry a
    // credential in the URL, and this chain cannot be erased afterwards.
    // The digest still correlates every row for the same endpoint.
    pathDigest: hash(new TextEncoder().encode(canonical.path)),
    headerNames: canonical.headers.map(([name]) => name),
    bodySha256: canonical.bodySha256,
    // Only the keys the registry entry ALLOWLISTS for audit (G1c R6), empty by
    // default: a slot that can carry a secret is simply never listed. The
    // projection belongs to the reviewed catalogue, not to whoever built the
    // request.
    resourceIds: canonical.resources.filter(([key]) => allowed.has(key)).map(([key, value]) => [key, value] as const),
    operation: { class: canonical.operation.class, name: canonical.operation.name },
  };
}

export const buildAuditRecord: BuildAuditRecord = ({ grant, canonical, outcome, at, hash, auditResourceKeys }): AgentAccountAuditRecord => ({
  grantId: grant.grantId,
  principal: {
    tenantId: grant.tenantId,
    human: { userId: grant.human.userId, sessionId: grant.human.sessionId },
    delegationId: grant.delegationId,
    agentPageId: grant.agentPageId,
    conversationId: grant.conversationId,
    runId: grant.runId,
    sandbox:
      grant.sandbox === null
        ? null
        : { spriteName: grant.sandbox.spriteName, instanceId: grant.sandbox.instanceId, generation: grant.sandbox.generation },
    callerCeiling: {
      allowedDriveIds: [...grant.callerCeiling.allowedDriveIds],
      originatingMcpTokenId: grant.callerCeiling.originatingMcpTokenId,
    },
  },
  accountId: grant.accountId,
  accountKind: grant.accountKind,
  credentialVersion: grant.credentialVersion,
  policyVersion: grant.policyVersion,
  approvalId: grant.approvalId,
  requestDigest: grant.requestDigest,
  normalizedAction: normalize(canonical, hash, auditResourceKeys),
  presenter: { keyId: grant.presenter.keyId, channel: grant.presenter.channel },
  outcome,
  at,
});
