/**
 * Agent Signup Phase 2c, fork ruling (a): activity rows store the actor's name
 * at write time, so the agent marker is resolved at READ time from the actor's
 * live users.accountType. An erased actor (no user row, or userId set null)
 * resolves to null and renders its stored name unmarked.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({ rows: [] as { id: string; accountType: string }[], where: vi.fn() }));

vi.mock('@pagespace/db/db', () => ({
  db: {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn((cond: unknown) => {
          h.where(cond);
          return Promise.resolve(h.rows);
        }),
      })),
    })),
  },
}));
vi.mock('@pagespace/db/operators', () => ({
  inArray: vi.fn((col: unknown, ids: unknown) => ({ col, ids })),
}));
vi.mock('@pagespace/db/schema/auth', () => ({ users: { id: 'users.id', accountType: 'users.accountType' } }));

import { withActorAccountTypes } from '../actor-account-types';
import { db } from '@pagespace/db/db';

describe('withActorAccountTypes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.rows = [];
  });

  it('attaches each actor live accountType, looked up once per distinct actor', async () => {
    h.rows = [{ id: 'agent-1', accountType: 'agent' }, { id: 'u-1', accountType: 'human' }];
    const out = await withActorAccountTypes([
      { id: 'a', userId: 'agent-1' },
      { id: 'b', userId: 'u-1' },
      { id: 'c', userId: 'agent-1' },
    ]);
    expect(out.map((r) => r.actorAccountType)).toEqual(['agent', 'human', 'agent']);
    expect(h.where).toHaveBeenCalledTimes(1);
    expect(h.where).toHaveBeenCalledWith({ col: 'users.id', ids: ['agent-1', 'u-1'] });
  });

  it('resolves an erased actor (null userId, or no user row) to null', async () => {
    h.rows = [];
    const out = await withActorAccountTypes([
      { id: 'a', userId: null },
      { id: 'b', userId: 'gone' },
    ]);
    expect(out.map((r) => r.actorAccountType)).toEqual([null, null]);
  });

  it('does not query when no row has an actor id', async () => {
    const out = await withActorAccountTypes([{ id: 'a', userId: null }]);
    expect(out[0].actorAccountType).toBeNull();
    expect(db.select).not.toHaveBeenCalled();
  });

  it('keeps every other field of the row', async () => {
    h.rows = [{ id: 'u-1', accountType: 'human' }];
    const [row] = await withActorAccountTypes([{ id: 'a', userId: 'u-1', actorDisplayName: 'Jane' }]);
    expect(row).toEqual({ id: 'a', userId: 'u-1', actorDisplayName: 'Jane', actorAccountType: 'human' });
  });
});
