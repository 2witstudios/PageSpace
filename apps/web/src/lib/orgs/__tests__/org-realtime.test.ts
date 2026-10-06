import { describe, it, expect } from 'vitest';
import { orgChangeRefreshes, walletChangeRefreshes } from '../org-realtime';

describe('orgChangeRefreshes', () => {
  const matches = (orgId: string | undefined, change: Parameters<typeof orgChangeRefreshes>[0]['change'], key: unknown) =>
    orgChangeRefreshes({ orgId: 'o1', change }, orgId)(key);

  it('X-4 (partial): an org:changed for the viewed org refetches every projection of that org', () => {
    for (const key of ['/api/orgs/o1', '/api/orgs/o1/members', '/api/orgs/o1/billing/seats', '/api/orgs/o1/audit?category=seats']) {
      expect(matches('o1', 'policy', key), key).toBe(true);
    }
  });

  it('never refetches another org', () => {
    expect(matches('o1', 'policy', '/api/orgs/o2/members')).toBe(false);
    expect(matches('o1', 'policy', '/api/orgs/o10')).toBe(false);
  });

  it('a membership or status change also refreshes my org list (role or lapse may change)', () => {
    expect(matches(undefined, 'membership', '/api/orgs')).toBe(true);
    expect(matches(undefined, 'status', '/api/orgs')).toBe(true);
    expect(matches(undefined, 'policy', '/api/orgs')).toBe(false);
  });

  it('ignores non-string keys', () => {
    expect(matches('o1', 'policy', ['/api/orgs/o1'])).toBe(false);
  });
});

describe('walletChangeRefreshes', () => {
  const m = walletChangeRefreshes({ driveId: 'd1', walletId: 'w1', change: 'balance' }, 'o1', ['d1', 'd2']);

  it('X-4 (partial): a wallet:changed for one of the org drives on screen refetches the pool split and seat caps', () => {
    expect(m('/api/orgs/o1/pool')).toBe(true);
    expect(m('/api/orgs/o1/seat-caps')).toBe(true);
  });

  it('leaves every other projection alone, and ignores drives not on screen', () => {
    expect(m('/api/orgs/o1/members')).toBe(false);
    expect(m('/api/orgs/o2/pool')).toBe(false);
    expect(walletChangeRefreshes({ driveId: 'd9', walletId: 'w9', change: 'balance' }, 'o1', ['d1'])('/api/orgs/o1/pool')).toBe(false);
  });
});
