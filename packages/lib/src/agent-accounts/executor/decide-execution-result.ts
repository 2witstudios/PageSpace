/**
 * `decideExecutionResult` — what the HTTP executor releases to its caller
 * after the audited execution (L2·G2). Pure.
 *
 * The rule the task entry makes load-bearing: an outcome the audit chain did
 * not durably record is NEVER reported as success. `outcomeRecorded: false`
 * means the request ran (or may have) and the chain holds only the `allowed`
 * row, so the response is withheld and the caller is told
 * `outcome_unrecorded` — do not retry automatically, do not treat as done.
 * A refusal stays a refusal either way (nothing ran). `audit_unavailable`
 * means the allowed row was never accepted, so nothing ran at all.
 */
import type { AuditedExecution } from '../audit-gate-executor';
import type { ReleasedResponse } from '../filter-response';
import type { CallerClass } from './decide-operation-outcome';

export type HttpExecutionResult =
  | { readonly ok: true; readonly response: ReleasedResponse }
  | { readonly ok: false; readonly reason: 'refused' | 'upstream_unreachable' | 'outcome_unknown' | 'outcome_unrecorded' | 'audit_unavailable' };

export function decideExecutionResult({
  audited,
  caller,
  released,
}: {
  readonly audited: AuditedExecution;
  readonly caller: CallerClass;
  readonly released: ReleasedResponse | null;
}): HttpExecutionResult {
  if (!audited.ok) return { ok: false, reason: 'audit_unavailable' };
  if (caller === 'refused') return { ok: false, reason: 'refused' };
  if (!audited.outcomeRecorded) return { ok: false, reason: 'outcome_unrecorded' };
  if (caller === 'response') return released === null ? { ok: false, reason: 'outcome_unknown' } : { ok: true, response: released };
  return { ok: false, reason: caller };
}
