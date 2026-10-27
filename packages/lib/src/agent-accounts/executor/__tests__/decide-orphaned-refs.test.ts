/**
 * L2·G2 review MED-1 — erasure reaches the vault. The main-DB reference rows
 * cascade away when their owning user, agent page or drive is deleted (GDPR
 * erasure included), but the plane's material and metadata do not. The plane
 * sweeps: a plane ref whose account row no longer exists is ORPHANED and its
 * material is deleted. A ref younger than the grace window is left alone —
 * the reference row is written before the put, but a sweep must never race a
 * create whose row is not yet visible to it.
 */
import { describe, expect, it } from 'vitest';
import type { AccountId, TenantId } from '@pagespace/db/schema/agent-accounts';
import { decideOrphanedRefs, ORPHAN_GRACE_MS } from '../decide-orphaned-refs';

const NOW = 1_800_000_000_000;
const ref = (accountId: string, ageMs: number) => ({ ref: { tenantId: 'user:u1' as TenantId, accountId: accountId as AccountId, kind: 'api_key' as const }, createdAt: NOW - ageMs });

describe('decideOrphanedRefs', () => {
  it('given plane refs whose account rows are gone and old enough, should mark exactly those for deletion', () => {
    const refs = [ref('live', ORPHAN_GRACE_MS * 2), ref('gone', ORPHAN_GRACE_MS * 2), ref('gone_young', ORPHAN_GRACE_MS - 1)];
    const actual = decideOrphanedRefs({ refs, liveAccountIds: ['live'], now: NOW }).map((orphan) => orphan.accountId);
    const expected = ['gone'];
    expect(actual).toEqual(expected);
  });

  it('given every row still live, should delete nothing', () => {
    const actual = decideOrphanedRefs({ refs: [ref('a', ORPHAN_GRACE_MS * 3), ref('b', ORPHAN_GRACE_MS * 3)], liveAccountIds: ['a', 'b'], now: NOW });
    const expected: unknown[] = [];
    expect(actual).toEqual(expected);
  });
});
