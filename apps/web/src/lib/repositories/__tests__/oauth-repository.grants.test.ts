/**
 * Connected-apps listing + revoke-by-id persistence (Phase 8 task
 * k58h61obmc91sn1ndngrsev5): `listActiveOAuthGrantsForUser`,
 * `findOAuthGrantById`, `revokeOAuthGrantFamily`. The route layer does the
 * ownership check (`isGrantOwnedByUser`, pure, tested separately) against
 * whatever `findOAuthGrantById` returns — these tests only assert the DB
 * query shape and the revoke side-effect.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('server-only', () => ({}));

const H = vi.hoisted(() => ({
  oauthRefreshTokens: {
    __table: 'refresh',
    id: 'rt.id',
    userId: 'rt.userId',
    clientId: 'rt.clientId',
    familyId: 'rt.familyId',
    scopes: 'rt.scopes',
    createdAt: 'rt.createdAt',
    revokedAt: 'rt.revokedAt',
  } as Record<string, unknown>,
  oauthAccessTokens: {
    __table: 'access',
    familyId: 'at.familyId',
    revokedAt: 'at.revokedAt',
  } as Record<string, unknown>,
  oauthClients: {
    __table: 'clients',
    id: 'clients.id',
    name: 'clients.name',
  } as Record<string, unknown>,
}));

vi.mock('@pagespace/db/schema/oauth', () => ({
  oauthRefreshTokens: H.oauthRefreshTokens,
  oauthAccessTokens: H.oauthAccessTokens,
  oauthClients: H.oauthClients,
  oauthAuthorizationCodes: {},
}));
vi.mock('@pagespace/db/schema/auth', () => ({
  users: { id: 'users.id' },
}));
vi.mock('@pagespace/db/operators', () => ({
  eq: vi.fn((a: unknown, b: unknown) => ({ _eq: [a, b] })),
  and: vi.fn((...args: unknown[]) => ({ _and: args })),
  isNull: vi.fn((a: unknown) => ({ _isNull: a })),
}));

const selectMock = vi.fn();
const updateMock = vi.fn();
vi.mock('@pagespace/db/db', () => ({
  db: {
    select: (...args: unknown[]) => selectMock(...args),
    update: (...args: unknown[]) => updateMock(...args),
  },
}));

import {
  listActiveOAuthGrantsForUser,
  findOAuthGrantById,
  revokeOAuthGrantFamily,
} from '../oauth-repository';

const NOW = new Date('2026-01-01T00:00:00Z');

function stubUpdateChain() {
  const where = vi.fn().mockResolvedValue(undefined);
  const set = vi.fn().mockReturnValue({ where });
  updateMock.mockReturnValue({ set });
  return { set, where };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('listActiveOAuthGrantsForUser', () => {
  it('selects from oauth_refresh_tokens joined to oauth_clients', async () => {
    const where = vi.fn().mockResolvedValue([
      { id: 'grant-1', clientName: 'pagespace CLI', scopes: ['account'], createdAt: NOW },
    ]);
    const innerJoin = vi.fn().mockReturnValue({ where });
    const from = vi.fn().mockReturnValue({ innerJoin });
    selectMock.mockReturnValue({ from });

    const rows = await listActiveOAuthGrantsForUser('user-a');

    expect(from).toHaveBeenCalledWith(H.oauthRefreshTokens);
    expect(innerJoin).toHaveBeenCalledWith(H.oauthClients, expect.anything());
    expect(rows).toEqual([{ id: 'grant-1', clientName: 'pagespace CLI', scopes: ['account'], createdAt: NOW }]);
  });

  it('scopes the query to the given userId and unrevoked rows only', async () => {
    const where = vi.fn().mockResolvedValue([]);
    const innerJoin = vi.fn().mockReturnValue({ where });
    selectMock.mockReturnValue({ from: vi.fn().mockReturnValue({ innerJoin }) });

    await listActiveOAuthGrantsForUser('user-a');

    const predicate = where.mock.calls[0][0];
    expect(predicate).toEqual({
      _and: [{ _eq: [H.oauthRefreshTokens.userId, 'user-a'] }, { _isNull: H.oauthRefreshTokens.revokedAt }],
    });
  });
});

describe('findOAuthGrantById', () => {
  it('returns the row when an unrevoked grant with that id exists', async () => {
    const where = vi.fn().mockResolvedValue([{ id: 'grant-1', userId: 'user-a', familyId: 'family-1' }]);
    selectMock.mockReturnValue({ from: vi.fn().mockReturnValue({ where }) });

    const row = await findOAuthGrantById('grant-1');

    expect(row).toEqual({ id: 'grant-1', userId: 'user-a', familyId: 'family-1' });
  });

  it('returns null when no row matches (unknown id)', async () => {
    const where = vi.fn().mockResolvedValue([]);
    selectMock.mockReturnValue({ from: vi.fn().mockReturnValue({ where }) });

    expect(await findOAuthGrantById('unknown')).toBeNull();
  });

  it('excludes already-revoked rows, same as an unknown id', async () => {
    const where = vi.fn().mockResolvedValue([]);
    selectMock.mockReturnValue({ from: vi.fn().mockReturnValue({ where }) });

    await findOAuthGrantById('grant-1');

    const predicate = where.mock.calls[0][0];
    expect(predicate).toEqual({
      _and: [{ _eq: [H.oauthRefreshTokens.id, 'grant-1'] }, { _isNull: H.oauthRefreshTokens.revokedAt }],
    });
  });
});

describe('revokeOAuthGrantFamily', () => {
  it('revokes both the refresh-token family and its access tokens', async () => {
    const { set } = stubUpdateChain();

    await revokeOAuthGrantFamily('family-1', NOW);

    expect(updateMock).toHaveBeenCalledWith(H.oauthRefreshTokens);
    expect(updateMock).toHaveBeenCalledWith(H.oauthAccessTokens);
    expect(set).toHaveBeenCalledWith(expect.objectContaining({ revokedAt: NOW }));
  });
});
