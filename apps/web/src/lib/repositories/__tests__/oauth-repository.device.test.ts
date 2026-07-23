/**
 * Device authorization grant persistence (task mwexjazwha2uhw5bmvc9a7kw):
 * `createDeviceAuthorization`, `pollDeviceToken`, `verifyDeviceUserCode`,
 * `recordDeviceApproval`. Mirrors the fake-transaction harness in
 * `oauth-repository.exchange.test.ts` — `eq`/`and` are mocked to structured
 * markers and `evalPredicate` re-interprets them against an in-memory row, so
 * client-scoped lookups genuinely exercise the WHERE intent instead of
 * trusting an unconditional stub.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('server-only', () => ({}));

const H = vi.hoisted(() => ({
  oauthDeviceCodes: {
    __table: 'device_codes',
    id: 'device_codes.id',
    deviceCodeHash: 'device_codes.deviceCodeHash',
    userCodeHash: 'device_codes.userCodeHash',
    clientId: 'device_codes.clientId',
    userId: 'device_codes.userId',
    scopes: 'device_codes.scopes',
    expiresAt: 'device_codes.expiresAt',
    approvedAt: 'device_codes.approvedAt',
    deniedAt: 'device_codes.deniedAt',
    redeemedAt: 'device_codes.redeemedAt',
    lastPolledAt: 'device_codes.lastPolledAt',
    pollIntervalSeconds: 'device_codes.pollIntervalSeconds',
  } as Record<string, unknown>,
  oauthClients: {
    __table: 'clients',
    id: 'clients.id',
    clientId: 'clients.clientId',
  } as Record<string, unknown>,
  oauthRefreshTokens: { __table: 'refresh', familyId: 'rt.familyId' } as Record<string, unknown>,
  oauthAccessTokens: { __table: 'access', familyId: 'at.familyId' } as Record<string, unknown>,
  usersTable: { __table: 'users', id: 'users.id' } as Record<string, unknown>,
  state: { dbTransactionImpl: null as null | ((cb: (tx: unknown) => unknown) => unknown) },
}));

const { oauthDeviceCodes, usersTable } = H;

vi.mock('@pagespace/db/schema/oauth', () => ({
  oauthDeviceCodes: H.oauthDeviceCodes,
  oauthClients: H.oauthClients,
  oauthRefreshTokens: H.oauthRefreshTokens,
  oauthAccessTokens: H.oauthAccessTokens,
}));
vi.mock('@pagespace/db/schema/auth', () => ({
  users: H.usersTable,
}));
// `applyKeyGrant` (shared with the authorization-code exchange) delegates the
// actual mcp_tokens writes to sessionRepository, which has its own dedicated
// coverage — mocked here rather than extending this harness to model those
// tables too.
vi.mock('../session-repository', () => ({
  sessionRepository: {
    createMcpTokenWithDriveScopes: vi.fn(),
    updateMcpTokenDriveScopes: vi.fn(),
    findActiveMcpTokenByIdAndUser: vi.fn(),
    findUserMcpTokensWithDrives: vi.fn(),
  },
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

interface DeviceRow {
  id: string;
  deviceCodeHash: string;
  userCodeHash: string;
  clientId: string;
  userId: string | null;
  scopes: string[];
  expiresAt: Date;
  approvedAt: Date | null;
  deniedAt: Date | null;
  redeemedAt: Date | null;
  lastPolledAt: Date | null;
  pollIntervalSeconds: number;
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
}

let deviceRow: DeviceRow | null = null;
let insertedDeviceRows: Record<string, unknown>[] = [];
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
          const matches = deviceRow && evalPredicate(predicate, deviceRow as unknown as Record<string, unknown>);
          const rows = matches ? [{ ...deviceRow }] : [];
          const p = Promise.resolve(rows) as Promise<DeviceRow[]> & { for: (mode: string) => Promise<DeviceRow[]> };
          p.for = () => p;
          return p;
        },
      }),
    }),
    update: (table: unknown) => ({
      set: (patch: Record<string, unknown>) => ({
        where: () => {
          if (table === oauthDeviceCodes && deviceRow) {
            Object.assign(deviceRow, patch);
          }
          return Promise.resolve();
        },
      }),
    }),
    insert: (table: unknown) => ({
      values: (row: TokenRow) => {
        if (table === H.oauthRefreshTokens) refreshRows.push({ ...row });
        else if (table === H.oauthAccessTokens) accessRows.push({ ...row });
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
    insert: (table: unknown) => ({
      values: (row: Record<string, unknown>) => {
        if (table === oauthDeviceCodes) insertedDeviceRows.push({ ...row });
        return Promise.resolve();
      },
    }),
    select: () => ({
      from: (table: unknown) => ({
        innerJoin: (_joinTable: unknown, _on: unknown) => ({
          where: (predicate: Predicate) => {
            if (table !== oauthDeviceCodes) return Promise.resolve([]);
            const matches = deviceRow && evalPredicate(predicate, deviceRow as unknown as Record<string, unknown>);
            if (!matches || !deviceRow) return Promise.resolve([]);
            return Promise.resolve([
              {
                scopes: deviceRow.scopes,
                expiresAt: deviceRow.expiresAt,
                approvedAt: deviceRow.approvedAt,
                deniedAt: deviceRow.deniedAt,
                clientStringId: 'pagespace-cli',
              },
            ]);
          },
        }),
      }),
    }),
  },
}));

import { hashToken } from '@pagespace/lib/auth/token-utils';
import {
  createDeviceAuthorization,
  pollDeviceToken,
  verifyDeviceUserCode,
  recordDeviceApproval,
} from '../oauth-repository';
import { sessionRepository } from '../session-repository';

const DEVICE_CODE = 'raw-device-code-value';
const USER_CODE = 'ABCDEFGH';
const CLIENT_DB_ID = 'client-db-id-1';
const USER_ID = 'user-1';

function seedDeviceRow(overrides: Partial<DeviceRow> = {}): void {
  deviceRow = {
    id: 'device-row-1',
    deviceCodeHash: hashToken(DEVICE_CODE),
    userCodeHash: hashToken(USER_CODE),
    clientId: CLIENT_DB_ID,
    userId: null,
    scopes: ['account'],
    expiresAt: new Date(Date.now() + 1800_000),
    approvedAt: null,
    deniedAt: null,
    redeemedAt: null,
    lastPolledAt: null,
    pollIntervalSeconds: 5,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  deviceRow = null;
  insertedDeviceRows = [];
  refreshRows = [];
  accessRows = [];
  userTokenVersion = 0;
  userSuspendedAt = null;
  lockChain = Promise.resolve();
});

describe('createDeviceAuthorization', () => {
  it('persists only the hashed device_code and user_code, never raw values', async () => {
    await createDeviceAuthorization({
      clientDbId: CLIENT_DB_ID,
      scopes: ['account'],
      deviceCodeHash: hashToken(DEVICE_CODE),
      deviceCodePrefix: 'ps_dc_abcd',
      userCodeHash: hashToken(USER_CODE),
      userCodePrefix: 'ABCD',
      expiresAt: new Date(Date.now() + 1800_000),
      pollIntervalSeconds: 5,
    });

    expect(insertedDeviceRows).toHaveLength(1);
    const row = insertedDeviceRows[0];
    expect(row.deviceCodeHash).toBe(hashToken(DEVICE_CODE));
    expect(row.userCodeHash).toBe(hashToken(USER_CODE));
    expect(JSON.stringify(row)).not.toContain(DEVICE_CODE);
    expect(JSON.stringify(row)).not.toContain(USER_CODE);
  });
});

describe('pollDeviceToken', () => {
  it('returns not_found for an unknown device_code', async () => {
    deviceRow = null;
    const result = await pollDeviceToken({ deviceCode: 'never-issued', clientDbId: CLIENT_DB_ID, now: new Date() });
    expect(result).toEqual({ outcome: 'not_found' });
  });

  it('returns not_found when the device_code belongs to a different client (scoped lookup, no oracle)', async () => {
    seedDeviceRow({ clientId: 'some-other-client-db-id' });
    const result = await pollDeviceToken({ deviceCode: DEVICE_CODE, clientDbId: CLIENT_DB_ID, now: new Date() });
    expect(result).toEqual({ outcome: 'not_found' });
  });

  it('returns authorization_pending on the first poll and persists lastPolledAt', async () => {
    seedDeviceRow();
    const now = new Date();
    const result = await pollDeviceToken({ deviceCode: DEVICE_CODE, clientDbId: CLIENT_DB_ID, now });

    expect(result).toEqual({ outcome: 'authorization_pending' });
    expect(deviceRow?.lastPolledAt).toEqual(now);
  });

  it('returns slow_down when polling faster than the interval, and does NOT reset the anchor', async () => {
    const first = new Date();
    seedDeviceRow({ lastPolledAt: first, pollIntervalSeconds: 5 });

    const tooSoon = new Date(first.getTime() + 2000);
    const result = await pollDeviceToken({ deviceCode: DEVICE_CODE, clientDbId: CLIENT_DB_ID, now: tooSoon });

    expect(result).toEqual({ outcome: 'slow_down' });
    // The anchor stays at `first` — a throttled poll must not buy the client
    // a fresh countdown, or tight retries could push it forward forever.
    expect(deviceRow?.lastPolledAt).toEqual(first);
  });

  it('enforces the throttle across separate polls via the persisted lastPolledAt', async () => {
    seedDeviceRow({ pollIntervalSeconds: 5 });
    const t0 = new Date();

    const poll1 = await pollDeviceToken({ deviceCode: DEVICE_CODE, clientDbId: CLIENT_DB_ID, now: t0 });
    expect(poll1).toEqual({ outcome: 'authorization_pending' });

    const poll2 = await pollDeviceToken({
      deviceCode: DEVICE_CODE,
      clientDbId: CLIENT_DB_ID,
      now: new Date(t0.getTime() + 2000),
    });
    expect(poll2).toEqual({ outcome: 'slow_down' });

    const poll3 = await pollDeviceToken({
      deviceCode: DEVICE_CODE,
      clientDbId: CLIENT_DB_ID,
      now: new Date(t0.getTime() + 5000),
    });
    expect(poll3).toEqual({ outcome: 'authorization_pending' });
  });

  it('returns expired_token once past expiry, regardless of status', async () => {
    seedDeviceRow({ expiresAt: new Date(Date.now() - 1000) });
    const result = await pollDeviceToken({ deviceCode: DEVICE_CODE, clientDbId: CLIENT_DB_ID, now: new Date() });
    expect(result).toEqual({ outcome: 'expired_token' });
  });

  it('returns access_denied for a denied device code', async () => {
    seedDeviceRow({ deniedAt: new Date() });
    const result = await pollDeviceToken({ deviceCode: DEVICE_CODE, clientDbId: CLIENT_DB_ID, now: new Date() });
    expect(result).toEqual({ outcome: 'access_denied' });
  });

  it('mints a hashed ps_at_*/ps_rt_* token pair for an approved device code', async () => {
    seedDeviceRow({ approvedAt: new Date(), userId: USER_ID, scopes: ['account', 'offline_access'] });

    const result = await pollDeviceToken({ deviceCode: DEVICE_CODE, clientDbId: CLIENT_DB_ID, now: new Date() });

    expect(result.outcome).toBe('ok');
    if (result.outcome !== 'ok') throw new Error('unreachable');
    expect(result.userId).toBe(USER_ID);
    expect(result.scopes).toEqual(['account', 'offline_access']);
    expect(result.tokens.accessToken).toMatch(/^ps_at_/);
    expect(result.tokens.refreshToken).toMatch(/^ps_rt_/);
    expect(refreshRows).toHaveLength(1);
    expect(accessRows).toHaveLength(1);
    expect(refreshRows[0].tokenHash).toBe(hashToken(result.tokens.refreshToken!));
  });

  it('does not persist lastPolledAt for an already-settled (approved) record', async () => {
    seedDeviceRow({ approvedAt: new Date(), userId: USER_ID, lastPolledAt: null });
    await pollDeviceToken({ deviceCode: DEVICE_CODE, clientDbId: CLIENT_DB_ID, now: new Date() });
    expect(deviceRow?.lastPolledAt).toBeNull();
  });

  it('rejects and mints no tokens for an approved device code whose user is suspended (zero-trust audit finding)', async () => {
    seedDeviceRow({ approvedAt: new Date(), userId: USER_ID, scopes: ['account'] });
    userSuspendedAt = new Date();

    const result = await pollDeviceToken({ deviceCode: DEVICE_CODE, clientDbId: CLIENT_DB_ID, now: new Date() });

    expect(result).toEqual({ outcome: 'user_suspended' });
    expect(refreshRows).toHaveLength(0);
    expect(accessRows).toHaveLength(0);
  });

  describe('single-use redemption (RFC 8628 §3.5)', () => {
    it('marks the device code redeemed when it issues a token pair', async () => {
      seedDeviceRow({ approvedAt: new Date(), userId: USER_ID, scopes: ['account', 'offline_access'] });
      const now = new Date();

      await pollDeviceToken({ deviceCode: DEVICE_CODE, clientDbId: CLIENT_DB_ID, now });

      expect(deviceRow?.redeemedAt).toEqual(now);
    });

    // Without this, an approved device code keeps issuing on every poll until
    // it expires — and once the device flow can mint keys, every extra poll
    // would mint another mcp_* key.
    it('refuses a second poll of an already-redeemed code and issues nothing more', async () => {
      seedDeviceRow({ approvedAt: new Date(), userId: USER_ID, scopes: ['account', 'offline_access'] });

      const first = await pollDeviceToken({ deviceCode: DEVICE_CODE, clientDbId: CLIENT_DB_ID, now: new Date() });
      expect(first.outcome).toBe('ok');
      expect(accessRows).toHaveLength(1);

      const second = await pollDeviceToken({ deviceCode: DEVICE_CODE, clientDbId: CLIENT_DB_ID, now: new Date() });
      expect(second).toEqual({ outcome: 'already_redeemed' });
      expect(accessRows).toHaveLength(1);
      expect(refreshRows).toHaveLength(1);
    });

    it('reports already_redeemed rather than expired_token once a redeemed code passes its TTL', async () => {
      seedDeviceRow({
        approvedAt: new Date(),
        userId: USER_ID,
        redeemedAt: new Date(Date.now() - 2000),
        expiresAt: new Date(Date.now() - 1000),
      });

      const result = await pollDeviceToken({ deviceCode: DEVICE_CODE, clientDbId: CLIENT_DB_ID, now: new Date() });
      expect(result).toEqual({ outcome: 'already_redeemed' });
    });
  });

  describe('key-shaped grants (keys create/edit/use --device)', () => {
    it('mints an mcp_* key for a named drive grant instead of an OAuth token pair', async () => {
      seedDeviceRow({
        approvedAt: new Date(),
        userId: USER_ID,
        scopes: ['drive:drv1:member', 'name:remote-key', 'offline_access'],
      });
      const now = new Date();

      const result = await pollDeviceToken({ deviceCode: DEVICE_CODE, clientDbId: CLIENT_DB_ID, now });

      expect(result.outcome).toBe('ok_mcp_token');
      if (result.outcome !== 'ok_mcp_token') throw new Error('unreachable');
      expect(result.mcpToken).toMatch(/^mcp_/);
      expect(result.userId).toBe(USER_ID);
      // A key grant produces NO OAuth pair at all.
      expect(accessRows).toHaveLength(0);
      expect(refreshRows).toHaveLength(0);
      expect(sessionRepository.createMcpTokenWithDriveScopes).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: USER_ID,
          name: 'remote-key',
          isScoped: true,
          drives: [expect.objectContaining({ id: 'drv1', role: 'MEMBER' })],
        }),
        expect.anything(),
      );
      expect(deviceRow?.redeemedAt).toEqual(now);
    });

    it('re-scopes an existing key in place for an update_key grant, minting nothing', async () => {
      vi.mocked(sessionRepository.updateMcpTokenDriveScopes).mockResolvedValue({ id: 'tok123' } as never);
      seedDeviceRow({ approvedAt: new Date(), userId: USER_ID, scopes: ['update_key:tok123', 'drive:drv1:member'] });

      const result = await pollDeviceToken({ deviceCode: DEVICE_CODE, clientDbId: CLIENT_DB_ID, now: new Date() });

      expect(result.outcome).toBe('ok_mcp_update');
      if (result.outcome !== 'ok_mcp_update') throw new Error('unreachable');
      expect(result.tokenId).toBe('tok123');
      expect(sessionRepository.createMcpTokenWithDriveScopes).not.toHaveBeenCalled();
      expect(accessRows).toHaveLength(0);
    });

    it('approves an activate_key grant without minting or changing anything', async () => {
      vi.mocked(sessionRepository.findActiveMcpTokenByIdAndUser).mockResolvedValue({
        id: 'tok123',
        name: 'work',
      } as never);
      seedDeviceRow({ approvedAt: new Date(), userId: USER_ID, scopes: ['activate_key:tok123'] });

      const result = await pollDeviceToken({ deviceCode: DEVICE_CODE, clientDbId: CLIENT_DB_ID, now: new Date() });

      expect(result.outcome).toBe('ok_mcp_activate');
      if (result.outcome !== 'ok_mcp_activate') throw new Error('unreachable');
      expect(result.tokenId).toBe('tok123');
      expect(sessionRepository.createMcpTokenWithDriveScopes).not.toHaveBeenCalled();
      expect(sessionRepository.updateMcpTokenDriveScopes).not.toHaveBeenCalled();
      expect(accessRows).toHaveLength(0);
    });

    it('burns the code when the update target was revoked between consent and redemption (fail closed)', async () => {
      vi.mocked(sessionRepository.updateMcpTokenDriveScopes).mockResolvedValue(null as never);
      seedDeviceRow({ approvedAt: new Date(), userId: USER_ID, scopes: ['update_key:tok123', 'drive:drv1:member'] });

      const result = await pollDeviceToken({ deviceCode: DEVICE_CODE, clientDbId: CLIENT_DB_ID, now: new Date() });

      expect(result).toEqual({ outcome: 'update_target_gone' });
      expect(deviceRow?.redeemedAt).not.toBeNull();
    });

    it('burns the code when the activate target was revoked between consent and redemption (fail closed)', async () => {
      vi.mocked(sessionRepository.findActiveMcpTokenByIdAndUser).mockResolvedValue(null as never);
      seedDeviceRow({ approvedAt: new Date(), userId: USER_ID, scopes: ['activate_key:tok123'] });

      const result = await pollDeviceToken({ deviceCode: DEVICE_CODE, clientDbId: CLIENT_DB_ID, now: new Date() });

      expect(result).toEqual({ outcome: 'activate_target_gone' });
      expect(deviceRow?.redeemedAt).not.toBeNull();
    });

    // The device_authorization door already refuses all_drives; this is the
    // redemption-time backstop for a row that somehow carries it anyway.
    it('refuses to redeem an all_drives grant even if one reaches redemption, and mints nothing', async () => {
      seedDeviceRow({ approvedAt: new Date(), userId: USER_ID, scopes: ['all_drives', 'offline_access'] });

      const result = await pollDeviceToken({ deviceCode: DEVICE_CODE, clientDbId: CLIENT_DB_ID, now: new Date() });

      expect(result).toEqual({ outcome: 'all_drives_unsupported' });
      expect(sessionRepository.createMcpTokenWithDriveScopes).not.toHaveBeenCalled();
      expect(accessRows).toHaveLength(0);
      expect(deviceRow?.redeemedAt).not.toBeNull();
    });

    it('still mints a plain OAuth pair for an ordinary manage_keys login grant', async () => {
      seedDeviceRow({ approvedAt: new Date(), userId: USER_ID, scopes: ['manage_keys', 'offline_access'] });

      const result = await pollDeviceToken({ deviceCode: DEVICE_CODE, clientDbId: CLIENT_DB_ID, now: new Date() });

      expect(result.outcome).toBe('ok');
      expect(sessionRepository.createMcpTokenWithDriveScopes).not.toHaveBeenCalled();
      expect(accessRows).toHaveLength(1);
    });
  });

  describe('F1 — refresh token gated on offline_access', () => {
    it('mints an access-only grant (no refresh row, no refresh_token) when offline_access was not requested', async () => {
      seedDeviceRow({ approvedAt: new Date(), userId: USER_ID, scopes: ['account'] });

      const result = await pollDeviceToken({ deviceCode: DEVICE_CODE, clientDbId: CLIENT_DB_ID, now: new Date() });

      expect(result.outcome).toBe('ok');
      if (result.outcome !== 'ok') throw new Error('unreachable');
      expect(result.tokens.accessToken).toMatch(/^ps_at_/);
      expect(result.tokens.refreshToken).toBeUndefined();
      expect(refreshRows).toHaveLength(0);
      expect(accessRows).toHaveLength(1);
    });

    it('mints a refresh token when offline_access was requested', async () => {
      seedDeviceRow({ approvedAt: new Date(), userId: USER_ID, scopes: ['account', 'offline_access'] });

      const result = await pollDeviceToken({ deviceCode: DEVICE_CODE, clientDbId: CLIENT_DB_ID, now: new Date() });

      expect(result.outcome).toBe('ok');
      if (result.outcome !== 'ok') throw new Error('unreachable');
      expect(result.tokens.refreshToken).toMatch(/^ps_rt_/);
      expect(refreshRows).toHaveLength(1);
    });
  });
});

describe('verifyDeviceUserCode', () => {
  it('returns not_found for an unknown user code', async () => {
    deviceRow = null;
    const result = await verifyDeviceUserCode({ userCode: 'NEVERISSU', now: new Date() });
    expect(result).toEqual({ outcome: 'not_found' });
  });

  it('returns ok with the resolved client_id and scopes for a pending, unexpired code', async () => {
    seedDeviceRow({ scopes: ['account'] });
    const result = await verifyDeviceUserCode({ userCode: USER_CODE, now: new Date() });
    expect(result).toEqual({ outcome: 'ok', clientId: 'pagespace-cli', scopes: ['account'] });
  });

  it('returns not_found for an expired code (fail closed, no oracle)', async () => {
    seedDeviceRow({ expiresAt: new Date(Date.now() - 1000) });
    const result = await verifyDeviceUserCode({ userCode: USER_CODE, now: new Date() });
    expect(result).toEqual({ outcome: 'not_found' });
  });

  it('returns not_found for an already-approved code (settled, cannot re-verify)', async () => {
    seedDeviceRow({ approvedAt: new Date(), userId: USER_ID });
    const result = await verifyDeviceUserCode({ userCode: USER_CODE, now: new Date() });
    expect(result).toEqual({ outcome: 'not_found' });
  });

  it('returns not_found for an already-denied code (settled, cannot re-verify)', async () => {
    seedDeviceRow({ deniedAt: new Date() });
    const result = await verifyDeviceUserCode({ userCode: USER_CODE, now: new Date() });
    expect(result).toEqual({ outcome: 'not_found' });
  });
});

describe('recordDeviceApproval', () => {
  it('returns not_found for an unknown user code', async () => {
    deviceRow = null;
    const result = await recordDeviceApproval({ userCode: 'NEVERISSU', action: 'approve', userId: USER_ID, now: new Date() });
    expect(result).toEqual({ outcome: 'not_found' });
  });

  it('approves a pending code exactly once, persisting approvedAt + userId', async () => {
    seedDeviceRow();
    const now = new Date();

    const result = await recordDeviceApproval({ userCode: USER_CODE, action: 'approve', userId: USER_ID, now });

    expect(result).toEqual({ outcome: 'approved' });
    expect(deviceRow?.approvedAt).toEqual(now);
    expect(deviceRow?.userId).toBe(USER_ID);
  });

  it('denies a pending code, persisting deniedAt', async () => {
    seedDeviceRow();
    const now = new Date();

    const result = await recordDeviceApproval({ userCode: USER_CODE, action: 'deny', userId: USER_ID, now });

    expect(result).toEqual({ outcome: 'denied' });
    expect(deviceRow?.deniedAt).toEqual(now);
  });

  it('rejects a repeat decision on an already-approved code (single-settlement)', async () => {
    seedDeviceRow({ approvedAt: new Date(), userId: USER_ID });

    const result = await recordDeviceApproval({ userCode: USER_CODE, action: 'deny', userId: USER_ID, now: new Date() });

    expect(result).toEqual({ outcome: 'invalid', decision: { status: 'already_settled', existingStatus: 'approved' } });
  });

  it('rejects a repeat decision on an already-denied code (single-settlement)', async () => {
    seedDeviceRow({ deniedAt: new Date() });

    const result = await recordDeviceApproval({ userCode: USER_CODE, action: 'approve', userId: USER_ID, now: new Date() });

    expect(result).toEqual({ outcome: 'invalid', decision: { status: 'already_settled', existingStatus: 'denied' } });
  });

  it('rejects approval of an expired-but-still-pending code', async () => {
    seedDeviceRow({ expiresAt: new Date(Date.now() - 1000) });

    const result = await recordDeviceApproval({ userCode: USER_CODE, action: 'approve', userId: USER_ID, now: new Date() });

    expect(result).toEqual({ outcome: 'invalid', decision: { status: 'expired' } });
  });
});
