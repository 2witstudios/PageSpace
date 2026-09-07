import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/auth', () => ({ isPrincipalDriveOwnerOrAdmin: vi.fn() }));

import { isPrincipalDriveOwnerOrAdmin } from '@/lib/auth';
import { canManageDevPreview, decideDevPreviewManage } from '../manage-decision';

const ENV = { kind: 'env', id: 'e' } as const;
const WS = { kind: 'workspace', id: 'w' } as const;

describe('decideDevPreviewManage', () => {
  it('an ENV preview is owner/admin only — however the user reached it (session route included)', () => {
    expect(decideDevPreviewManage({ holder: ENV, userId: 'u', sessionOwnerId: 'u', isDriveOwnerOrAdmin: false })).toBe(false);
    expect(decideDevPreviewManage({ holder: ENV, userId: 'u', sessionOwnerId: null, isDriveOwnerOrAdmin: false })).toBe(false);
    expect(decideDevPreviewManage({ holder: ENV, userId: 'u', sessionOwnerId: null, isDriveOwnerOrAdmin: true })).toBe(true);
    expect(decideDevPreviewManage({ holder: ENV, userId: 'u', sessionOwnerId: 'other', isDriveOwnerOrAdmin: true })).toBe(true);
  });

  it('a SESSION preview is the session owner\'s — a drive admin who does not own it may not flip it', () => {
    expect(decideDevPreviewManage({ holder: WS, userId: 'u', sessionOwnerId: 'u', isDriveOwnerOrAdmin: false })).toBe(true);
    expect(decideDevPreviewManage({ holder: WS, userId: 'u', sessionOwnerId: 'other', isDriveOwnerOrAdmin: true })).toBe(false);
    expect(decideDevPreviewManage({ holder: WS, userId: 'u', sessionOwnerId: null, isDriveOwnerOrAdmin: true })).toBe(false);
  });

  describe('canManageDevPreview — the one async entry every route asks', () => {
    const auth = { userId: 'u' } as never;
    beforeEach(() => vi.mocked(isPrincipalDriveOwnerOrAdmin).mockReset());

    it('an env holder reads the drive role (once) and names the env reason on refusal', async () => {
      vi.mocked(isPrincipalDriveOwnerOrAdmin).mockResolvedValueOnce(false);
      expect(await canManageDevPreview(auth, { holder: ENV, sessionOwnerId: 'u', driveId: 'd' })).toEqual({ allowed: false, reason: 'env_manage_requires_owner_or_admin', message: expect.stringContaining('drive owner or an admin') });
      expect(isPrincipalDriveOwnerOrAdmin).toHaveBeenCalledWith(auth, 'd');
      vi.mocked(isPrincipalDriveOwnerOrAdmin).mockResolvedValueOnce(true);
      expect(await canManageDevPreview(auth, { holder: ENV, sessionOwnerId: null, driveId: 'd' })).toEqual({ allowed: true });
    });

    it('a session holder never reads the drive role; owner allowed, anyone else refused with the session reason', async () => {
      expect(await canManageDevPreview(auth, { holder: WS, sessionOwnerId: 'u', driveId: 'd' })).toEqual({ allowed: true });
      expect(await canManageDevPreview(auth, { holder: WS, sessionOwnerId: 'other', driveId: 'd' })).toEqual({ allowed: false, reason: 'session_manage_requires_owner', message: expect.stringContaining('session owner') });
      expect(isPrincipalDriveOwnerOrAdmin).not.toHaveBeenCalled();
    });

    it('an env holder with no drive id (impossible for an env, kept honest) is refused without a lookup', async () => {
      expect((await canManageDevPreview(auth, { holder: ENV, sessionOwnerId: null, driveId: null })).allowed).toBe(false);
      expect(isPrincipalDriveOwnerOrAdmin).not.toHaveBeenCalled();
    });
  });
});
