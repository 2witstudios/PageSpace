/**
 * `decideRefreshRefusal` — what the refresh worker reports when it refuses
 * before sending anything (Control Board §7.1: the adapter holds no decision
 * logic). Pure.
 *
 * - A resolve refused because the version moved (`version_mismatch`,
 *   `bindings_stale`) means another refresh or rebind landed: `version_conflict`,
 *   and the caller re-issues with the current version. Any other resolve
 *   refusal is `store_unavailable`.
 * - A stored endpoint that disagrees with the pinned registry was not written
 *   by our enrollment: `needs_reauth`, and the account is marked.
 * - A generic or unknown provider is `not_refreshable`; the account is left alone.
 */
import type { ResolveDenyReason } from '../store/store-adapter';

export type RefreshRefusal = { readonly from: 'resolve'; readonly reason: ResolveDenyReason } | { readonly from: 'endpoint'; readonly reason: 'unknown_provider' | 'endpoint_mismatch' };

export type RefreshRefusalVerdict = {
  readonly outcome: 'version_conflict' | 'store_unavailable' | 'needs_reauth' | 'not_refreshable';
  readonly markNeedsReauth: boolean;
};

export function decideRefreshRefusal({ refusal }: { readonly refusal: RefreshRefusal }): RefreshRefusalVerdict {
  if (refusal.from === 'endpoint') {
    return refusal.reason === 'endpoint_mismatch' ? { outcome: 'needs_reauth', markNeedsReauth: true } : { outcome: 'not_refreshable', markNeedsReauth: false };
  }
  const moved = refusal.reason === 'version_mismatch' || refusal.reason === 'bindings_stale';
  return { outcome: moved ? 'version_conflict' : 'store_unavailable', markNeedsReauth: false };
}
