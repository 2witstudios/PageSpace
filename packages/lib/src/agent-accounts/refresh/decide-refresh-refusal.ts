import type { ResolveDenyReason } from '../store/store-adapter';

export type RefreshRefusal = { readonly from: 'resolve'; readonly reason: ResolveDenyReason } | { readonly from: 'endpoint'; readonly reason: 'unknown_provider' | 'endpoint_mismatch' };

export function decideRefreshRefusal(_input: { readonly refusal: RefreshRefusal }): { readonly outcome: 'version_conflict' | 'store_unavailable' | 'needs_reauth' | 'not_refreshable'; readonly markNeedsReauth: boolean } {
  throw new Error('decideRefreshRefusal: not implemented (RED)');
}
