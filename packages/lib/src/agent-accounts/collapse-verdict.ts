/**
 * `collapseVerdictForCaller` — one constant-shape refusal toward an untrusted
 * caller (ADR 0004 F16).
 *
 * The verifier keeps granular reasons so it is precisely testable and so the
 * audit row can name the field that failed. A model, a sandbox or a browser
 * page must never see WHICH check failed: a distinguishable reason is exactly
 * the oracle an attacker wants (does the account exist? is the grant only
 * expired? is it bound to another run?). The reason goes to the audit record
 * and to the human; the caller gets `refused`.
 *
 * Pure.
 */
import type { GrantId, GrantVerdict } from './grant';

export type CallerVerdict = { readonly ok: true; readonly grantId: GrantId } | { readonly ok: false; readonly error: 'refused' };

export function collapseVerdictForCaller({ verdict }: { readonly verdict: GrantVerdict }): CallerVerdict {
  if (verdict.ok) return { ok: true, grantId: verdict.grant.grantId };
  return { ok: false, error: 'refused' };
}
