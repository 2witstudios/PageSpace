/**
 * `classifyRefreshFailure` — what the refresh worker does after a refresh at
 * the provider's token endpoint did not produce new material (ADR 0003 §5
 * F4/F5 mirrored for providers; RFC 6749 §5.2; RFC 9700). Pure.
 *
 * - `revoked`: the user's grant is dead upstream — `invalid_grant` (the
 *   refresh token is invalid, expired or revoked), or any 401 that is not
 *   about our client. The connection is marked and never retried.
 * - `purge_and_reauth`: a definitive rejection that is not the grant's death —
 *   our client credentials (`invalid_client`), any other 4xx, a redirect or
 *   other non-error status (never followed), or a success body the worker
 *   could not read. The last one is not retried because the provider may
 *   already have rotated the refresh token; presenting the old one again
 *   would look like a replay (RFC 9700 §4.14.2).
 * - `retryable`: network, timeout, 408, 429, 5xx. The only class that may be
 *   tried again; a finite, non-negative Retry-After is kept, anything else
 *   dropped.
 */
export type RefreshFailure =
  | { readonly kind: 'network' }
  | { readonly kind: 'timeout' }
  /** A 2xx whose body carried no usable token set. */
  | { readonly kind: 'malformed_response' }
  /** `oauthError`: the RFC 6749 §5.2 `error` code when the body carried one. */
  | { readonly kind: 'status'; readonly status: number; readonly oauthError: string | null; readonly retryAfterMs: number | null };

export type RefreshFailureClass =
  | { readonly class: 'retryable'; readonly retryAfterMs: number | null }
  | { readonly class: 'purge_and_reauth'; readonly reason: 'invalid_client' | 'rejected' | 'malformed_response' | 'unexpected_status' }
  | { readonly class: 'revoked'; readonly reason: 'invalid_grant' | 'unauthorized' };

const saneDelay = (retryAfterMs: number | null): number | null => (retryAfterMs !== null && Number.isFinite(retryAfterMs) && retryAfterMs >= 0 ? retryAfterMs : null);

export function classifyRefreshFailure({ failure }: { readonly failure: RefreshFailure }): RefreshFailureClass {
  if (failure.kind === 'network' || failure.kind === 'timeout') return { class: 'retryable', retryAfterMs: null };
  if (failure.kind === 'malformed_response') return { class: 'purge_and_reauth', reason: 'malformed_response' };
  const { status, oauthError, retryAfterMs } = failure;
  if (status === 408 || status === 429 || status >= 500) return { class: 'retryable', retryAfterMs: saneDelay(retryAfterMs) };
  if (status < 400) return { class: 'purge_and_reauth', reason: 'unexpected_status' };
  if (oauthError === 'invalid_grant') return { class: 'revoked', reason: 'invalid_grant' };
  if (oauthError === 'invalid_client') return { class: 'purge_and_reauth', reason: 'invalid_client' };
  if (status === 401) return { class: 'revoked', reason: 'unauthorized' };
  return { class: 'purge_and_reauth', reason: 'rejected' };
}
