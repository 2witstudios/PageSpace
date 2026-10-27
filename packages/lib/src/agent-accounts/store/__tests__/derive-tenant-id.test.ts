/**
 * ADR 0005 §3.1, §10.2 — RED at G1b-store before `derive-tenant-id.ts` existed.
 */
import { describe, it, expect } from 'vitest';
import { deriveTenantId } from '../derive-tenant-id';

describe('deriveTenantId', () => {
  it('given a user-owned account, should return user:<userId>', () => {
    const actual = deriveTenantId({ owner: { kind: 'user', userId: 'u1' } });
    expect(actual).toBe('user:u1');
  });

  it('given an agent-page-owned account, should return drive:<driveId>', () => {
    const actual = deriveTenantId({ owner: { kind: 'agent_page', agentPageId: 'p1', driveId: 'd1' } });
    expect(actual).toBe('drive:d1');
  });

  it('given the same owner twice, should return the same id (pure, idempotent)', () => {
    const owner = { kind: 'user' as const, userId: 'u1' };
    const actual = [deriveTenantId({ owner }), deriveTenantId({ owner })];
    expect(actual).toEqual(['user:u1', 'user:u1']);
  });
});
