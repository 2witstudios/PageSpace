/**
 * RFC 7009 token revocation (task qyqgrjbvntpsdh578k0yiwgr).
 *
 * revokeOAuthToken never distinguishes "not found" from "found and revoked" —
 * the route layer always returns 200 regardless of what happens here. These
 * tests instead assert the correct DB side-effect occurred: a refresh token
 * revokes its whole family; an access token revokes only itself.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('server-only', () => ({}));

const H = vi.hoisted(() => ({
  oauthRefreshTokens: {
    __table: 'refresh',
    id: 'rt.id',
    tokenHash: 'rt.tokenHash',
    clientId: 'rt.clientId',
    familyId: 'rt.familyId',
    revokedAt: 'rt.revokedAt',
  } as Record<string, unknown>,
  oauthAccessTokens: {
    __table: 'access',
    id: 'at.id',
    tokenHash: 'at.tokenHash',
    clientId: 'at.clientId',
    familyId: 'at.familyId',
    revokedAt: 'at.revokedAt',
  } as Record<string, unknown>,
}));

vi.mock('@pagespace/db/schema/oauth', () => ({
  oauthRefreshTokens: H.oauthRefreshTokens,
  oauthAccessTokens: H.oauthAccessTokens,
  oauthClients: {},
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

import { revokeOAuthToken } from '../oauth-repository';

const CLIENT_DB_ID = 'client-db-id-1';
const NOW = new Date('2026-01-01T00:00:00Z');

function stubSelectResult(rows: unknown[]) {
  return { from: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue(rows) }) };
}

function stubUpdateChain() {
  const where = vi.fn().mockResolvedValue(undefined);
  const set = vi.fn().mockReturnValue({ where });
  updateMock.mockReturnValue({ set });
  return { set, where };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('revokeOAuthToken — refresh token', () => {
  it('revokes the whole family when a matching refresh token is found', async () => {
    selectMock.mockReturnValueOnce(stubSelectResult([{ familyId: 'family-1' }]));
    const { set } = stubUpdateChain();

    await revokeOAuthToken({ token: 'ps_rt_' + 'a'.repeat(43), clientDbId: CLIENT_DB_ID, now: NOW });

    expect(updateMock).toHaveBeenCalledWith(H.oauthRefreshTokens);
    expect(updateMock).toHaveBeenCalledWith(H.oauthAccessTokens);
    expect(set).toHaveBeenCalledWith(expect.objectContaining({ revokedAt: NOW }));
  });

  it('no-ops when the refresh token is unknown/foreign (no matching client-scoped row)', async () => {
    selectMock.mockReturnValueOnce(stubSelectResult([]));

    await revokeOAuthToken({ token: 'ps_rt_' + 'b'.repeat(43), clientDbId: CLIENT_DB_ID, now: NOW });

    expect(updateMock).not.toHaveBeenCalled();
  });
});

describe('revokeOAuthToken — access token', () => {
  it('revokes only the single access token, not its family', async () => {
    const { set, where } = stubUpdateChain();

    await revokeOAuthToken({ token: 'ps_at_' + 'a'.repeat(43), clientDbId: CLIENT_DB_ID, now: NOW });

    expect(updateMock).toHaveBeenCalledTimes(1);
    expect(updateMock).toHaveBeenCalledWith(H.oauthAccessTokens);
    expect(set).toHaveBeenCalledWith(expect.objectContaining({ revokedAt: NOW }));
    expect(where).toHaveBeenCalled();
  });
});

describe('revokeOAuthToken — unknown token format', () => {
  it('no-ops for a token with neither ps_at_ nor ps_rt_ prefix (foreign/garbage — no oracle upstream)', async () => {
    await revokeOAuthToken({ token: 'mcp_some-token', clientDbId: CLIENT_DB_ID, now: NOW });

    expect(selectMock).not.toHaveBeenCalled();
    expect(updateMock).not.toHaveBeenCalled();
  });

  it('no-ops for an empty token', async () => {
    await revokeOAuthToken({ token: '', clientDbId: CLIENT_DB_ID, now: NOW });

    expect(selectMock).not.toHaveBeenCalled();
    expect(updateMock).not.toHaveBeenCalled();
  });
});
