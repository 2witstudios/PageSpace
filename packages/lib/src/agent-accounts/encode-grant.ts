/**
 * `encodeGrant` — the canonical bytes the issuer signs and the verifier
 * checks (ADR 0004 §2.2). A fixed key order with no whitespace, REBUILT from
 * the typed grant rather than serialized from whatever object the caller
 * held, so insertion order can never change the signed message and nothing
 * beside the frozen fields can ride into it. The order is the field order of
 * `AgentAccountGrant` in `grant.ts`.
 *
 * Pure: no crypto, no I/O.
 */
import type { AgentAccountGrant } from './grant';

export function encodeGrant(grant: AgentAccountGrant): Uint8Array {
  const canonical = {
    grantId: grant.grantId,
    iss: grant.iss,
    aud: grant.aud,
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
    accountId: grant.accountId,
    accountKind: grant.accountKind,
    credentialVersion: grant.credentialVersion,
    policyVersion: grant.policyVersion,
    bindingDigest: grant.bindingDigest,
    operation: { class: grant.operation.class, name: grant.operation.name },
    requestDigest: grant.requestDigest,
    sessionHttp: grant.sessionHttp,
    approvalId: grant.approvalId,
    iat: grant.iat,
    nbf: grant.nbf,
    exp: grant.exp,
    nonce: grant.nonce,
    presenter: { keyId: grant.presenter.keyId, channel: grant.presenter.channel },
  };
  return new TextEncoder().encode(JSON.stringify(canonical));
}
