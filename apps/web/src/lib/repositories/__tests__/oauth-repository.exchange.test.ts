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

// `exchangeAuthorizationCode`'s pure-drive-grant branch calls
// `sessionRepository.createMcpTokenWithDriveScopes` — mocked at the
// repository seam (the established pattern this codebase already uses for
// this exact function, see apps/web/src/app/api/auth/mcp-tokens/__tests__/route.test.ts)
// rather than extending this file's hand-rolled fake-DB harness to also
// model the mcp_tokens/mcp_token_drives tables `createMcpTokenWithDriveScopes`
// itself already has its own dedicated coverage against.
vi.mock('../session-repository', () => ({
  sessionRepository: {
    createMcpTokenWithDriveScopes: vi.fn(),
    updateMcpTokenDriveScopes: vi.fn(),
    findUserMcpTokensWithDrives: vi.fn(),
  },
}));

import { deriveCodeChallenge } from '@pagespace/lib/auth/oauth/pkce';
import { hashToken } from '@pagespace/lib/auth/token-utils';
import { parseScopeList, formatScopeSet, type ScopeSet } from '@pagespace/lib/auth/oauth/scopes';
import { exchangeAuthorizationCode } from '../oauth-repository';
import { sessionRepository } from '../session-repository';

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
let userSuspendedAt: Date | null = null;
let lockChain: Promise<unknown> = Promise.resolve();

function makeTx() {
  return {
    select: () => ({
      from: (table: unknown) => ({
        where: (predicate: Predicate) => {
          if (table === usersTable) {
            return Promise.resolve([{ tokenVersion: userTokenVersion, suspendedAt: userSuspendedAt }]);
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
    // offline_access included by default so the pre-existing happy-path
    // fixtures below exercise refresh-token issuance as before; the F1 gate
    // tests further down explicitly override this to exercise access-only.
    scopes: ['account', 'offline_access'],
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
  userSuspendedAt = null;
  lockChain = Promise.resolve();
  vi.mocked(sessionRepository.createMcpTokenWithDriveScopes).mockResolvedValue({
    id: 'mcp-token-row-1',
    userId: USER_ID,
    tokenHash: 'unused-in-these-assertions',
    tokenPrefix: 'mcp_xxxxxxxxxxx',
    name: 'unused-in-these-assertions',
    isScoped: true,
    createdAt: new Date(),
    lastUsed: null,
    revokedAt: null,
  } as never);
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
    expect(result.scopes).toEqual(['account', 'offline_access']);
    expect(result.tokens.accessToken).toMatch(/^ps_at_/);
    expect(result.tokens.refreshToken).toMatch(/^ps_rt_/);

    expect(codeRow?.consumedAt).not.toBeNull();
    expect(codeRow?.issuedFamilyId).toBe(result.tokens.familyId);
    expect(refreshRows).toHaveLength(1);
    expect(accessRows).toHaveLength(1);
    expect(refreshRows[0].tokenHash).toBe(hashToken(result.tokens.refreshToken!));
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

describe('exchangeAuthorizationCode — suspended user (zero-trust audit finding)', () => {
  it('rejects the exchange and mints no tokens when the code owner is suspended', async () => {
    seedCodeRow();
    userSuspendedAt = new Date();

    const result = await exchangeAuthorizationCode({
      code: CODE,
      redirectUri: REDIRECT_URI,
      codeVerifier: CODE_VERIFIER,
      clientDbId: CLIENT_DB_ID,
      now: new Date(),
    });

    expect(result).toEqual({ outcome: 'user_suspended' });
    expect(refreshRows).toHaveLength(0);
    expect(accessRows).toHaveLength(0);
    // Single-use still holds: the code is consumed, not left replayable.
    expect(codeRow?.consumedAt).not.toBeNull();
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

describe('exchangeAuthorizationCode — F1: refresh token gated on offline_access', () => {
  it('mints an access-only grant (no refresh row, no refresh_token) when offline_access was not requested', async () => {
    seedCodeRow({ scopes: ['account'] });

    const result = await exchangeAuthorizationCode({
      code: CODE,
      redirectUri: REDIRECT_URI,
      codeVerifier: CODE_VERIFIER,
      clientDbId: CLIENT_DB_ID,
      now: new Date(),
    });

    expect(result.outcome).toBe('ok');
    if (result.outcome !== 'ok') throw new Error('unreachable');
    expect(result.tokens.accessToken).toMatch(/^ps_at_/);
    expect(result.tokens.refreshToken).toBeUndefined();
    expect(refreshRows).toHaveLength(0);
    expect(accessRows).toHaveLength(1);
    expect(codeRow?.issuedFamilyId).toBe(result.tokens.familyId);
  });

  it('mints a refresh token when offline_access was requested', async () => {
    seedCodeRow({ scopes: ['account', 'offline_access'] });

    const result = await exchangeAuthorizationCode({
      code: CODE,
      redirectUri: REDIRECT_URI,
      codeVerifier: CODE_VERIFIER,
      clientDbId: CLIENT_DB_ID,
      now: new Date(),
    });

    expect(result.outcome).toBe('ok');
    if (result.outcome !== 'ok') throw new Error('unreachable');
    expect(result.tokens.refreshToken).toMatch(/^ps_rt_/);
    expect(refreshRows).toHaveLength(1);
    expect(accessRows).toHaveLength(1);
  });
});

describe('exchangeAuthorizationCode — pure drive:* grant mints a real mcp_tokens row, not an OAuth pair', () => {
  it('returns ok_mcp_token, mints via sessionRepository against the SAME transaction, and issues zero oauth rows', async () => {
    seedCodeRow({ scopes: ['drive:drv1:member', 'drive:drv2:admin', 'name:My%20Laptop', 'offline_access'] });

    const result = await exchangeAuthorizationCode({
      code: CODE,
      redirectUri: REDIRECT_URI,
      codeVerifier: CODE_VERIFIER,
      clientDbId: CLIENT_DB_ID,
      now: new Date(),
    });

    expect(result.outcome).toBe('ok_mcp_token');
    if (result.outcome !== 'ok_mcp_token') throw new Error('unreachable');
    expect(result.userId).toBe(USER_ID);
    expect(result.scopes).toEqual(['drive:drv1:member', 'drive:drv2:admin', 'name:My%20Laptop', 'offline_access']);
    expect(result.mcpToken).toMatch(/^mcp_/);

    // No OAuth refresh/access-token-family rows for this branch at all.
    expect(refreshRows).toHaveLength(0);
    expect(accessRows).toHaveLength(0);
    // The code is still consumed (single-use), but no family was issued.
    expect(codeRow?.consumedAt).not.toBeNull();
    expect(codeRow?.issuedFamilyId).toBeNull();

    expect(sessionRepository.createMcpTokenWithDriveScopes).toHaveBeenCalledTimes(1);
    const [data, txArg] = vi.mocked(sessionRepository.createMcpTokenWithDriveScopes).mock.calls[0]!;
    expect(data).toMatchObject({
      userId: USER_ID,
      name: 'My Laptop',
      isScoped: true,
      drives: [
        { id: 'drv1', role: 'MEMBER' },
        { id: 'drv2', role: 'ADMIN' },
      ],
    });
    expect(typeof data.tokenHash).toBe('string');
    expect(data.tokenHash.length).toBeGreaterThan(0);
    expect(data.tokenPrefix.length).toBeGreaterThan(0);
    // Threaded through the SAME transaction client exchangeAuthorizationCode
    // itself is running in — not a second, independent transaction (would
    // risk an orphaned mcp_tokens row if the outer one ever rolled back).
    expect(txArg).toBeDefined();
    expect(hashToken(result.mcpToken)).toBe(data.tokenHash);
  });

  it('manage_keys/account grants (pagespace login) are completely unaffected — still the OAuth pair, sessionRepository never called', async () => {
    seedCodeRow({ scopes: ['manage_keys', 'offline_access'] });

    const result = await exchangeAuthorizationCode({
      code: CODE,
      redirectUri: REDIRECT_URI,
      codeVerifier: CODE_VERIFIER,
      clientDbId: CLIENT_DB_ID,
      now: new Date(),
    });

    expect(result.outcome).toBe('ok');
    if (result.outcome !== 'ok') throw new Error('unreachable');
    expect(result.tokens.refreshToken).toMatch(/^ps_rt_/);
    expect(refreshRows).toHaveLength(1);
    expect(accessRows).toHaveLength(1);
    expect(sessionRepository.createMcpTokenWithDriveScopes).not.toHaveBeenCalled();
  });
});

describe('exchangeAuthorizationCode — all_drives grant mints a real, unscoped mcp_tokens row, not an OAuth pair', () => {
  it('returns ok_mcp_token with isScoped: false and zero drive rows, against the SAME transaction, issuing zero oauth rows', async () => {
    seedCodeRow({ scopes: ['all_drives', 'name:God%20Key', 'offline_access'] });

    const result = await exchangeAuthorizationCode({
      code: CODE,
      redirectUri: REDIRECT_URI,
      codeVerifier: CODE_VERIFIER,
      clientDbId: CLIENT_DB_ID,
      now: new Date(),
    });

    expect(result.outcome).toBe('ok_mcp_token');
    if (result.outcome !== 'ok_mcp_token') throw new Error('unreachable');
    expect(result.userId).toBe(USER_ID);
    expect(result.scopes).toEqual(['all_drives', 'name:God%20Key', 'offline_access']);
    expect(result.mcpToken).toMatch(/^mcp_/);

    // No OAuth refresh/access-token-family rows for this branch at all.
    expect(refreshRows).toHaveLength(0);
    expect(accessRows).toHaveLength(0);
    // The code is still consumed (single-use), but no family was issued.
    expect(codeRow?.consumedAt).not.toBeNull();
    expect(codeRow?.issuedFamilyId).toBeNull();

    expect(sessionRepository.createMcpTokenWithDriveScopes).toHaveBeenCalledTimes(1);
    const [data, txArg] = vi.mocked(sessionRepository.createMcpTokenWithDriveScopes).mock.calls[0]!;
    expect(data).toMatchObject({
      userId: USER_ID,
      name: 'God Key',
      isScoped: false,
      drives: [],
    });
    expect(typeof data.tokenHash).toBe('string');
    expect(data.tokenHash.length).toBeGreaterThan(0);
    expect(data.tokenPrefix.length).toBeGreaterThan(0);
    expect(txArg).toBeDefined();
    expect(hashToken(result.mcpToken)).toBe(data.tokenHash);
  });

  it('account grants (pagespace login) are completely unaffected — still the OAuth pair, sessionRepository never called', async () => {
    seedCodeRow({ scopes: ['account', 'offline_access'] });

    const result = await exchangeAuthorizationCode({
      code: CODE,
      redirectUri: REDIRECT_URI,
      codeVerifier: CODE_VERIFIER,
      clientDbId: CLIENT_DB_ID,
      now: new Date(),
    });

    expect(result.outcome).toBe('ok');
    if (result.outcome !== 'ok') throw new Error('unreachable');
    expect(result.tokens.refreshToken).toMatch(/^ps_rt_/);
    expect(refreshRows).toHaveLength(1);
    expect(accessRows).toHaveLength(1);
    expect(sessionRepository.createMcpTokenWithDriveScopes).not.toHaveBeenCalled();
  });
});

describe('exchangeAuthorizationCode — update_key grant re-scopes an existing mcp token in place', () => {
  const UPDATE_SCOPES = ['update_key:tok123', 'drive:drv1:member', 'drive:drv2:admin'];

  function mockUpdateResult(value: unknown): void {
    vi.mocked(sessionRepository.updateMcpTokenDriveScopes).mockResolvedValue(value as never);
  }

  it('returns ok_mcp_update, applies the scope replacement via sessionRepository against the SAME transaction, mints nothing', async () => {
    seedCodeRow({ scopes: UPDATE_SCOPES });
    mockUpdateResult({ id: 'tok123', isScoped: true });

    const result = await exchangeAuthorizationCode({
      code: CODE,
      redirectUri: REDIRECT_URI,
      codeVerifier: CODE_VERIFIER,
      clientDbId: CLIENT_DB_ID,
      now: new Date(),
    });

    expect(result.outcome).toBe('ok_mcp_update');
    if (result.outcome !== 'ok_mcp_update') throw new Error('unreachable');
    expect(result.userId).toBe(USER_ID);
    expect(result.tokenId).toBe('tok123');
    expect(result.scopes).toEqual(UPDATE_SCOPES);

    // Nothing minted anywhere: no oauth family rows, no mcp_tokens mint.
    expect(refreshRows).toHaveLength(0);
    expect(accessRows).toHaveLength(0);
    expect(sessionRepository.createMcpTokenWithDriveScopes).not.toHaveBeenCalled();

    // The code is consumed (single-use) with no issued family — replay hits
    // already_consumed with nothing to revoke.
    expect(codeRow?.consumedAt).not.toBeNull();
    expect(codeRow?.issuedFamilyId).toBeNull();

    expect(sessionRepository.updateMcpTokenDriveScopes).toHaveBeenCalledTimes(1);
    const [tokenId, userId, drives, txArg] = vi.mocked(sessionRepository.updateMcpTokenDriveScopes).mock.calls[0]!;
    expect(tokenId).toBe('tok123');
    // The CONSENTING user bound into the code row — nothing the client
    // presents at exchange can retarget the update at another user's token.
    expect(userId).toBe(USER_ID);
    expect(drives).toEqual([
      { id: 'drv1', role: 'MEMBER', customRoleId: undefined },
      { id: 'drv2', role: 'ADMIN', customRoleId: undefined },
    ]);
    // Same transaction client, not a second independent transaction.
    expect(txArg).toBeDefined();
  });

  it('fails closed as update_target_gone (route: invalid_grant) when the target was revoked between consent and exchange, still consuming the code', async () => {
    seedCodeRow({ scopes: UPDATE_SCOPES });
    mockUpdateResult(null);

    const result = await exchangeAuthorizationCode({
      code: CODE,
      redirectUri: REDIRECT_URI,
      codeVerifier: CODE_VERIFIER,
      clientDbId: CLIENT_DB_ID,
      now: new Date(),
    });

    expect(result.outcome).toBe('update_target_gone');
    expect(codeRow?.consumedAt).not.toBeNull();
    expect(refreshRows).toHaveLength(0);
    expect(accessRows).toHaveLength(0);
  });

  it('replaying the consumed update code is already_consumed with no token family to revoke', async () => {
    seedCodeRow({ scopes: UPDATE_SCOPES });
    mockUpdateResult({ id: 'tok123', isScoped: true });

    const input = { code: CODE, redirectUri: REDIRECT_URI, codeVerifier: CODE_VERIFIER, clientDbId: CLIENT_DB_ID, now: new Date() };
    const first = await exchangeAuthorizationCode(input);
    expect(first.outcome).toBe('ok_mcp_update');

    const replay = await exchangeAuthorizationCode(input);
    expect(replay.outcome).toBe('rejected');
    if (replay.outcome !== 'rejected') throw new Error('unreachable');
    expect(replay.decision.status).toBe('already_consumed');
    // No second scope update fired.
    expect(sessionRepository.updateMcpTokenDriveScopes).toHaveBeenCalledTimes(1);
  });
});

describe('parseScopeList — name: token grammar (the fix for the "pagespace CLI" name-loss bug)', () => {
  // Deliberately NOT requiring a name: token to parse a mint-shaped grant here — this parser is
  // reused by flows (device-authorization's plain drive:*/all_drives grants) that never mint an
  // mcp_tokens row and legitimately carry no name. The "name required to mint" rule is enforced
  // instead at POST /api/oauth/authorize (see that route's test suite), the one call site that
  // actually mints from this shape via the loopback consent flow.
  it('accepts a mint-shaped grant (drive:*) with no name: token — not this parser\'s job to require one', () => {
    const result = parseScopeList('drive:drv1:member offline_access');
    expect(result.ok).toBe(true);
  });

  it('accepts a mint-shaped grant (all_drives) with no name: token — not this parser\'s job to require one', () => {
    const result = parseScopeList('all_drives offline_access');
    expect(result.ok).toBe(true);
  });

  it.each(['account', 'manage_keys', 'update_key:tok123 drive:drv1', 'activate_key:tok123'])(
    'rejects a name: token attached to %s',
    (scope) => {
      const result = parseScopeList(`${scope} name:Foo`);
      expect(result).toEqual({ ok: false, error: { code: 'name_without_mint_grant' } });
    },
  );
});

describe('exchangeAuthorizationCode — end-to-end name round trip (pagespace keys create --name X → keys list)', () => {
  it('a custom name given at authorize time survives the round trip through mint and back through the read-back seam', async () => {
    const CHOSEN_NAME = 'My Laptop (dev)';

    // 1. Build the scope string exactly as the CLI's buildTokenScope would —
    //    via the canonical grammar's own serializer.
    const requested: ScopeSet = {
      account: false,
      offlineAccess: true,
      manageKeys: false,
      allDrives: false,
      updateKeyId: null,
      activateKeyId: null,
      newKeyName: CHOSEN_NAME,
      drives: new Map([['drv1', { kind: 'drive', driveId: 'drv1', role: { kind: 'inherit' } }]]),
    };
    const wireScope = formatScopeSet(requested);

    // 2. Parse it back — proves the wire format round-trips through the grammar.
    const parsedBack = parseScopeList(wireScope);
    expect(parsedBack).toEqual({ ok: true, scopes: requested });

    // 3. Exchange it — the mint call must receive the REAL custom name, not
    //    the historical 'pagespace CLI' hardcode.
    seedCodeRow({ scopes: wireScope.split(' ') });
    let capturedName: string | null = null;
    vi.mocked(sessionRepository.createMcpTokenWithDriveScopes).mockImplementation(async (data) => {
      capturedName = data.name;
      return {
        id: 'mcp-token-row-1',
        userId: USER_ID,
        tokenHash: data.tokenHash,
        tokenPrefix: data.tokenPrefix,
        name: data.name,
        isScoped: data.isScoped,
        createdAt: new Date(),
        lastUsed: null,
        revokedAt: null,
      } as never;
    });

    const result = await exchangeAuthorizationCode({
      code: CODE,
      redirectUri: REDIRECT_URI,
      codeVerifier: CODE_VERIFIER,
      clientDbId: CLIENT_DB_ID,
      now: new Date(),
    });

    expect(result.outcome).toBe('ok_mcp_token');
    expect(capturedName).toBe(CHOSEN_NAME);

    // 4. Read it back through the same repository seam `GET
    //    /api/auth/mcp-tokens` (`keys list`) uses — proves the name that was
    //    actually persisted (not a hardcoded default) is what a real "keys
    //    list" call would surface.
    vi.mocked(sessionRepository.findUserMcpTokensWithDrives).mockResolvedValue([
      {
        id: 'mcp-token-row-1',
        name: capturedName!,
        tokenPrefix: 'mcp_xxxxxxxxxxx',
        lastUsed: null,
        createdAt: new Date(),
        isScoped: true,
        driveScopes: [],
      },
    ] as never);
    const listed = await sessionRepository.findUserMcpTokensWithDrives(USER_ID);
    expect(listed[0].name).toBe(CHOSEN_NAME);
  });
});
