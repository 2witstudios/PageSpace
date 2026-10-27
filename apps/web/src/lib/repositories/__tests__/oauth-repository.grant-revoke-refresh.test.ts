/**
 * End-to-end proof for the connected-apps revoke mutation (Phase 8 task
 * cg0aqe6bu21qg2tj7lgswf38, acceptance criterion 3): revoking a grant from
 * the settings page must immediately invalidate its refresh token — a
 * subsequent `grant_type=refresh_token` call with that same token must fail.
 *
 * Exercises the real `findOAuthGrantById` -> `revokeOAuthGrantFamily` ->
 * `refreshTokenGrant` sequence against one shared in-memory row store (the
 * same harness style `oauth-repository.refresh.test.ts` uses for
 * `db.transaction`, extended with a top-level `db.select`/`db.update` for
 * the two grant-management functions, which run outside a transaction).
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
    userId: 'rt.userId',
    revokedAt: 'rt.revokedAt',
  } as Record<string, unknown>,
  oauthAccessTokens: { __table: 'access', familyId: 'at.familyId', revokedAt: 'at.revokedAt' } as Record<
    string,
    unknown
  >,
  usersTable: { __table: 'users', id: 'users.id' } as Record<string, unknown>,
  state: { dbTransactionImpl: null as null | ((cb: (tx: unknown) => unknown) => unknown) },
}));

const { oauthRefreshTokens, oauthAccessTokens, usersTable } = H;

vi.mock('@pagespace/db/schema/oauth', () => ({
  oauthRefreshTokens: H.oauthRefreshTokens,
  oauthAccessTokens: H.oauthAccessTokens,
  oauthClients: {},
  oauthAuthorizationCodes: {},
}));
vi.mock('@pagespace/db/schema/auth', () => ({
  users: H.usersTable,
}));
vi.mock('@pagespace/db/operators', () => ({
  eq: vi.fn((a: unknown, b: unknown) => ({ _eq: [a, b] })),
  and: vi.fn((...args: unknown[]) => ({ _and: args })),
  isNull: vi.fn((a: unknown) => ({ _isNull: a })),
}));

type Predicate = { _eq: [unknown, unknown] } | { _and: Predicate[] } | { _isNull: unknown };

function columnKey(col: unknown): string {
  return String(col).split('.').pop() as string;
}

function evalPredicate(pred: Predicate, row: Record<string, unknown>): boolean {
  if ('_and' in pred) return pred._and.every((p) => evalPredicate(p, row));
  if ('_eq' in pred) return row[columnKey(pred._eq[0])] === pred._eq[1];
  if ('_isNull' in pred) return row[columnKey(pred._isNull)] == null;
  return true;
}

interface RefreshRow {
  id: string;
  tokenHash: string;
  tokenPrefix?: string;
  clientId: string;
  familyId: string;
  userId: string;
  scopes: string[];
  tokenVersion: number;
  expiresAt: Date;
  familyExpiresAt: Date;
  replacedByTokenId: string | null;
  revokedAt: Date | null;
  revokedReason: string | null;
}

interface AccessRow {
  tokenHash: string;
  familyId: string;
  userId: string;
  scopes: string[];
  revokedAt: Date | null;
  revokedReason: string | null;
}

let refreshRows: RefreshRow[] = [];
let accessRows: AccessRow[] = [];
let lockChain: Promise<unknown> = Promise.resolve();

function makeTx() {
  return {
    select: () => ({
      from: (table: unknown) => ({
        where: (predicate: Predicate) => {
          if (table === usersTable) {
            return Promise.resolve([{ suspendedAt: null, tokenVersion: 0 }]);
          }
          const matches = refreshRows.filter((r) => evalPredicate(predicate, r as unknown as Record<string, unknown>));
          const p = Promise.resolve(matches) as Promise<RefreshRow[]> & { for: (mode: string) => Promise<RefreshRow[]> };
          p.for = () => p;
          return p;
        },
      }),
    }),
    update: (table: unknown) => ({
      set: (patch: Record<string, unknown>) => ({
        where: (predicate: Predicate) => {
          if (table === oauthRefreshTokens) {
            refreshRows
              .filter((r) => evalPredicate(predicate, r as unknown as Record<string, unknown>))
              .forEach((r) => Object.assign(r, patch));
          } else if (table === oauthAccessTokens) {
            accessRows
              .filter((r) => evalPredicate(predicate, r as unknown as Record<string, unknown>))
              .forEach((r) => Object.assign(r, patch));
          }
          return Promise.resolve();
        },
      }),
    }),
    insert: (table: unknown) => ({
      values: (row: Record<string, unknown>) => {
        if (table === oauthRefreshTokens) refreshRows.push(row as unknown as RefreshRow);
        else if (table === oauthAccessTokens) accessRows.push(row as unknown as AccessRow);
        return Promise.resolve();
      },
    }),
  };
}

H.state.dbTransactionImpl = ((cb: (tx: ReturnType<typeof makeTx>) => Promise<unknown>) => {
  const run = lockChain.then(() => cb(makeTx()));
  lockChain = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}) as (cb: (tx: unknown) => unknown) => unknown;

vi.mock('@pagespace/db/db', () => ({
  db: {
    transaction: (cb: (tx: unknown) => unknown) => H.state.dbTransactionImpl!(cb),
    select: (fields: Record<string, unknown>) => ({
      from: (table: unknown) => ({
        where: (predicate: Predicate) => {
          if (table !== oauthRefreshTokens) return Promise.resolve([]);
          const matches = refreshRows.filter((r) => evalPredicate(predicate, r as unknown as Record<string, unknown>));
          return Promise.resolve(
            matches.map((r) => {
              const projected: Record<string, unknown> = {};
              for (const key of Object.keys(fields)) projected[key] = (r as unknown as Record<string, unknown>)[key];
              return projected;
            }),
          );
        },
      }),
    }),
    update: (table: unknown) => ({
      set: (patch: Record<string, unknown>) => ({
        where: (predicate: Predicate) => {
          if (table === oauthRefreshTokens) {
            refreshRows
              .filter((r) => evalPredicate(predicate, r as unknown as Record<string, unknown>))
              .forEach((r) => Object.assign(r, patch));
          } else if (table === oauthAccessTokens) {
            accessRows
              .filter((r) => evalPredicate(predicate, r as unknown as Record<string, unknown>))
              .forEach((r) => Object.assign(r, patch));
          }
          return Promise.resolve();
        },
      }),
    }),
  },
}));

import { hashToken } from '@pagespace/lib/auth/token-utils';
import { findOAuthGrantById, revokeOAuthGrantFamily, refreshTokenGrant } from '../oauth-repository';

const REFRESH_TOKEN = 'raw-refresh-token-value';
const CLIENT_DB_ID = 'client-db-id-1';
const USER_ID = 'user-1';
const FAMILY_ID = 'family-1';
const DAY = 24 * 60 * 60 * 1000;

function seedRefreshRow(overrides: Partial<RefreshRow> = {}): RefreshRow {
  const row: RefreshRow = {
    id: 'grant-row-1',
    tokenHash: hashToken(REFRESH_TOKEN),
    tokenPrefix: REFRESH_TOKEN.slice(0, 12),
    clientId: CLIENT_DB_ID,
    familyId: FAMILY_ID,
    userId: USER_ID,
    scopes: ['account', 'offline_access'],
    tokenVersion: 0,
    expiresAt: new Date(Date.now() + 30 * DAY),
    familyExpiresAt: new Date(Date.now() + 90 * DAY),
    replacedByTokenId: null,
    revokedAt: null,
    revokedReason: null,
    ...overrides,
  };
  refreshRows.push(row);
  return row;
}

beforeEach(() => {
  vi.clearAllMocks();
  refreshRows = [];
  accessRows = [];
  lockChain = Promise.resolve();
});

describe('revoking a grant from settings invalidates its refresh token end-to-end', () => {
  it('a refresh_token grant with the revoked token fails after findOAuthGrantById -> revokeOAuthGrantFamily', async () => {
    seedRefreshRow();

    // Sanity: the token works before revocation.
    const before = await refreshTokenGrant({
      refreshToken: REFRESH_TOKEN,
      clientDbId: CLIENT_DB_ID,
      requestedScope: null,
      now: new Date(),
    });
    expect(before.outcome).toBe('ok');

    // Rotation already revoked + replaced the presented token as a side
    // effect of the successful refresh above — reseed a fresh, live grant to
    // isolate what this test is actually proving: revoking BEFORE any
    // refresh attempt is what invalidates it, not rotation.
    refreshRows = [];
    accessRows = [];
    seedRefreshRow();

    const route = await findOAuthGrantById('grant-row-1');
    expect(route).not.toBeNull();
    if (!route) throw new Error('unreachable');
    expect(route.userId).toBe(USER_ID);

    await revokeOAuthGrantFamily(route.familyId, new Date());
    expect(refreshRows[0].revokedAt).not.toBeNull();

    const after = await refreshTokenGrant({
      refreshToken: REFRESH_TOKEN,
      clientDbId: CLIENT_DB_ID,
      requestedScope: null,
      now: new Date(),
    });

    expect(after).toEqual({ outcome: 'invalid_grant' });
    // No new pair was minted off a token this route already killed.
    expect(refreshRows).toHaveLength(1);
    expect(accessRows).toHaveLength(0);
  });

  it("findOAuthGrantById no longer returns the row once revoked (a second revoke attempt 404s, doesn't double-revoke)", async () => {
    seedRefreshRow();

    const first = await findOAuthGrantById('grant-row-1');
    expect(first).not.toBeNull();
    if (!first) throw new Error('unreachable');
    await revokeOAuthGrantFamily(first.familyId, new Date());

    const second = await findOAuthGrantById('grant-row-1');
    expect(second).toBeNull();
  });
});
