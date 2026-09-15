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
 * response body, any header VALUE beyond the projected names, the URL path
 * (a digest stands in for it) or an undeclared resource string.
 */
import type {
  AgentAccountGrant,
  GrantDenyReason,
  GrantId,
  GrantPresenter,
  HashBytes,
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

/**
 * The canonical request minus anything that could carry a secret or a body.
 *
 * AMENDED 2026-09-15 (G1b review): a raw `path` and raw `resources` violated
 * this record's own invariant. Plenty of real APIs put a credential in the
 * URL — `/v1/tokens/<token>`, `/reset/<one-time-code>` — and the audit chain
 * is tamper-evident by construction, so anything written here cannot be
 * erased afterwards, GDPR Art 17 included. The path is therefore stored as a
 * DIGEST (SHA3-256, the repo's hash for secret-adjacent values): it still
 * correlates every row for the same endpoint, and two rows for the same path
 * still match, but no path SEGMENT survives. Resources are projected to the
 * identifiers the TYPED OPERATION declares (repo, org, recipient) — a caller
 * that passes anything else contributes nothing to the row.
 */
export type NormalizedAction = {
  readonly channel: CanonicalRequest['channel'];
  readonly method: CanonicalRequest['method'];
  /** The pinned origin — not a secret, and the one field an investigator needs first. */
  readonly origin: CanonicalOrigin;
  /** `hash(canonicalPath)`, SHA3-256 hex. Correlates endpoints without storing one. */
  readonly pathDigest: string;
  readonly headerNames: readonly string[];
  readonly bodySha256: string;
  /** Sorted `[key, value]` pairs, restricted to the operation's declared resource keys. */
  readonly resourceIds: readonly (readonly [string, string])[];
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

/**
 * `buildAuditRecord` — pure; never includes a body, a credential, a header
 * value, a URL path or an undeclared resource. The hash is injected (SHA3-256
 * in production) so this module stays free of `node:crypto`, and the declared
 * resource keys come from the operation catalogue, so the projection is the
 * typed operation's, not the caller's. G1b implements.
 */
export type BuildAuditRecord = (input: {
  readonly grant: AgentAccountGrant;
  readonly canonical: CanonicalRequest;
  readonly outcome: AuditOutcome;
  readonly at: number;
  readonly hash: HashBytes;
  /** The resource keys this operation declares; every other key is dropped. */
  readonly declaredResourceKeys: readonly string[];
}) => AgentAccountAuditRecord;
