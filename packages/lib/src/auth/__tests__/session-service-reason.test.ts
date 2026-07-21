import { describe, it, expect, vi, beforeEach } from 'vitest';

// D5 — session-failure reasons. validateSessionWithReason explains WHY a session failed to
// validate (expired vs revoked vs never-existed vs suspended vs ...), so an incident is
// provable from the audit log instead of a bare `auth_failed`. validateSession stays a thin
// claims|null wrapper over it (non-breaking).

vi.mock('../session-repository', () => ({
  sessionRepository: {
    findUserById: vi.fn(),
    findActiveSession: vi.fn(),
    findSessionByHashAnyState: vi.fn(),
    getActiveSessionExpiry: vi.fn(),
    setExpiresAtByHash: vi.fn(),
    insertSession: vi.fn(),
    touchSession: vi.fn(),
    revokeByHash: vi.fn(),
    revokeAllForUser: vi.fn(),
    revokeWebForUser: vi.fn(),
    revokeAdminForUser: vi.fn(),
    revokeForUserDevice: vi.fn(),
    deleteExpired: vi.fn(),
  },
}));

vi.mock('../opaque-tokens', () => ({
  generateOpaqueToken: vi.fn(),
  isValidTokenFormat: vi.fn(),
}));

vi.mock('../token-utils', () => ({
  hashToken: vi.fn((t: string) => `hashed_${t}`),
}));

// Idle timeout disabled by default; a dedicated test re-mocks it to exercise the branch.
vi.mock('../constants', () => ({
  IDLE_TIMEOUT_MS: 0,
}));

import { SessionService } from '../session-service';
import { sessionRepository } from '../session-repository';
import { isValidTokenFormat } from '../opaque-tokens';

const activeSession = (overrides: Record<string, unknown> = {}) => ({
  id: 'sess_abcdef123456',
  userId: 'user-1',
  tokenHash: 'hashed_tok',
  tokenVersion: 3,
  adminRoleVersion: 1,
  type: 'user',
  scopes: ['read'],
  expiresAt: new Date(Date.now() + 60 * 60 * 1000),
  lastUsedAt: new Date(),
  createdAt: new Date(),
  resourceType: null,
  resourceId: null,
  driveId: null,
  user: {
    id: 'user-1',
    tokenVersion: 3,
    role: 'user',
    adminRoleVersion: 1,
    suspendedAt: null,
  },
  ...overrides,
});

describe('validateSessionWithReason', () => {
  let service: SessionService;

  beforeEach(() => {
    vi.clearAllMocks();
    service = new SessionService();
    vi.mocked(isValidTokenFormat).mockReturnValue(true);
  });

  it('given a malformed token, yields failureReason bad_format (no DB lookup)', async () => {
    vi.mocked(isValidTokenFormat).mockReturnValue(false);

    const result = await service.validateSessionWithReason('garbage');

    expect(result).toEqual({ failureReason: 'bad_format' });
    expect(sessionRepository.findActiveSession).not.toHaveBeenCalled();
  });

  it('given no active session and no session at all for the hash, yields not_found', async () => {
    vi.mocked(sessionRepository.findActiveSession).mockResolvedValue(undefined);
    vi.mocked(sessionRepository.findSessionByHashAnyState).mockResolvedValue(undefined);

    const result = await service.validateSessionWithReason('sess_tok');

    expect(result.failureReason).toBe('not_found');
  });

  it('given no active session but a grace-expired one (revokedAt null, expiresAt past), yields expired with expiresAt', async () => {
    // #2176's expireSessionByHashSoon clamps expiresAt into the past WITHOUT setting revokedAt.
    const expiredAt = new Date(Date.now() - 5_000);
    vi.mocked(sessionRepository.findActiveSession).mockResolvedValue(undefined);
    vi.mocked(sessionRepository.findSessionByHashAnyState).mockResolvedValue({
      id: 'sess_expired01',
      type: 'user',
      revokedAt: null,
      revokedReason: null,
      expiresAt: expiredAt,
    } as never);

    const result = await service.validateSessionWithReason('sess_tok');

    expect(result.failureReason).toBe('expired');
    // Narrow to the failure branch (success has failureReason: undefined).
    if (!result.failureReason) throw new Error('expected a failure result');
    expect(result.expiresAt).toEqual(expiredAt);
  });

  it('given no active session but a revoked one, yields revoked with revokedReason', async () => {
    vi.mocked(sessionRepository.findActiveSession).mockResolvedValue(undefined);
    vi.mocked(sessionRepository.findSessionByHashAnyState).mockResolvedValue({
      id: 'sess_revoked01',
      type: 'user',
      revokedAt: new Date(Date.now() - 1000),
      revokedReason: 'device_id_mismatch',
      expiresAt: new Date(Date.now() + 60_000),
    } as never);

    const result = await service.validateSessionWithReason('sess_tok');

    expect(result.failureReason).toBe('revoked');
    if (!result.failureReason) throw new Error('expected a failure result');
    expect(result.revokedReason).toBe('device_id_mismatch');
  });

  it('given an active session of the wrong type, yields wrong_type (no revoke side effect)', async () => {
    vi.mocked(sessionRepository.findActiveSession).mockResolvedValue(
      activeSession({ type: 'socket' }) as never,
    );

    const result = await service.validateSessionWithReason('sess_tok', { expectedType: 'user' });

    expect(result.failureReason).toBe('wrong_type');
    expect(sessionRepository.revokeByHash).not.toHaveBeenCalled();
  });

  it('given a suspended user, yields user_suspended and revokes the session', async () => {
    vi.mocked(sessionRepository.findActiveSession).mockResolvedValue(
      activeSession({ user: { id: 'user-1', tokenVersion: 3, role: 'user', adminRoleVersion: 1, suspendedAt: new Date() } }) as never,
    );

    const result = await service.validateSessionWithReason('sess_tok');

    expect(result.failureReason).toBe('user_suspended');
    expect(sessionRepository.revokeByHash).toHaveBeenCalledWith('hashed_sess_tok', 'user_suspended');
  });

  it('given a token-version mismatch, yields token_version_mismatch and revokes', async () => {
    vi.mocked(sessionRepository.findActiveSession).mockResolvedValue(
      activeSession({ tokenVersion: 2 }) as never, // user.tokenVersion is 3
    );

    const result = await service.validateSessionWithReason('sess_tok');

    expect(result.failureReason).toBe('token_version_mismatch');
    expect(sessionRepository.revokeByHash).toHaveBeenCalledWith('hashed_sess_tok', 'token_version_mismatch');
  });

  it('given a valid active session, yields claims and touches the session', async () => {
    vi.mocked(sessionRepository.findActiveSession).mockResolvedValue(activeSession() as never);

    const result = await service.validateSessionWithReason('sess_tok', { expectedType: 'user' });

    expect(result.claims).toMatchObject({ userId: 'user-1', sessionId: 'sess_abcdef123456', type: 'user' });
    expect(result.failureReason).toBeUndefined();
    expect(sessionRepository.touchSession).toHaveBeenCalledWith('hashed_sess_tok');
  });

  it('given no active session and no user on the joined active row, yields not_found', async () => {
    // Active row exists but the user was deleted (join null) — cannot mint claims.
    vi.mocked(sessionRepository.findActiveSession).mockResolvedValue(
      activeSession({ user: null }) as never,
    );
    vi.mocked(sessionRepository.findSessionByHashAnyState).mockResolvedValue(undefined);

    const result = await service.validateSessionWithReason('sess_tok');

    expect(result.failureReason).toBe('not_found');
  });
});

describe('validateSessionWithReason — idle timeout branch', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  it('given an idle session (last activity older than the timeout), yields idle_timeout and revokes', async () => {
    vi.doMock('../constants', () => ({ IDLE_TIMEOUT_MS: 15 * 60 * 1000 }));
    vi.doMock('../opaque-tokens', () => ({
      generateOpaqueToken: vi.fn(),
      isValidTokenFormat: vi.fn(() => true),
    }));
    vi.doMock('../token-utils', () => ({ hashToken: vi.fn((t: string) => `hashed_${t}`) }));
    const repo = {
      findActiveSession: vi.fn().mockResolvedValue({
        id: 'sess_idle01',
        userId: 'user-1',
        tokenHash: 'hashed_tok',
        tokenVersion: 3,
        adminRoleVersion: 1,
        type: 'user',
        scopes: ['read'],
        expiresAt: new Date(Date.now() + 60 * 60 * 1000),
        lastUsedAt: new Date(Date.now() - 30 * 60 * 1000), // idle 30min > 15min timeout
        createdAt: new Date(Date.now() - 60 * 60 * 1000),
        resourceType: null,
        resourceId: null,
        driveId: null,
        user: { id: 'user-1', tokenVersion: 3, role: 'user', adminRoleVersion: 1, suspendedAt: null },
      }),
      findSessionByHashAnyState: vi.fn(),
      touchSession: vi.fn(),
      revokeByHash: vi.fn(),
    };
    vi.doMock('../session-repository', () => ({ sessionRepository: repo }));

    const { SessionService: FreshService } = await import('../session-service');
    const service = new FreshService();

    const result = await service.validateSessionWithReason('sess_tok');

    expect(result.failureReason).toBe('idle_timeout');
    expect(repo.revokeByHash).toHaveBeenCalledWith('hashed_sess_tok', 'idle_timeout');
  });
});

// The wrapper must return exactly what it did before: claims on success, null on any failure.
describe('validateSession wrapper parity', () => {
  let service: SessionService;

  beforeEach(() => {
    vi.clearAllMocks();
    service = new SessionService();
    vi.mocked(isValidTokenFormat).mockReturnValue(true);
  });

  it('returns claims on a valid session (identical to the reason path claims)', async () => {
    vi.mocked(sessionRepository.findActiveSession).mockResolvedValue(activeSession() as never);

    const claims = await service.validateSession('sess_tok', { expectedType: 'user' });

    expect(claims).not.toBeNull();
    expect(claims?.userId).toBe('user-1');
    expect(claims?.sessionId).toBe('sess_abcdef123456');
  });

  it('returns null on a malformed token', async () => {
    vi.mocked(isValidTokenFormat).mockReturnValue(false);
    expect(await service.validateSession('garbage')).toBeNull();
  });

  it('returns null on a revoked session', async () => {
    vi.mocked(sessionRepository.findActiveSession).mockResolvedValue(undefined);
    vi.mocked(sessionRepository.findSessionByHashAnyState).mockResolvedValue({
      id: 'sess_x', type: 'user', revokedAt: new Date(), revokedReason: 'logout', expiresAt: new Date(),
    } as never);

    expect(await service.validateSession('sess_tok')).toBeNull();
  });

  it('returns null on a wrong-type token', async () => {
    vi.mocked(sessionRepository.findActiveSession).mockResolvedValue(
      activeSession({ type: 'socket' }) as never,
    );
    expect(await service.validateSession('sess_tok', { expectedType: 'user' })).toBeNull();
  });
});
