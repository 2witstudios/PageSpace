/**
 * Atomic authorization_code exchange (task suty9f9jbha82c0831e9rjec).
 *
 * The fake `db.transaction` below serializes callbacks on a shared in-memory
 * "row" — call B's callback does not start until call A's callback has fully
 * settled — which is precisely what a real `FOR UPDATE` lock on a single
 * contended row guarantees. That lets us exercise the real
 * `exchangeAuthorizationCode` control flow (not a stub) under a genuine
 * `Promise.all` race and assert exactly one winner.
 *
 * `eq`/`and` are mocked to structured markers (`{_eq:[col,val]}` /
 * `{_and:[...]}`) and `evalPredicate` below re-interprets them against the
 * in-memory row, so the client-scoping test genuinely exercises the
 * repository's `WHERE codeHash = ? AND clientId = ?` intent instead of
 * trusting an unconditional stub.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('server-only', () => ({}));

// vi.mock factories are hoisted above ALL other top-level statements in this
// file (not just imports) — `vi.hoisted` is the only reliable way to share a
// reference with them. `state.dbTransactionImpl` is a mutable indirection so
// the real fake-transaction implementation (defined further down, after
// `makeTx`/`evalPredicate` exist) can be wired in without the factory itself
// needing to reference anything not yet initialized at hoist time.
const H = vi.hoisted(() => ({
  oauthAuthorizationCodes: {
    __table: 'codes',
    id: 'codes.id',
    codeHash: 'codes.codeHash',
    clientId: 'codes.clientId',
    userId: 'codes.userId',
    scopes: 'codes.scopes',
    redirectUri: 'codes.redirectUri',
    codeChallenge: 'codes.codeChallenge',
    codeChallengeMethod: 'codes.codeChallengeMethod',
    expiresAt: 'codes.expiresAt',
    consumedAt: 'codes.consumedAt',
    issuedFamilyId: 'codes.issuedFamilyId',
  } as Record<string, unknown>,
  oauthRefreshTokens: { __table: 'refresh', familyId: 'rt.familyId', revokedAt: 'rt.revokedAt' } as Record<
    string,
    unknown
  >,
  oauthAccessTokens: { __table: 'access', familyId: 'at.familyId', revokedAt: 'at.revokedAt' } as Record<
    string,
    unknown
  >,
  usersTable: { __table: 'users', id: 'users.id' } as Record<string, unknown>,
  state: { dbTransactionImpl: null as null | ((cb: (tx: unknown) => unknown) => unknown) },
}));

const { oauthAuthorizationCodes, oauthRefreshTokens, oauthAccessTokens, usersTable } = H;

vi.mock('@pagespace/db/schema/oauth', () => ({
  oauthAuthorizationCodes: H.oauthAuthorizationCodes,
  oauthRefreshTokens: H.oauthRefreshTokens,
  oauthAccessTokens: H.oauthAccessTokens,
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

import { deriveCodeChallenge } from '@pagespace/lib/auth/oauth/pkce';
import { hashToken } from '@pagespace/lib/auth/token-utils';
import { exchangeAuthorizationCode } from '../oauth-repository';

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

interface CodeRow {
  id: string;
  codeHash: string;
  clientId: string;
  userId: string;
  scopes: string[];
  redirectUri: string;
  codeChallenge: string;
  codeChallengeMethod: string;
  expiresAt: Date;
  consumedAt: Date | null;
  issuedFamilyId: string | null;
}

interface TokenRow {
  tokenHash: string;
  tokenPrefix: string;
  familyId: string;
  clientId: string;
  userId: string;
  scopes: string[];
  tokenVersion: number;
  expiresAt: Date;
  familyExpiresAt?: Date;
  revokedAt: Date | null;
  revokedReason: string | null;
}

let codeRow: CodeRow | null = null;
let refreshRows: TokenRow[] = [];
let accessRows: TokenRow[] = [];
let userTokenVersion = 0;
let lockChain: Promise<unknown> = Promise.resolve();

function makeTx() {
  return {
    select: () => ({
      from: (table: unknown) => ({
        where: (predicate: Predicate) => {
          if (table === usersTable) {
            return Promise.resolve([{ tokenVersion: userTokenVersion }]);
          }
          const matches = codeRow && evalPredicate(predicate, codeRow as unknown as Record<string, unknown>);
          const rows = matches ? [{ ...codeRow }] : [];
          const p = Promise.resolve(rows) as Promise<CodeRow[]> & { for: (mode: string) => Promise<CodeRow[]> };
          p.for = () => p;
          return p;
        },
      }),
    }),
    update: (table: unknown) => ({
      set: (patch: Record<string, unknown>) => ({
        where: () => {
          if (table === oauthAuthorizationCodes && codeRow) {
            Object.assign(codeRow, patch);
          } else if (table === oauthRefreshTokens) {
            refreshRows.forEach((r) => {
              if (!r.revokedAt) Object.assign(r, patch);
            });
          } else if (table === oauthAccessTokens) {
            accessRows.forEach((r) => {
              if (!r.revokedAt) Object.assign(r, patch);
            });
          }
          return Promise.resolve();
        },
      }),
    }),
    insert: (table: unknown) => ({
      values: (row: TokenRow) => {
        if (table === oauthRefreshTokens) refreshRows.push({ ...row });
        else if (table === oauthAccessTokens) accessRows.push({ ...row });
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

const CODE = 'raw-authorization-code-value';
const CODE_VERIFIER = 'a'.repeat(43);
const REDIRECT_URI = 'http://127.0.0.1:51234/callback';
const CLIENT_DB_ID = 'client-db-id-1';
const USER_ID = 'user-1';

function seedCodeRow(overrides: Partial<CodeRow> = {}): void {
  codeRow = {
    id: 'code-row-1',
    codeHash: hashToken(CODE),
    clientId: CLIENT_DB_ID,
    userId: USER_ID,
    scopes: ['account'],
    redirectUri: REDIRECT_URI,
    codeChallenge: deriveCodeChallenge(CODE_VERIFIER),
    codeChallengeMethod: 'S256',
    expiresAt: new Date(Date.now() + 60_000),
    consumedAt: null,
    issuedFamilyId: null,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  codeRow = null;
  refreshRows = [];
  accessRows = [];
  userTokenVersion = 0;
  lockChain = Promise.resolve();
});

describe('exchangeAuthorizationCode — happy path', () => {
  it('consumes the code and issues a hashed ps_at_*/ps_rt_* token pair', async () => {
    seedCodeRow();

    const result = await exchangeAuthorizationCode({
      code: CODE,
      redirectUri: REDIRECT_URI,
      codeVerifier: CODE_VERIFIER,
      clientDbId: CLIENT_DB_ID,
      now: new Date(),
    });

    expect(result.outcome).toBe('ok');
    if (result.outcome !== 'ok') throw new Error('unreachable');
    expect(result.userId).toBe(USER_ID);
    expect(result.scopes).toEqual(['account']);
    expect(result.tokens.accessToken).toMatch(/^ps_at_/);
    expect(result.tokens.refreshToken).toMatch(/^ps_rt_/);

    expect(codeRow?.consumedAt).not.toBeNull();
    expect(codeRow?.issuedFamilyId).toBe(result.tokens.familyId);
    expect(refreshRows).toHaveLength(1);
    expect(accessRows).toHaveLength(1);
    expect(refreshRows[0].tokenHash).toBe(hashToken(result.tokens.refreshToken));
    expect(accessRows[0].tokenHash).toBe(hashToken(result.tokens.accessToken));
  });

  it('looks up the code by hash and never persists the raw code anywhere', async () => {
    seedCodeRow();

    await exchangeAuthorizationCode({
      code: CODE,
      redirectUri: REDIRECT_URI,
      codeVerifier: CODE_VERIFIER,
      clientDbId: CLIENT_DB_ID,
      now: new Date(),
    });

    const serialized = JSON.stringify({ refreshRows, accessRows, codeRow });
    expect(serialized).not.toContain(CODE);
  });
});

describe('exchangeAuthorizationCode — rejections', () => {
  it('returns not_found for an unknown code', async () => {
    codeRow = null;

    const result = await exchangeAuthorizationCode({
      code: 'never-issued',
      redirectUri: REDIRECT_URI,
      codeVerifier: CODE_VERIFIER,
      clientDbId: CLIENT_DB_ID,
      now: new Date(),
    });

    expect(result.outcome).toBe('not_found');
  });

  it('returns not_found when the code belongs to a different client (scoped lookup, no oracle)', async () => {
    seedCodeRow({ clientId: 'some-other-client-db-id' });

    const result = await exchangeAuthorizationCode({
      code: CODE,
      redirectUri: REDIRECT_URI,
      codeVerifier: CODE_VERIFIER,
      clientDbId: CLIENT_DB_ID,
      now: new Date(),
    });

    expect(result.outcome).toBe('not_found');
  });

  it('returns rejected(expired) for an expired code', async () => {
    seedCodeRow({ expiresAt: new Date(Date.now() - 1000) });

    const result = await exchangeAuthorizationCode({
      code: CODE,
      redirectUri: REDIRECT_URI,
      codeVerifier: CODE_VERIFIER,
      clientDbId: CLIENT_DB_ID,
      now: new Date(),
    });

    expect(result).toEqual({ outcome: 'rejected', decision: { status: 'expired' } });
  });

  it('returns rejected(redirect_mismatch) for a mismatched redirect_uri', async () => {
    seedCodeRow();

    const result = await exchangeAuthorizationCode({
      code: CODE,
      redirectUri: 'http://127.0.0.1:9999/callback',
      codeVerifier: CODE_VERIFIER,
      clientDbId: CLIENT_DB_ID,
      now: new Date(),
    });

    expect(result).toEqual({ outcome: 'rejected', decision: { status: 'redirect_mismatch' } });
  });

  it('returns rejected(pkce_failed) for a wrong code_verifier', async () => {
    seedCodeRow();

    const result = await exchangeAuthorizationCode({
      code: CODE,
      redirectUri: REDIRECT_URI,
      codeVerifier: 'b'.repeat(43),
      clientDbId: CLIENT_DB_ID,
      now: new Date(),
    });

    expect(result).toEqual({ outcome: 'rejected', decision: { status: 'pkce_failed' } });
  });
});

describe('exchangeAuthorizationCode — atomic single-use consumption under a race', () => {
  it('exactly one of two concurrent exchanges of the same code succeeds', async () => {
    seedCodeRow();

    const [first, second] = await Promise.all([
      exchangeAuthorizationCode({
        code: CODE,
        redirectUri: REDIRECT_URI,
        codeVerifier: CODE_VERIFIER,
        clientDbId: CLIENT_DB_ID,
        now: new Date(),
      }),
      exchangeAuthorizationCode({
        code: CODE,
        redirectUri: REDIRECT_URI,
        codeVerifier: CODE_VERIFIER,
        clientDbId: CLIENT_DB_ID,
        now: new Date(),
      }),
    ]);

    const outcomes = [first.outcome, second.outcome].sort();
    expect(outcomes).toEqual(['ok', 'rejected']);

    const rejected = first.outcome === 'rejected' ? first : second;
    if (rejected.outcome !== 'rejected') throw new Error('unreachable');
    expect(rejected.decision).toEqual({ status: 'already_consumed', revokeIssuedTokens: true });

    // Only one token pair was ever persisted.
    expect(refreshRows).toHaveLength(1);
    expect(accessRows).toHaveLength(1);
  });

  it('reuse (code presented a second time after full consumption) revokes every token issued from that code', async () => {
    seedCodeRow();

    const first = await exchangeAuthorizationCode({
      code: CODE,
      redirectUri: REDIRECT_URI,
      codeVerifier: CODE_VERIFIER,
      clientDbId: CLIENT_DB_ID,
      now: new Date(),
    });
    expect(first.outcome).toBe('ok');

    expect(refreshRows[0].revokedAt).toBeFalsy();
    expect(accessRows[0].revokedAt).toBeFalsy();

    const second = await exchangeAuthorizationCode({
      code: CODE,
      redirectUri: REDIRECT_URI,
      codeVerifier: CODE_VERIFIER,
      clientDbId: CLIENT_DB_ID,
      now: new Date(),
    });

    expect(second).toEqual({
      outcome: 'rejected',
      decision: { status: 'already_consumed', revokeIssuedTokens: true },
    });
    expect(refreshRows[0].revokedAt).not.toBeNull();
    expect(accessRows[0].revokedAt).not.toBeNull();
    // No new tokens were minted for the replay.
    expect(refreshRows).toHaveLength(1);
    expect(accessRows).toHaveLength(1);
  });
});
