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
import type { CanonicalOrigin, ResourceRestrictions } from './canonical-request';

export type ApprovalOutcome = 'allow_once' | 'always' | 'deny';

export type ApprovalTrigger = 'every_use' | 'unknown_and_irreversible' | 'irreversible_only';

export type ApprovalScope = {
  readonly origins: readonly CanonicalOrigin[];
  /** Allowed operations by class and name; `name: '*'` within a class is allowed only for `read`/`write`. */
  readonly operations: readonly OperationRef[];
  /**
   * `[restrictionKey, value]` pairs. Every key named here must be BOUND by the
   * request with every value allowed; a key the operation does not bind is
   * `out_of_scope`, never "unrestricted" (G1c R5). `[]` restricts no resource.
   */
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

/**
 * `decideApproval` — pure. Order: the account's `restrictions` first (a key the
 * request does not bind, or a value outside the list, is `out_of_scope`
 * whatever any policy says — R5); then, for an unattended run, the
 * `delegationScope` the human delegated (a request outside it is
 * `out_of_scope` — R12); then the policy as before.
 */
export type DecideApproval = (input: {
  readonly operation: OperationRef;
  /** `agent_accounts.resourceRestrictions` (a `PlaneScope` field, so bound by `policyDigest`). */
  readonly restrictions: ResourceRestrictions;
  /** `DelegationFact.scope` for an unattended run; null for a live human session. */
  readonly delegationScope: ApprovalScope | null;
  readonly policy: AccountApprovalPolicy | null;
  readonly requestDigest: RequestDigest;
  readonly origin: CanonicalOrigin;
  /** The canonical resource pairs of the request — compared against `policy.scope.resources` (Codex P1 on PR #2637). */
  readonly resources: readonly (readonly [string, string])[];
  readonly now: number;
  readonly usage: UsageCounters;
}) => ApprovalRequirement;
