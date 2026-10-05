import { describe, it, expect } from 'vitest';
import { orgChangeRefreshes } from '../org-realtime';

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
