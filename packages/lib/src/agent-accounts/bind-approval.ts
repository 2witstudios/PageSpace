/**
 * `bindApproval` — an authenticated human decision, bound to the frozen
 * request digest BEFORE issuance (ADR 0004 §4.3; threat model A2, ASI06/09).
 *
 * The decision reaches the authority through one of two authenticated
 * channels: the human's live session on the approval route, or the step-up
 * ceremony (`auth/step-up-service.ts`, decided by `step-up-decisions.ts`)
 * for `privilege` operations. It carries the digest of the subject the human
 * was SHOWN (`renderApprovalSubject`), and it binds only if that digest is
 * the digest of the request about to be issued — "approve one, execute
 * another" is `digest_mismatch` here, and `approval_mismatch` again at the
 * verifier. Model text is unrepresentable in `HumanApprovalDecision` (there
 * is no free-text field) and, smuggled in at runtime, has `no_authority`.
 *
 * The bound row carries NO consumption state: consumption is the ledger's
 * (`consumedByGrantId`, stamped by the one issuance), never the decision's.
 * `deny` binds too — it is audited and nothing is issued. Pure; the clock is
 * a parameter and the ttl decides staleness.
 */
import { secureCompare } from '../auth/secure-compare';
import type { ApprovalOutcome } from './approval';
import type { OperationRef, RequestDigest, SessionId, UserId } from './grant';
import { ALWAYS_ALLOWED_BY_CLASS } from './always-allowed-by-class';

/** The two authenticated channels a decision may arrive on. Nothing else exists. */
export type ApprovalChannel =
  | { readonly kind: 'session'; readonly sessionId: SessionId }
  | { readonly kind: 'step_up'; readonly sessionId: SessionId; readonly challengeId: string };

export type HumanApprovalDecision = {
  readonly outcome: ApprovalOutcome;
  /** The digest of the subject the human was shown. */
  readonly subjectDigest: RequestDigest;
  readonly approvedBy: UserId;
  readonly via: ApprovalChannel;
  /** ms since epoch, from the authenticated route. */
  readonly decidedAt: number;
};

/** What the repository writes as an `agent_account_approvals` row (minus ids and timestamps). */
export type BoundApproval = {
  readonly outcome: ApprovalOutcome;
  readonly requestDigest: RequestDigest;
  readonly approvedByUserId: string;
  readonly approvedViaSessionId: string;
  readonly stepUpChallengeId: string | null;
  readonly expiresAt: number;
};

export type BindApprovalRefusal = 'no_authority' | 'digest_mismatch' | 'stale_decision' | 'step_up_required' | 'class_never_always';

export type BindApprovalResult = { readonly ok: true; readonly approval: BoundApproval } | { readonly ok: false; readonly reason: BindApprovalRefusal };

export type BindApproval = (input: {
  readonly decision: HumanApprovalDecision;
  readonly requestDigest: RequestDigest;
  readonly operation: OperationRef;
  readonly now: number;
  readonly ttlMs: number;
}) => BindApprovalResult;

const OUTCOMES: readonly ApprovalOutcome[] = ['allow_once', 'always', 'deny'];

const refuse = (reason: BindApprovalRefusal): BindApprovalResult => ({ ok: false, reason });

/** Runtime guard for what the type already says: only the two channels carry authority. */
function hasAuthority(decision: HumanApprovalDecision): boolean {
  const via: unknown = decision.via;
  if (via === null || typeof via !== 'object') return false;
  const channel = via as { kind?: unknown; sessionId?: unknown; challengeId?: unknown };
  if (channel.kind !== 'session' && channel.kind !== 'step_up') return false;
  if (typeof channel.sessionId !== 'string' || channel.sessionId.length === 0) return false;
  if (channel.kind === 'step_up' && (typeof channel.challengeId !== 'string' || channel.challengeId.length === 0)) return false;
  if (typeof decision.approvedBy !== 'string' || decision.approvedBy.length === 0) return false;
  return OUTCOMES.includes(decision.outcome);
}

export const bindApproval: BindApproval = ({ decision, requestDigest, operation, now, ttlMs }) => {
  if (!hasAuthority(decision)) return refuse('no_authority');
  if (typeof decision.subjectDigest !== 'string' || !secureCompare(decision.subjectDigest, requestDigest)) return refuse('digest_mismatch');
  if (typeof decision.decidedAt !== 'number' || decision.decidedAt > now || now - decision.decidedAt > ttlMs) return refuse('stale_decision');
  // Step-up gates GRANTING authority. Refusing grants none, and a deny that
  // could not bind would never reach the audit.
  if (operation.class === 'privilege' && decision.outcome !== 'deny' && decision.via.kind !== 'step_up') return refuse('step_up_required');
  if (decision.outcome === 'always' && !ALWAYS_ALLOWED_BY_CLASS[operation.class]) return refuse('class_never_always');

  return {
    ok: true,
    approval: {
      outcome: decision.outcome,
      requestDigest,
      approvedByUserId: decision.approvedBy,
      approvedViaSessionId: decision.via.sessionId,
      stepUpChallengeId: decision.via.kind === 'step_up' ? decision.via.challengeId : null,
      expiresAt: now + ttlMs,
    },
  };
};
