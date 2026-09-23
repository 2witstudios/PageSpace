/**
 * `decideOperationOutcome` — the audit outcome of one credentialed request and
 * the class its caller learns (L2·G2; ADR 0004 §5, threat model §2.4). Pure.
 *
 * - Refused inside the plane (the credential did not resolve, the request
 *   could not be built): nothing was sent; audit `upstream_failed` with no
 *   status; the caller gets the constant `refused` (ADR 0004 F16).
 * - Refused or failed before the TLS handshake completed: nothing reached the
 *   upstream; `upstream_failed`, and a retry is safe (`upstream_unreachable`).
 * - Failed after the request may have left: `unknown` — a write may have
 *   landed; never reported as failed.
 * - A response of any status: `executed` with that status.
 */
import type { OperationOutcome } from '../audit-gate-executor';
import type { SendOutcome } from './pinned-https-client';

export type ExecutionStage = { readonly kind: 'not_resolved' } | { readonly kind: 'not_built' } | { readonly kind: 'sent'; readonly send: SendOutcome };

export type CallerClass = 'response' | 'refused' | 'upstream_unreachable' | 'outcome_unknown';

export function decideOperationOutcome({ stage }: { readonly stage: ExecutionStage }): { readonly audit: OperationOutcome; readonly caller: CallerClass } {
  if (stage.kind !== 'sent') return { audit: { kind: 'upstream_failed', upstreamStatus: null }, caller: 'refused' };
  const { send } = stage;
  if (send.kind === 'response') return { audit: { kind: 'executed', upstreamStatus: send.status }, caller: 'response' };
  if (send.kind === 'refused' || send.phase === 'before_send') return { audit: { kind: 'upstream_failed', upstreamStatus: null }, caller: 'upstream_unreachable' };
  return { audit: { kind: 'unknown' }, caller: 'outcome_unknown' };
}
