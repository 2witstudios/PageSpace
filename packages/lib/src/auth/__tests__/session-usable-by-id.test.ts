/**
 * `isSessionUsableById` — the read behind the dev-preview cookie.
 *
 * The preview cookie is signed by us and names its minting session; it never
 * carries the session token, so the token-hash-keyed `validateSession` cannot
 * answer for it. This read is what makes "revoke a session, lose the preview
 * on the next request" true, so what it checks — and what it refuses to
 * write — is the whole point.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../session-repository', () => ({
  sessionRepository: {
    findUserById: vi.fn(),
    findActiveSession: vi.fn(),
    findActiveSessionById: vi.fn(),
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
vi.mock('../opaque-tokens', () => ({ generateOpaqueToken: vi.fn(), isValidTokenFormat: vi.fn(() => true) }));
vi.mock('../token-utils', () => ({ hashToken: vi.fn((t: string) => `hashed_${t}`) }));
vi.mock('../constants', () => ({ IDLE_TIMEOUT_MS: 15 * 60 * 1000 }));

import { SessionService } from '../session-service';
import { sessionRepository } from '../session-repository';

const row = (overrides: Record<string, unknown> = {}) => ({
  id: 'sess_abcdef123456',
  userId: 'user-1',
  tokenHash: 'hashed_tok',
  tokenVersion: 3,
  adminRoleVersion: 1,
  type: 'user',
  scopes: ['read'],
  expiresAt: new Date(Date.now() + 3_600_000),
  lastUsedAt: new Date(),
  createdAt: new Date(),
  resourceType: null,
  resourceId: null,
  driveId: null,
  user: { id: 'user-1', tokenVersion: 3, role: 'user', adminRoleVersion: 1, suspendedAt: null },
  ...overrides,
});

describe('isSessionUsableById', () => {
  let service: SessionService;
  beforeEach(() => {
    vi.clearAllMocks();
    service = new SessionService();
  });

  it('is true for a live session belonging to the asking user', async () => {
    vi.mocked(sessionRepository.findActiveSessionById).mockResolvedValue(row() as never);
    expect(await service.isSessionUsableById('sess_abcdef123456', 'user-1')).toBe(true);
    expect(sessionRepository.findActiveSessionById).toHaveBeenCalledWith('sess_abcdef123456');
  });

  it('is false when the session is gone — revoked or expired, which the query itself excludes', async () => {
    vi.mocked(sessionRepository.findActiveSessionById).mockResolvedValue(undefined);
    expect(await service.isSessionUsableById('sess_abcdef123456', 'user-1')).toBe(false);
  });

  it('is false for a session belonging to somebody else, even a live one', async () => {
    vi.mocked(sessionRepository.findActiveSessionById).mockResolvedValue(row() as never);
    expect(await service.isSessionUsableById('sess_abcdef123456', 'user-2')).toBe(false);
  });

  it('is false on a tokenVersion bump, which a password change or erasure writes BEFORE any lazy revoke', async () => {
    vi.mocked(sessionRepository.findActiveSessionById).mockResolvedValue(
      row({ user: { id: 'user-1', tokenVersion: 4, role: 'user', adminRoleVersion: 1, suspendedAt: null } }) as never,
    );
    expect(await service.isSessionUsableById('sess_abcdef123456', 'user-1')).toBe(false);
  });

  it('is false for a suspended user, whose rows may still show revokedAt: null', async () => {
    vi.mocked(sessionRepository.findActiveSessionById).mockResolvedValue(
      row({ user: { id: 'user-1', tokenVersion: 3, role: 'user', adminRoleVersion: 1, suspendedAt: new Date() } }) as never,
    );
    expect(await service.isSessionUsableById('sess_abcdef123456', 'user-1')).toBe(false);
  });

  it('is false when the user join came back empty rather than assuming the session is fine', async () => {
    vi.mocked(sessionRepository.findActiveSessionById).mockResolvedValue(row({ user: null }) as never);
    expect(await service.isSessionUsableById('sess_abcdef123456', 'user-1')).toBe(false);
  });

  it('is false for a session idle past the policy — the revocation a background preview frame would otherwise outlive', async () => {
    // A preview iframe left open makes no request that reaches
    // `validateSession`, so the lazy idle revoke never fires and the row still
    // reads active. Checking the policy here is what stops the preview
    // outliving it by days.
    vi.mocked(sessionRepository.findActiveSessionById).mockResolvedValue(row({ lastUsedAt: new Date(Date.now() - 20 * 60 * 1000) }) as never);
    expect(await service.isSessionUsableById('sess_abcdef123456', 'user-1')).toBe(false);

    vi.mocked(sessionRepository.findActiveSessionById).mockResolvedValue(row({ lastUsedAt: new Date(Date.now() - 60_000) }) as never);
    expect(await service.isSessionUsableById('sess_abcdef123456', 'user-1')).toBe(true);

    // With no `lastUsedAt` the clock runs from creation, exactly as
    // `validateSessionWithReason` does.
    vi.mocked(sessionRepository.findActiveSessionById).mockResolvedValue(row({ lastUsedAt: null, createdAt: new Date(Date.now() - 20 * 60 * 1000) }) as never);
    expect(await service.isSessionUsableById('sess_abcdef123456', 'user-1')).toBe(false);
  });

  it('WRITES NOTHING — no lazy revoke and no lastUsedAt touch, because an untrusted origin drives this path', async () => {
    vi.mocked(sessionRepository.findActiveSessionById).mockResolvedValue(
      row({ user: { id: 'user-1', tokenVersion: 9, role: 'user', adminRoleVersion: 1, suspendedAt: null } }) as never,
    );
    await service.isSessionUsableById('sess_abcdef123456', 'user-1');
    expect(sessionRepository.touchSession).not.toHaveBeenCalled();
    expect(sessionRepository.revokeByHash).not.toHaveBeenCalled();
    expect(sessionRepository.setExpiresAtByHash).not.toHaveBeenCalled();
  });
});
