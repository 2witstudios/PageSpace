/**
 * `decideRetry` — replay protection is not idempotency (threat model §2.4).
 *
 * A one-use grant prevents a second AUTHORIZATION; it does nothing about a
 * duplicate UPSTREAM WRITE when a timeout follows a write that may have
 * landed. So this decision never produces "present the grant again" — the
 * nonce is spent — and it never produces an automatic retry of a
 * non-idempotent operation once the request has been sent. In that case the
 * executor reports `outcome: 'unknown'` (audit shape, ADR 0004 §5) and a
 * human decides. Only `read` is treated as idempotent; every other class,
 * `unknown` included, is assumed to have side effects.
 *
 * Pure: attempt counting is the caller's; the budget is a parameter.
 */
import type { AuditOutcome } from './audit';
import type { OperationClass } from './grant';

export type ExecutionFailure =
  /** Nothing reached upstream: connect refused, DNS pinning refused, TLS failed before the request. */
  | { readonly kind: 'before_send' }
  /** The request was sent and no response arrived: upstream may have acted. */
  | { readonly kind: 'timeout_after_send' }
  /** Upstream answered: the write is known to have been received. */
  | { readonly kind: 'upstream_status'; readonly status: number };

/** The outcomes a failed execution can report (audit shape, ADR 0004 §5). */
export type ReportedOutcome = Extract<AuditOutcome, { readonly kind: 'unknown' | 'upstream_failed' }>;

export type RetryDecision =
  /** The spent grant is never re-presented; a retry is a new authorization. */
  | { readonly action: 'retry_with_new_grant' }
  | { readonly action: 'report'; readonly outcome: ReportedOutcome };

export type DecideRetry = (input: {
  readonly operationClass: OperationClass;
  readonly failure: ExecutionFailure;
  /** 1-based; the attempt that just failed. */
  readonly attempt: number;
  readonly maxAttempts: number;
}) => RetryDecision;

/** The one idempotent class. `Record` so an added class must be classified here. */
const IDEMPOTENT: Readonly<Record<OperationClass, boolean>> = {
  read: true,
  write: false,
  irreversible: false,
  privilege: false,
  unknown: false,
};

const retry = (): RetryDecision => ({ action: 'retry_with_new_grant' });
const report = (outcome: ReportedOutcome): RetryDecision => ({ action: 'report', outcome });

export const decideRetry: DecideRetry = ({ operationClass, failure, attempt, maxAttempts }) => {
  const budgetLeft = attempt < maxAttempts;
  switch (failure.kind) {
    case 'before_send':
      return budgetLeft ? retry() : report({ kind: 'upstream_failed', upstreamStatus: null });
    case 'timeout_after_send':
      if (!IDEMPOTENT[operationClass]) return report({ kind: 'unknown' });
      return budgetLeft ? retry() : report({ kind: 'upstream_failed', upstreamStatus: null });
    case 'upstream_status':
      if (IDEMPOTENT[operationClass] && failure.status >= 500 && budgetLeft) return retry();
      return report({ kind: 'upstream_failed', upstreamStatus: failure.status });
  }
};
