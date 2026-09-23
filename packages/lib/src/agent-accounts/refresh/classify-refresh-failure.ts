export type RefreshFailure =
  | { readonly kind: 'network' }
  | { readonly kind: 'timeout' }
  | { readonly kind: 'malformed_response' }
  | { readonly kind: 'status'; readonly status: number; readonly oauthError: string | null; readonly retryAfterMs: number | null };

export type RefreshFailureClass =
  | { readonly class: 'retryable'; readonly retryAfterMs: number | null }
  | { readonly class: 'purge_and_reauth'; readonly reason: 'invalid_client' | 'rejected' | 'malformed_response' | 'unexpected_status' }
  | { readonly class: 'revoked'; readonly reason: 'invalid_grant' | 'unauthorized' };

export function classifyRefreshFailure(_input: { readonly failure: RefreshFailure }): RefreshFailureClass {
  throw new Error('classifyRefreshFailure: not implemented (RED)');
}
