/**
 * Atomic refresh_token grant (task l8zlp3353f2cunjd33foq41l, RED sub-task
 * qa0870vw0zz27x14n1vluv6z).
 *
 * The fake `db.transaction` below serializes callbacks on a shared in-memory
 * "row" the same way `oauth-repository.exchange.test.ts` does — call B's
 * callback does not start until call A's has fully settled, matching what a
 * real `FOR UPDATE` lock on a single contended row guarantees. That lets the
 * concurrent-refresh test exercise the real `refreshTokenGrant` control flow
 * under a genuine `Promise.all` race instead of trusting a stub.
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
vi.mock('@pagespace/db/db', () => ({
  db: {
    transaction: (cb: (tx: unknown) => unknown) => H.state.dbTransactionImpl!(cb),
  },
}));

import { hashToken } from '@pagespace/lib/auth/token-utils';
import { refreshTokenGrant } from '../oauth-repository';

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
let userSuspendedAt: Date | null = null;
let userTokenVersion = 0;
let lockChain: Promise<unknown> = Promise.resolve();

function makeTx() {
  return {
    select: () => ({
      from: (table: unknown) => ({
        where: (predicate: Predicate) => {
          if (table === usersTable) {
            return Promise.resolve([{ suspendedAt: userSuspendedAt, tokenVersion: userTokenVersion }]);
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

const REFRESH_TOKEN = 'raw-refresh-token-value';
const CLIENT_DB_ID = 'client-db-id-1';
const USER_ID = 'user-1';
const FAMILY_ID = 'family-1';
const DAY = 24 * 60 * 60 * 1000;

function seedRefreshRow(overrides: Partial<RefreshRow> = {}): RefreshRow {
  const row: RefreshRow = {
    id: 'refresh-row-1',
    tokenHash: hashToken(REFRESH_TOKEN),
    tokenPrefix: REFRESH_TOKEN.slice(0, 12),
    clientId: CLIENT_DB_ID,
    familyId: FAMILY_ID,
    userId: USER_ID,
    // offline_access included by default: a stored refresh-token row only
    // ever exists because offline_access was granted at issuance, so the
    // pre-existing rotation fixtures below keep exercising that path; the F1
    // gate tests further down explicitly narrow it away.
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
  userSuspendedAt = null;
  userTokenVersion = 0;
  lockChain = Promise.resolve();
});

describe('refreshTokenGrant — happy path', () => {
  it('rotates: revokes the presented token and issues a new hashed ps_at_*/ps_rt_* pair in the same family', async () => {
    seedRefreshRow();

    const result = await refreshTokenGrant({
      refreshToken: REFRESH_TOKEN,
      clientDbId: CLIENT_DB_ID,
      requestedScope: null,
      now: new Date(),
    });

    expect(result.outcome).toBe('ok');
    if (result.outcome !== 'ok') throw new Error('unreachable');
    expect(result.userId).toBe(USER_ID);
    expect(result.tokens.accessToken).toMatch(/^ps_at_/);
    expect(result.tokens.refreshToken).toMatch(/^ps_rt_/);
    expect(result.tokens.familyId).toBe(FAMILY_ID);

    expect(refreshRows[0].revokedAt).not.toBeNull();
    expect(refreshRows[0].replacedByTokenId).not.toBeNull();
    expect(refreshRows).toHaveLength(2);
    expect(accessRows).toHaveLength(1);
    expect(refreshRows[1].tokenHash).toBe(hashToken(result.tokens.refreshToken!));
    expect(refreshRows[1].familyId).toBe(FAMILY_ID);
  });

  it('never persists the raw refresh token anywhere', async () => {
    seedRefreshRow();

    await refreshTokenGrant({
      refreshToken: REFRESH_TOKEN,
      clientDbId: CLIENT_DB_ID,
      requestedScope: null,
      now: new Date(),
    });

    const serialized = JSON.stringify({ refreshRows, accessRows });
    expect(serialized).not.toContain(REFRESH_TOKEN);
  });
});

describe('refreshTokenGrant — constant-shape rejections', () => {
  it('returns invalid_grant for an unknown refresh token', async () => {
    const result = await refreshTokenGrant({
      refreshToken: 'never-issued',
      clientDbId: CLIENT_DB_ID,
      requestedScope: null,
      now: new Date(),
    });

    expect(result).toEqual({ outcome: 'invalid_grant' });
  });

  it('returns invalid_grant when the token belongs to a different client (scoped lookup, no oracle)', async () => {
    seedRefreshRow({ clientId: 'some-other-client-db-id' });

    const result = await refreshTokenGrant({
      refreshToken: REFRESH_TOKEN,
      clientDbId: CLIENT_DB_ID,
      requestedScope: null,
      now: new Date(),
    });

    expect(result).toEqual({ outcome: 'invalid_grant' });
  });

  it('returns invalid_grant for an expired refresh token', async () => {
    seedRefreshRow({ expiresAt: new Date(Date.now() - 1000) });

    const result = await refreshTokenGrant({
      refreshToken: REFRESH_TOKEN,
      clientDbId: CLIENT_DB_ID,
      requestedScope: null,
      now: new Date(),
    });

    expect(result).toEqual({ outcome: 'invalid_grant' });
  });

  it('returns invalid_grant for a token past its family_expiresAt', async () => {
    seedRefreshRow({ familyExpiresAt: new Date(Date.now() - 1000) });

    const result = await refreshTokenGrant({
      refreshToken: REFRESH_TOKEN,
      clientDbId: CLIENT_DB_ID,
      requestedScope: null,
      now: new Date(),
    });

    expect(result).toEqual({ outcome: 'invalid_grant' });
  });
});

describe('refreshTokenGrant — reuse detection: the theft scenario end-to-end', () => {
  it('legitimate client rotates, attacker replays the stolen rotated token → entire family revoked, both locked out', async () => {
    seedRefreshRow();

    const legitimate = await refreshTokenGrant({
      refreshToken: REFRESH_TOKEN,
      clientDbId: CLIENT_DB_ID,
      requestedScope: null,
      now: new Date(),
    });
    expect(legitimate.outcome).toBe('ok');
    if (legitimate.outcome !== 'ok') throw new Error('unreachable');

    // Attacker replays the original (now rotated-away) token, well outside the 30s grace window.
    const attackerAttempt = await refreshTokenGrant({
      refreshToken: REFRESH_TOKEN,
      clientDbId: CLIENT_DB_ID,
      requestedScope: null,
      now: new Date(Date.now() + 60_000),
    });
    expect(attackerAttempt).toEqual({ outcome: 'invalid_grant' });

    // The entire family is dead: the legitimate client's brand-new refresh token is also revoked.
    const legitimateNewRow = refreshRows.find((r) => r.tokenHash === hashToken(legitimate.tokens.refreshToken!));
    expect(legitimateNewRow?.revokedAt).not.toBeNull();
    expect(accessRows.every((r) => r.revokedAt !== null)).toBe(true);

    // Locked out: the legitimate client can no longer refresh with its (now-revoked) new token either.
    const legitimateRetry = await refreshTokenGrant({
      refreshToken: legitimate.tokens.refreshToken!,
      clientDbId: CLIENT_DB_ID,
      requestedScope: null,
      now: new Date(Date.now() + 61_000),
    });
    expect(legitimateRetry).toEqual({ outcome: 'invalid_grant' });
  });
});

describe('refreshTokenGrant — suspended user (zero-trust audit finding)', () => {
  it('rejects the grant and revokes the whole family when the owning user is suspended, mirroring mcp-token suspension handling', async () => {
    seedRefreshRow();
    userSuspendedAt = new Date();

    const result = await refreshTokenGrant({
      refreshToken: REFRESH_TOKEN,
      clientDbId: CLIENT_DB_ID,
      requestedScope: null,
      now: new Date(),
    });

    expect(result).toEqual({ outcome: 'invalid_grant' });
    // No fresh pair minted for a suspended user's refresh attempt.
    expect(refreshRows).toHaveLength(1);
    expect(accessRows).toHaveLength(0);
    // The family is dead, not merely denied this once — a second attempt
    // (even after "unsuspension" edits the row back) must not somehow still
    // work off a family we left alive.
    expect(refreshRows[0].revokedAt).not.toBeNull();
    expect(refreshRows[0].revokedReason).toBe('user_suspended');
  });

  it('does not mint or rotate anything for a suspended user even under concurrent refresh attempts', async () => {
    seedRefreshRow();
    userSuspendedAt = new Date();

    const [first, second] = await Promise.all([
      refreshTokenGrant({ refreshToken: REFRESH_TOKEN, clientDbId: CLIENT_DB_ID, requestedScope: null, now: new Date() }),
      refreshTokenGrant({ refreshToken: REFRESH_TOKEN, clientDbId: CLIENT_DB_ID, requestedScope: null, now: new Date() }),
    ]);

    expect(first).toEqual({ outcome: 'invalid_grant' });
    expect(second).toEqual({ outcome: 'invalid_grant' });
    expect(refreshRows).toHaveLength(1);
    expect(accessRows).toHaveLength(0);
  });
});

describe('refreshTokenGrant — scope narrowing', () => {
  it('narrows scope on request and persists only the narrowed set on the new tokens', async () => {
    // Keep offline_access in the narrowed request so this test's focus (only
    // the narrowed set is persisted) stays independent of the F1 gate, which
    // has its own dedicated tests below. `account` and `drive:*` scopes are
    // mutually exclusive by grammar, so narrow among drive scopes instead.
    seedRefreshRow({ scopes: ['offline_access', 'drive:abc12345', 'drive:xyz98765'] });

    const result = await refreshTokenGrant({
      refreshToken: REFRESH_TOKEN,
      clientDbId: CLIENT_DB_ID,
      requestedScope: 'offline_access drive:abc12345',
      now: new Date(),
    });

    expect(result.outcome).toBe('ok');
    if (result.outcome !== 'ok') throw new Error('unreachable');
    expect(result.scopes).toEqual(['offline_access', 'drive:abc12345']);
    expect(refreshRows[1].scopes).toEqual(['offline_access', 'drive:abc12345']);
    expect(accessRows[0].scopes).toEqual(['offline_access', 'drive:abc12345']);
  });

  it('rejects any scope escalation attempt with invalid_scope', async () => {
    seedRefreshRow({ scopes: ['account'] });

    const result = await refreshTokenGrant({
      refreshToken: REFRESH_TOKEN,
      clientDbId: CLIENT_DB_ID,
      requestedScope: 'account drive:abc123',
      now: new Date(),
    });

    expect(result).toEqual({ outcome: 'invalid_scope' });
    // No tokens were rotated/minted for a rejected escalation attempt.
    expect(refreshRows).toHaveLength(1);
    expect(accessRows).toHaveLength(0);
  });
});

describe('refreshTokenGrant — concurrent refresh yields exactly one winner', () => {
  it('two simultaneous refreshes of the same token: exactly one ok, the other invalid_grant; only one new pair persisted', async () => {
    seedRefreshRow();

    const [first, second] = await Promise.all([
      refreshTokenGrant({ refreshToken: REFRESH_TOKEN, clientDbId: CLIENT_DB_ID, requestedScope: null, now: new Date() }),
      refreshTokenGrant({ refreshToken: REFRESH_TOKEN, clientDbId: CLIENT_DB_ID, requestedScope: null, now: new Date() }),
    ]);

    const outcomes = [first.outcome, second.outcome].sort();
    expect(outcomes).toEqual(['invalid_grant', 'ok']);

    // Family survives: this is a benign race, not attacker replay — the loser's
    // rejection must not revoke the winner's brand-new pair.
    const winner = first.outcome === 'ok' ? first : second;
    if (winner.outcome !== 'ok') throw new Error('unreachable');
    const winnerRow = refreshRows.find((r) => r.tokenHash === hashToken(winner.tokens.refreshToken!));
    expect(winnerRow?.revokedAt).toBeFalsy();

    expect(refreshRows).toHaveLength(2);
    expect(accessRows).toHaveLength(1);
  });
});

describe('refreshTokenGrant — F1: refresh token gated on offline_access', () => {
  it('narrowing the request scope to drop offline_access ends the family: rotated pair is access-only', async () => {
    seedRefreshRow({ scopes: ['account', 'offline_access'] });

    const result = await refreshTokenGrant({
      refreshToken: REFRESH_TOKEN,
      clientDbId: CLIENT_DB_ID,
      requestedScope: 'account',
      now: new Date(),
    });

    expect(result.outcome).toBe('ok');
    if (result.outcome !== 'ok') throw new Error('unreachable');
    expect(result.scopes).toEqual(['account']);
    expect(result.tokens.refreshToken).toBeUndefined();
    expect(result.tokens.accessToken).toMatch(/^ps_at_/);
    // The presented token is still revoked (rotation always consumes it),
    // but no new refresh row is inserted since the narrowed set has no
    // offline_access to carry forward.
    expect(refreshRows).toHaveLength(1);
    expect(refreshRows[0].revokedAt).not.toBeNull();
    expect(accessRows).toHaveLength(1);
    expect(accessRows[0].scopes).toEqual(['account']);
  });

  it('a terminal (access-only) rotation still marks replacedByTokenId non-null, so a benign in-window retry is NOT mistaken for reuse (Codex P2)', async () => {
    seedRefreshRow({ scopes: ['account', 'offline_access'] });

    const result = await refreshTokenGrant({
      refreshToken: REFRESH_TOKEN,
      clientDbId: CLIENT_DB_ID,
      requestedScope: 'account',
      now: new Date(),
    });

    expect(result.outcome).toBe('ok');
    // decideRefreshRotation's grace-window branch only applies when
    // replacedByTokenId !== null — without a marker here, ANY presentation of
    // this now-revoked token (even a benign dropped-connection retry inside
    // the 30s window) falls straight through to reuse_detected and revokes
    // the whole family, including the access token this call just issued.
    expect(refreshRows[0].replacedByTokenId).not.toBeNull();
  });

  it('a benign duplicate/retry within the grace window on a terminal rotation does NOT revoke the family (Codex P2)', async () => {
    seedRefreshRow({ scopes: ['account', 'offline_access'] });

    const t0 = new Date();
    const first = await refreshTokenGrant({
      refreshToken: REFRESH_TOKEN,
      clientDbId: CLIENT_DB_ID,
      requestedScope: 'account', // drops offline_access -> terminal, access-only
      now: t0,
    });
    expect(first.outcome).toBe('ok');
    if (first.outcome !== 'ok') throw new Error('unreachable');
    expect(first.tokens.refreshToken).toBeUndefined();

    // A benign duplicate/retry (e.g. a dropped-connection retry) presents the
    // SAME (now-revoked) old token again, within the 30s grace window.
    const retryNow = new Date(t0.getTime() + 5_000);
    const retry = await refreshTokenGrant({
      refreshToken: REFRESH_TOKEN,
      clientDbId: CLIENT_DB_ID,
      requestedScope: 'account',
      now: retryNow,
    });

    // The retry itself still fails — there's no grace cache to replay from
    // (deferred infra, same as the non-terminal case) — but critically the
    // family must NOT be revoked: the access token from the first
    // (successful) response must remain valid.
    expect(retry).toEqual({ outcome: 'invalid_grant' });
    expect(accessRows).toHaveLength(1);
    expect(accessRows[0].revokedAt).toBeFalsy();
  });

  it('keeps minting a refresh token across rotation while offline_access remains granted', async () => {
    seedRefreshRow({ scopes: ['account', 'offline_access'] });

    const result = await refreshTokenGrant({
      refreshToken: REFRESH_TOKEN,
      clientDbId: CLIENT_DB_ID,
      requestedScope: null,
      now: new Date(),
    });

    expect(result.outcome).toBe('ok');
    if (result.outcome !== 'ok') throw new Error('unreachable');
    expect(result.tokens.refreshToken).toMatch(/^ps_rt_/);
    expect(refreshRows).toHaveLength(2);
  });
});

describe('refreshTokenGrant — tokenVersion mismatch (global logout, ADR 0003 §6-§7)', () => {
  it('refuses a refresh whose snapshot tokenVersion no longer matches the user, WITHOUT revoking the family (logout ≠ theft)', async () => {
    seedRefreshRow({ tokenVersion: 1 });
    userTokenVersion = 2;

    const result = await refreshTokenGrant({
      refreshToken: REFRESH_TOKEN,
      clientDbId: CLIENT_DB_ID,
      requestedScope: null,
      now: new Date(),
    });

    expect(result).toEqual({ outcome: 'invalid_grant' });
    // Family untouched: not revoked, no new tokens minted, but the presented
    // token itself is also left alone (this is not a rotation, and not theft).
    expect(refreshRows).toHaveLength(1);
    expect(refreshRows[0].revokedAt).toBeNull();
    expect(accessRows).toHaveLength(0);
  });

  it('allows the refresh when the snapshot tokenVersion matches the user', async () => {
    seedRefreshRow({ tokenVersion: 2 });
    userTokenVersion = 2;

    const result = await refreshTokenGrant({
      refreshToken: REFRESH_TOKEN,
      clientDbId: CLIENT_DB_ID,
      requestedScope: null,
      now: new Date(),
    });

    expect(result.outcome).toBe('ok');
  });
});
