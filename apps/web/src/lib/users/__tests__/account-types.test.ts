import { describe, it, expect, vi, beforeEach } from 'vitest';

const H = vi.hoisted(() => ({ rows: [] as Array<{ id: string; accountType: 'human' | 'agent' }>, where: vi.fn() }));
vi.mock('@pagespace/db/db', () => ({
  db: {
    select: vi.fn(() => ({ from: vi.fn(() => ({ where: (arg: unknown) => { H.where(arg); return Promise.resolve(H.rows); } })) })),
  },
}));
vi.mock('@pagespace/db/operators', () => ({ inArray: vi.fn((col: unknown, vals: unknown) => ({ col, vals })) }));
vi.mock('@pagespace/db/schema/auth', () => ({ users: { id: 'users.id', accountType: 'users.accountType' } }));

import { loadAccountTypes } from '../account-types';
import { db } from '@pagespace/db/db';

describe('loadAccountTypes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    H.rows = [];
  });

  it('given no ids, should not query', async () => {
    expect(await loadAccountTypes([])).toEqual(new Map());
    expect(db.select).not.toHaveBeenCalled();
  });

  it('given ids, should map each to its accountType in one deduplicated query', async () => {
    H.rows = [{ id: 'a', accountType: 'agent' }, { id: 'h', accountType: 'human' }];

    const result = await loadAccountTypes(['a', 'h', 'a']);

    expect(result.get('a')).toBe('agent');
    expect(result.get('h')).toBe('human');
    expect(db.select).toHaveBeenCalledTimes(1);
    expect(H.where).toHaveBeenCalledWith({ col: 'users.id', vals: ['a', 'h'] });
  });
});
