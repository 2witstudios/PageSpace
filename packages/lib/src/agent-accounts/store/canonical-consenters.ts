/**
 * `canonicalConsenters` — one string per consenter SET: pinned ids sorted, so
 * the order a caller read them in never makes two equal sets differ (G1c R2).
 * Pure.
 */
import { canonicalJson } from '../canonical-json';
import type { PlaneConsenters } from './store-adapter';

export function canonicalConsenters({ consenters }: { readonly consenters: PlaneConsenters }): string {
  return canonicalJson(consenters.kind === 'pinned' ? { kind: 'pinned', userIds: [...consenters.userIds].sort() } : { kind: 'owner' });
}
