/**
 * APPROVAL OUTCOMES AND THE BOUNDED ALWAYS-ALLOW POLICY (ADR 0004 §4.3).
 *
 * Frozen at L1·G1a; types only. G1b implements `decide-approval.ts`.
 *
 * `allow_once | always | deny` are OUTCOMES (the Muse vocabulary the epic
 * adopted). They are not a policy. "Always" means always WITHIN a bounded
 * policy — scope, trigger, duration, limits, approver — and never covers the
 * `irreversible` or `privilege` classes. An approval is an authenticated
 * human decision received by the authority directly; text produced by a
 * model, a page body or a summary carries no authority (threat model ASI06).
 */
import type { OperationClass, OperationRef, RequestDigest, UserId } from './grant';
import type { CanonicalOrigin } from './canonical-request';

export type ApprovalOutcome = 'allow_once' | 'always' | 'deny';

export type ApprovalTrigger = 'every_use' | 'unknown_and_irreversible' | 'irreversible_only';

export type ApprovalScope = {
  readonly origins: readonly CanonicalOrigin[];
  /** Allowed operations by class and name; `name: '*'` within a class is allowed only for `read`/`write`. */
  readonly operations: readonly OperationRef[];
  readonly resources: readonly (readonly [string, string])[];
};

export type ApprovalLimits = {
  readonly maxUsesPerHour: number;
  readonly maxBytesOut: number;
  readonly maxConcurrent: number;
};

/** The bounded policy an `always` outcome writes. Folded into the account's `policyVersion`. */
export type AccountApprovalPolicy = {
  readonly scope: ApprovalScope;
  readonly trigger: ApprovalTrigger;
  /** null = until revoked; otherwise an absolute ms deadline. */
  readonly duration: { readonly until: number } | null;
  readonly limits: ApprovalLimits;
  readonly approver: UserId;
};

/** Usage counters the repository fetched for the policy window. */
export type UsageCounters = {
  readonly usesThisHour: number;
  readonly bytesOutThisHour: number;
  readonly concurrent: number;
};

/** What the authority must obtain before issuing a grant. */
export type ApprovalRequirement =
  | { readonly kind: 'policy' }
  | { readonly kind: 'concrete'; readonly stepUp: boolean }
  | { readonly kind: 'refuse'; readonly reason: 'limits_exceeded' | 'policy_expired' | 'out_of_scope' | 'class_never_always' };

/** Which classes an `always` policy may cover: `Record<OperationClass, boolean>` so an added class fails typecheck. */
export type AlwaysAllowedByClass = Readonly<Record<OperationClass, boolean>>;

/** `decideApproval` — pure; G1b implements. */
export type DecideApproval = (input: {
  readonly operation: OperationRef;
  readonly policy: AccountApprovalPolicy | null;
  readonly requestDigest: RequestDigest;
  readonly origin: CanonicalOrigin;
  readonly now: number;
  readonly usage: UsageCounters;
}) => ApprovalRequirement;
