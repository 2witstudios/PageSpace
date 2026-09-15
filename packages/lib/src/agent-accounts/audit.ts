/**
 * THE AUDIT RECORD SHAPE (ADR 0004 §5; Control Board §1 "Audit record shape").
 *
 * Frozen at L1·G1a; types only. G1b implements `build-audit-record.ts` and
 * the `audit-repository.ts` that accepts a record DURABLY BEFORE the executor
 * acts (ADR 0004 F13: an unavailable audit store refuses the operation; an
 * outage never silently enables unaudited credential use).
 *
 * Carries: every principal by id, account/version, policy/approval ids, the
 * normalized action, the outcome. Never: a raw credential, a request body, a
 * response body, or any header VALUE beyond the projected names.
 */
import type {
  AgentAccountGrant,
  GrantDenyReason,
  GrantId,
  GrantPresenter,
  OperationRef,
  RequestDigest,
} from './grant';
import type { CanonicalOrigin, CanonicalRequest } from './canonical-request';

export type AuditOutcome =
  | { readonly kind: 'allowed' }
  | { readonly kind: 'denied'; readonly reason: GrantDenyReason }
  | { readonly kind: 'executed'; readonly upstreamStatus: number | null }
  | { readonly kind: 'upstream_failed'; readonly upstreamStatus: number | null }
  /** A timeout after a possible upstream write: replay protection is not idempotency (threat model §2.4). */
  | { readonly kind: 'unknown' };

/** The canonical request minus anything that could carry a secret or a body. */
export type NormalizedAction = {
  readonly channel: CanonicalRequest['channel'];
  readonly method: CanonicalRequest['method'];
  readonly origin: CanonicalOrigin;
  readonly path: string;
  readonly headerNames: readonly string[];
  readonly bodySha256: string;
  readonly resources: CanonicalRequest['resources'];
  readonly operation: OperationRef;
};

export type AgentAccountAuditRecord = {
  readonly grantId: GrantId;
  readonly principal: Pick<
    AgentAccountGrant,
    'tenantId' | 'human' | 'delegationId' | 'agentPageId' | 'conversationId' | 'runId' | 'sandbox' | 'callerCeiling'
  >;
  readonly accountId: AgentAccountGrant['accountId'];
  readonly accountKind: AgentAccountGrant['accountKind'];
  readonly credentialVersion: AgentAccountGrant['credentialVersion'];
  readonly policyVersion: AgentAccountGrant['policyVersion'];
  readonly approvalId: AgentAccountGrant['approvalId'];
  readonly requestDigest: RequestDigest;
  readonly normalizedAction: NormalizedAction;
  readonly presenter: GrantPresenter;
  readonly outcome: AuditOutcome;
  /** ms since epoch, injected. */
  readonly at: number;
};

/** `buildAuditRecord` — pure; never includes body or secret. G1b implements. */
export type BuildAuditRecord = (input: {
  readonly grant: AgentAccountGrant;
  readonly canonical: CanonicalRequest;
  readonly outcome: AuditOutcome;
  readonly at: number;
}) => AgentAccountAuditRecord;
