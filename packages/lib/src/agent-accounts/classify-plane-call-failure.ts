/**
 * `classifyPlaneCallFailure` — what the web process may report when a call to
 * the credential plane fails (L2·G2 review HIGH-2). Pure.
 *
 * `execute` is the dangerous one: once the call may have reached the plane,
 * the plane may have sent the request upstream even though the web process
 * never heard back (its own timeout, a dropped connection, a 5xx). That is
 * `outcome_unknown` — do not retry automatically — never "nothing was sent".
 * Only a failure that provably precedes the plane receiving the call
 * (connection refused, host not found) is `plane_unavailable`; a 4xx is the
 * plane rejecting the call before executing anything (`refused`). `put` and
 * `revoke` report every failure as `plane_unavailable`; their callers keep the
 * state that lets the operation be reconciled or repeated.
 */
export type PlaneRoute = 'put' | 'revoke' | 'execute';

export type PlaneCallFailure =
  | { readonly kind: 'timeout' }
  /** `code`: the transport error code when one surfaced (`ECONNREFUSED`, `ECONNRESET`…), else null. */
  | { readonly kind: 'network'; readonly code: string | null }
  | { readonly kind: 'status'; readonly status: number };

const NEVER_REACHED: ReadonlySet<string> = new Set(['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN']);

export function classifyPlaneCallFailure({ route, failure }: { readonly route: PlaneRoute; readonly failure: PlaneCallFailure }): 'plane_unavailable' | 'outcome_unknown' | 'refused' {
  if (route !== 'execute') return 'plane_unavailable';
  if (failure.kind === 'network' && failure.code !== null && NEVER_REACHED.has(failure.code)) return 'plane_unavailable';
  if (failure.kind === 'status' && failure.status >= 400 && failure.status < 500) return 'refused';
  return 'outcome_unknown';
}
