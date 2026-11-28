/**
 * `refreshPresentation` — the grant the plane hands its OWN refresh worker
 * when an `oauth2` request needs fresh access material (slice 3; ADR 0005
 * §10d). Pure.
 *
 * The open G3 ruling ("who issues the refresh-worker grant") is settled here:
 * the plane does, in-process, and only on a path that has already verified
 * an authority-signed `http-executor` grant for the same account. The refresh
 * worker and the store are both inside the plane, which already holds every
 * refresh token; a second authority signature would protect nothing the
 * plane cannot already read. What still binds it: the plane's stored
 * bindings digest and version (checked again by `decideResolve`), the
 * refresh-worker audience (so `resolve` hands back the refresh token only on
 * this channel), and a one-minute life. It is never serialized or returned.
 */
import type { CredentialVersion } from '@pagespace/db/schema/agent-accounts';
import type { AgentAccountGrant, ApprovalId, ConversationId, GrantId, GrantIssuer, HashBytes, Nonce, PresenterKeyId, RequestDigest, RunId, SessionId, UserId, VerifiedGrant } from '../grant';
import type { PlaneBindings, SecretRef } from '../store/store-adapter';
import { digestBindings } from '../store/digest-bindings';

const PRESENTATION_TTL_MS = 60_000;

export function refreshPresentation({
  ref,
  version,
  bindings,
  presenterKeyId,
  grantId,
  nonce,
  now,
  hash,
}: {
  readonly ref: SecretRef & { readonly kind: 'oauth2' };
  readonly version: CredentialVersion;
  readonly bindings: PlaneBindings;
  readonly presenterKeyId: PresenterKeyId;
  readonly grantId: GrantId;
  readonly nonce: Nonce;
  readonly now: number;
  readonly hash: HashBytes;
}): VerifiedGrant<'refresh-worker'> {
  const grant: AgentAccountGrant = {
    grantId,
    iss: 'pagespace-account-authority' as GrantIssuer,
    aud: 'refresh-worker',
    tenantId: ref.tenantId,
    human: { userId: 'credential-plane' as UserId, sessionId: 'credential-plane' as SessionId },
    delegationId: null,
    agentPageId: null,
    conversationId: 'credential-plane-refresh' as ConversationId,
    runId: grantId as unknown as RunId,
    sandbox: null,
    callerCeiling: { allowedDriveIds: [], originatingMcpTokenId: null },
    accountId: ref.accountId,
    accountKind: 'oauth2',
    credentialVersion: version,
    policyVersion: bindings.policyVersion,
    bindingDigest: digestBindings({ bindings, hash }),
    operation: { class: 'read', name: 'oauth2.refresh' },
    requestDigest: 'oauth2.refresh' as RequestDigest,
    sessionHttp: false,
    approvalId: 'policy' as ApprovalId | 'policy',
    iat: now,
    nbf: now,
    exp: now + PRESENTATION_TTL_MS,
    nonce,
    presenter: { keyId: presenterKeyId, channel: 'refresh-worker' },
  };
  // The one place outside verify-grant.ts that brands a grant: see the ruling above.
  return grant as VerifiedGrant<'refresh-worker'>;
}
