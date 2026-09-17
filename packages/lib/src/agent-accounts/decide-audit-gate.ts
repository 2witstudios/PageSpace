/**
 * `decideAuditGate` — a privileged operation does not happen until its
 * `allowed` row is durably in the audit chain (ADR 0004 F13).
 *
 * The inversion matters: this is not "log the operation", it is "the
 * operation is refused while the log is in doubt". An audit outage is the
 * one failure that most systems quietly treat as permission to proceed
 * unlogged; here `unavailable`, `rejected` and `pending` all refuse. Only a
 * confirmed durable acceptance proceeds — a write the store has not
 * acknowledged is `pending`, and pending is not accepted.
 *
 * Pure.
 */
import type { GrantDenyReason } from './grant';

export type AuditAcceptance =
  /** The row is durably in the chain; the store acknowledged it. */
  | { readonly kind: 'accepted' }
  /** The store could not be reached, or the write failed. */
  | { readonly kind: 'unavailable' }
  /** The store answered and refused the row. */
  | { readonly kind: 'rejected' }
  /** Sent, not acknowledged. Not an acceptance. */
  | { readonly kind: 'pending' };

export type AuditGateDecision =
  | { readonly action: 'proceed' }
  | { readonly action: 'refuse'; readonly reason: Extract<GrantDenyReason, 'audit_unavailable'> };

export type DecideAuditGate = (input: { readonly acceptance: AuditAcceptance }) => AuditGateDecision;

export const decideAuditGate: DecideAuditGate = ({ acceptance }) =>
  acceptance.kind === 'accepted' ? { action: 'proceed' } : { action: 'refuse', reason: 'audit_unavailable' };
