/**
 * `resolveClient` / `resolveClientDbId` (Phase 1a leaf 2, ADR 0004 Decision 2).
 *
 * Static registry first, then the `oauth_clients` row — and only a row whose
 * `disabledAt IS NULL`. The query itself must carry that filter (not just the
 * pure mapper), and the FK id for a DB client comes from its own row: never
 * from `ensureOAuthClientRow`, which would resurrect a deleted client as an
 * enabled row with an empty scope cap.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('server-only', () => ({}));

const H = vi.hoisted(() => ({
  oauthClients: { __table: 'clients', id: 'c.id', clientId: 'c.clientId', disabledAt: 'c.disabledAt' } as Record<string, unknown>,
}));

vi.mock('@pagespace/db/schema/oauth', () => ({
  oauthClients: H.oauthClients,
  oauthAuthorizationCodes: {},
  oauthRefreshTokens: {},
  oauthAccessTokens: {},
  oauthDeviceCodes: {},
}));
vi.mock('@pagespace/db/schema/auth', () => ({ users: { id: 'users.id' } }));
vi.mock('@pagespace/db/operators', () => ({
  eq: vi.fn((a: unknown, b: unknown) => ({ _eq: [a, b] })),
  and: vi.fn((...args: unknown[]) => ({ _and: args })),
  isNull: vi.fn((a: unknown) => ({ _isNull: a })),
}));

const findFirst = vi.fn();
const insert = vi.fn();
vi.mock('@pagespace/db/db', () => ({
  db: {
    query: { oauthClients: { findFirst: (...args: unknown[]) => findFirst(...args) } },
    insert: (...args: unknown[]) => insert(...args),
  },
}));

import { resolveClient, resolveClientDbId } from '../oauth-repository';
import { getRegisteredClient, PAGESPACE_CLI_CLIENT_ID } from '@pagespace/lib/auth/oauth/clients';

const ROW = {
  id: 'db-row-1',
  clientId: 'app_swipesend',
  name: 'SwipeSend',
  clientType: 'public',
  redirectUris: ['swipesend://callback'],
  allowedGrantTypes: ['authorization_code', 'refresh_token'],
  allowedScopes: ['profile'],
  logoUrl: null,
  homepageUrl: null,
  description: null,
  ownerUserId: 'user-1',
  verified: false,
  isFirstParty: false,
  disabledAt: null,
};

const ENABLED_FILTER = { _and: [{ _eq: ['c.clientId', 'app_swipesend'] }, { _isNull: 'c.disabledAt' }] };

beforeEach(() => {
  vi.clearAllMocks();
  insert.mockReturnValue({ values: vi.fn().mockReturnValue({ onConflictDoNothing: vi.fn().mockResolvedValue(undefined) }) });
});

describe('resolveClient', () => {
  it('returns the static first-party client without a query', async () => {
    const client = await resolveClient(PAGESPACE_CLI_CLIENT_ID);
    expect(client).toBe(getRegisteredClient(PAGESPACE_CLI_CLIENT_ID));
    expect(findFirst).not.toHaveBeenCalled();
  });

  it('looks a third-party client up with disabledAt IS NULL in the query itself', async () => {
    findFirst.mockResolvedValue(ROW);

    const client = await resolveClient('app_swipesend');

    expect(findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: ENABLED_FILTER }));
    expect(client).toMatchObject({ clientId: 'app_swipesend', firstParty: false, type: 'public' });
  });

  it('returns null for an unknown client (the same value a disabled client yields)', async () => {
    findFirst.mockResolvedValue(undefined);
    expect(await resolveClient('app_swipesend')).toBeNull();
  });

  it('returns null for a disabled row even if the query filter were bypassed', async () => {
    findFirst.mockResolvedValue({ ...ROW, disabledAt: new Date('2026-01-01T00:00:00Z') });
    expect(await resolveClient('app_swipesend')).toBeNull();
  });
});

describe('resolveClientDbId', () => {
  it('ensures the FK row for a first-party client', async () => {
    findFirst.mockResolvedValue({ id: 'cli-row' });

    const id = await resolveClientDbId(getRegisteredClient(PAGESPACE_CLI_CLIENT_ID)!);

    expect(insert).toHaveBeenCalledTimes(1);
    expect(id).toBe('cli-row');
  });

  it('reads a third-party client id from its own enabled row and never inserts', async () => {
    findFirst.mockResolvedValue({ id: 'db-row-1' });
    const client = (await (async () => {
      findFirst.mockResolvedValueOnce(ROW);
      return resolveClient('app_swipesend');
    })())!;

    const id = await resolveClientDbId(client);

    expect(id).toBe('db-row-1');
    expect(insert).not.toHaveBeenCalled();
    expect(findFirst).toHaveBeenLastCalledWith(expect.objectContaining({ where: ENABLED_FILTER }));
  });

  it('returns null when a third-party row was disabled or deleted after resolution', async () => {
    findFirst.mockResolvedValueOnce(ROW);
    const client = (await resolveClient('app_swipesend'))!;
    findFirst.mockResolvedValue(undefined);

    expect(await resolveClientDbId(client)).toBeNull();
    expect(insert).not.toHaveBeenCalled();
  });
});
