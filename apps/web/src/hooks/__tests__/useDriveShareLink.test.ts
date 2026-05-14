import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';

vi.mock('@/lib/auth/auth-fetch', () => ({
  post: vi.fn(),
  del: vi.fn(),
  fetchWithAuth: vi.fn(),
}));

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

import { post, del, fetchWithAuth } from '@/lib/auth/auth-fetch';
import { toast } from 'sonner';
import { useDriveShareLink, type DriveLink } from '../useDriveShareLink';

const DRIVE_ID = 'drive-abc';
const LINK_ID = 'link-123';
const LINK_ID_2 = 'link-456';
const SHARE_URL = 'https://app.pagespace.ai/s/ps_share_xyz';
const SHARE_URL_2 = 'https://app.pagespace.ai/s/ps_share_abc';

const MEMBER_LINK: DriveLink = {
  id: LINK_ID,
  role: 'MEMBER',
  customRoleId: null,
  customRoleName: null,
  customRoleColor: null,
  useCount: 3,
  shareUrl: SHARE_URL,
};
const ADMIN_LINK: DriveLink = {
  id: LINK_ID_2,
  role: 'ADMIN',
  customRoleId: null,
  customRoleName: null,
  customRoleColor: null,
  useCount: 1,
  shareUrl: SHARE_URL_2,
};

function mockLinksFetch(data: unknown) {
  vi.spyOn(global, 'fetch').mockResolvedValueOnce({
    ok: true,
    json: async () => data,
  } as Response);
}

function mockLinksFetchReject() {
  vi.spyOn(global, 'fetch').mockRejectedValueOnce(new Error('network error'));
}

function mockRolesFetch(roles: Array<{ id: string; name: string; isDefault: boolean; color?: string | null }> = []) {
  vi.mocked(fetchWithAuth).mockResolvedValueOnce({
    ok: true,
    json: async () => ({ roles }),
  } as Response);
}

describe('useDriveShareLink', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('loading existing links', () => {
    it('Given GET returns links, should populate links list', async () => {
      mockLinksFetch({ links: [MEMBER_LINK] });
      mockRolesFetch([]);

      const { result } = renderHook(() => useDriveShareLink(DRIVE_ID));

      expect(result.current.isLoading).toBe(true);

      await waitFor(() => expect(result.current.isLoading).toBe(false));

      expect(result.current.links).toHaveLength(1);
      expect(result.current.links[0].id).toBe(LINK_ID);
      expect(result.current.links[0].role).toBe('MEMBER');
      expect(result.current.links[0].shareUrl).toBe(SHARE_URL);
    });

    it('Given GET returns multiple links, should populate all in list', async () => {
      mockLinksFetch({ links: [MEMBER_LINK, ADMIN_LINK] });
      mockRolesFetch([]);

      const { result } = renderHook(() => useDriveShareLink(DRIVE_ID));
      await waitFor(() => expect(result.current.isLoading).toBe(false));

      expect(result.current.links).toHaveLength(2);
      expect(result.current.links[0].id).toBe(LINK_ID);
      expect(result.current.links[1].id).toBe(LINK_ID_2);
    });

    it('Given GET returns an empty list, should have empty links array', async () => {
      mockLinksFetch({ links: [] });
      mockRolesFetch([]);

      const { result } = renderHook(() => useDriveShareLink(DRIVE_ID));
      await waitFor(() => expect(result.current.isLoading).toBe(false));

      expect(result.current.links).toHaveLength(0);
    });

    it('Given GET returns a link with null shareUrl, should include it in list', async () => {
      mockLinksFetch({
        links: [{
          id: LINK_ID,
          role: 'ADMIN',
          customRoleId: null,
          customRoleName: null,
          customRoleColor: null,
          useCount: 0,
          shareUrl: null,
        }],
      });
      mockRolesFetch([]);

      const { result } = renderHook(() => useDriveShareLink(DRIVE_ID));
      await waitFor(() => expect(result.current.isLoading).toBe(false));

      expect(result.current.links).toHaveLength(1);
      expect(result.current.links[0].shareUrl).toBeNull();
    });

    it('Given GET returns malformed data (missing id), should leave links empty', async () => {
      mockLinksFetch({ links: [{ role: 'MEMBER', useCount: 0 }] });
      mockRolesFetch([]);

      const { result } = renderHook(() => useDriveShareLink(DRIVE_ID));
      await waitFor(() => expect(result.current.isLoading).toBe(false));

      expect(result.current.links).toHaveLength(0);
    });

    it('Given GET fails with network error, should finish loading with empty links', async () => {
      mockLinksFetchReject();
      mockRolesFetch([]);

      const { result } = renderHook(() => useDriveShareLink(DRIVE_ID));
      await waitFor(() => expect(result.current.isLoading).toBe(false));

      expect(result.current.links).toHaveLength(0);
    });
  });

  describe('generating a link', () => {
    it('Given POST succeeds, should append new link to list', async () => {
      mockLinksFetch({ links: [] });
      mockRolesFetch([]);
      vi.mocked(post).mockResolvedValueOnce({
        id: LINK_ID,
        rawToken: 'ps_share_xyz',
        shareUrl: SHARE_URL,
      });

      const { result } = renderHook(() => useDriveShareLink(DRIVE_ID));
      await waitFor(() => expect(result.current.isLoading).toBe(false));

      Object.assign(navigator, { clipboard: { writeText: vi.fn().mockResolvedValue(undefined) } });

      await act(async () => {
        await result.current.handleGenerate();
      });

      expect(result.current.links).toHaveLength(1);
      expect(result.current.links[0].id).toBe(LINK_ID);
      expect(result.current.links[0].role).toBe('MEMBER');
      expect(result.current.links[0].shareUrl).toBe(SHARE_URL);
    });

    it('Given existing links, POST should append without removing existing', async () => {
      mockLinksFetch({ links: [MEMBER_LINK] });
      mockRolesFetch([]);
      vi.mocked(post).mockResolvedValueOnce({
        id: LINK_ID_2,
        rawToken: 'ps_share_abc',
        shareUrl: SHARE_URL_2,
      });

      const { result } = renderHook(() => useDriveShareLink(DRIVE_ID));
      await waitFor(() => expect(result.current.isLoading).toBe(false));

      Object.assign(navigator, { clipboard: { writeText: vi.fn().mockResolvedValue(undefined) } });

      act(() => { result.current.setSelectedRole({ kind: 'admin' }); });

      await act(async () => {
        await result.current.handleGenerate();
      });

      expect(result.current.links).toHaveLength(2);
      expect(result.current.links[1].id).toBe(LINK_ID_2);
      expect(result.current.links[1].role).toBe('ADMIN');
    });

    it('Given a custom role is selected, POST payload should carry customRoleId and role=MEMBER', async () => {
      mockLinksFetch({ links: [] });
      mockRolesFetch([{ id: 'role-editor', name: 'Editor', isDefault: false }]);
      vi.mocked(post).mockResolvedValueOnce({
        id: LINK_ID,
        rawToken: 'ps_share_xyz',
        shareUrl: SHARE_URL,
      });

      const { result } = renderHook(() => useDriveShareLink(DRIVE_ID));
      await waitFor(() => expect(result.current.isLoading).toBe(false));

      Object.assign(navigator, { clipboard: { writeText: vi.fn().mockResolvedValue(undefined) } });

      act(() => {
        result.current.setSelectedRole({ kind: 'custom', customRoleId: 'role-editor' });
      });

      await act(async () => {
        await result.current.handleGenerate();
      });

      expect(post).toHaveBeenCalledWith(
        `/api/drives/${DRIVE_ID}/share-links`,
        { role: 'MEMBER', customRoleId: 'role-editor' },
      );
      expect(result.current.links[0].customRoleId).toBe('role-editor');
      expect(result.current.links[0].customRoleName).toBe('Editor');
    });

    it('Given POST fails, should not update links list', async () => {
      mockLinksFetch({ links: [] });
      mockRolesFetch([]);
      vi.mocked(post).mockRejectedValueOnce(new Error('server error'));

      const { result } = renderHook(() => useDriveShareLink(DRIVE_ID));
      await waitFor(() => expect(result.current.isLoading).toBe(false));

      await act(async () => {
        await result.current.handleGenerate();
      });

      expect(result.current.links).toHaveLength(0);
      expect(toast.error).toHaveBeenCalled();
    });
  });

  describe('copying a link', () => {
    it('Given a link with shareUrl, handleCopy should write that shareUrl to clipboard', async () => {
      mockLinksFetch({ links: [MEMBER_LINK] });
      mockRolesFetch([]);
      const writeText = vi.fn().mockResolvedValue(undefined);
      Object.assign(navigator, { clipboard: { writeText } });

      const { result } = renderHook(() => useDriveShareLink(DRIVE_ID));
      await waitFor(() => expect(result.current.isLoading).toBe(false));

      await act(async () => {
        await result.current.handleCopy(result.current.links[0]);
      });

      expect(writeText).toHaveBeenCalledWith(SHARE_URL);
      expect(toast.success).toHaveBeenCalled();
    });

    it('Given a link with null shareUrl, handleCopy should do nothing', async () => {
      const nullUrlLink: DriveLink = {
        id: LINK_ID,
        role: 'MEMBER',
        customRoleId: null,
        customRoleName: null,
        customRoleColor: null,
        useCount: 0,
        shareUrl: null,
      };
      mockLinksFetch({ links: [nullUrlLink] });
      mockRolesFetch([]);
      const writeText = vi.fn();
      Object.assign(navigator, { clipboard: { writeText } });

      const { result } = renderHook(() => useDriveShareLink(DRIVE_ID));
      await waitFor(() => expect(result.current.isLoading).toBe(false));

      await act(async () => {
        await result.current.handleCopy(result.current.links[0]);
      });

      expect(writeText).not.toHaveBeenCalled();
    });

    it('Given multiple links, handleCopy copies only the specified link URL', async () => {
      mockLinksFetch({ links: [MEMBER_LINK, ADMIN_LINK] });
      mockRolesFetch([]);
      const writeText = vi.fn().mockResolvedValue(undefined);
      Object.assign(navigator, { clipboard: { writeText } });

      const { result } = renderHook(() => useDriveShareLink(DRIVE_ID));
      await waitFor(() => expect(result.current.isLoading).toBe(false));

      await act(async () => {
        await result.current.handleCopy(result.current.links[1]);
      });

      expect(writeText).toHaveBeenCalledWith(SHARE_URL_2);
    });
  });

  describe('revoking a link', () => {
    it('Given DELETE succeeds, should remove revoked link from list', async () => {
      mockLinksFetch({ links: [MEMBER_LINK] });
      mockRolesFetch([]);
      vi.mocked(del).mockResolvedValueOnce(undefined);

      const { result } = renderHook(() => useDriveShareLink(DRIVE_ID));
      await waitFor(() => expect(result.current.isLoading).toBe(false));

      await act(async () => {
        await result.current.handleRevoke(LINK_ID);
      });

      expect(result.current.links).toHaveLength(0);
      expect(toast.success).toHaveBeenCalled();
    });

    it('Given multiple links, revoking one should leave the other', async () => {
      mockLinksFetch({ links: [MEMBER_LINK, ADMIN_LINK] });
      mockRolesFetch([]);
      vi.mocked(del).mockResolvedValueOnce(undefined);

      const { result } = renderHook(() => useDriveShareLink(DRIVE_ID));
      await waitFor(() => expect(result.current.isLoading).toBe(false));

      await act(async () => {
        await result.current.handleRevoke(LINK_ID);
      });

      expect(result.current.links).toHaveLength(1);
      expect(result.current.links[0].id).toBe(LINK_ID_2);
    });

    it('Given DELETE fails, should keep link in list and show error', async () => {
      mockLinksFetch({ links: [MEMBER_LINK] });
      mockRolesFetch([]);
      vi.mocked(del).mockRejectedValueOnce(new Error('server error'));

      const { result } = renderHook(() => useDriveShareLink(DRIVE_ID));
      await waitFor(() => expect(result.current.isLoading).toBe(false));

      await act(async () => {
        await result.current.handleRevoke(LINK_ID);
      });

      expect(result.current.links).toHaveLength(1);
      expect(toast.error).toHaveBeenCalled();
    });

    it('revokingId should be set during DELETE and cleared after', async () => {
      mockLinksFetch({ links: [MEMBER_LINK] });
      mockRolesFetch([]);
      let resolveDelete!: () => void;
      vi.mocked(del).mockReturnValueOnce(new Promise<void>(res => { resolveDelete = res; }));

      const { result } = renderHook(() => useDriveShareLink(DRIVE_ID));
      await waitFor(() => expect(result.current.isLoading).toBe(false));

      act(() => { result.current.handleRevoke(LINK_ID); });
      expect(result.current.revokingId).toBe(LINK_ID);

      await act(async () => { resolveDelete(); });
      expect(result.current.revokingId).toBeNull();
    });
  });

  describe('role state', () => {
    it('should default selectedRole to member when no isDefault custom role exists', async () => {
      mockLinksFetch({ links: [] });
      mockRolesFetch([]);

      const { result } = renderHook(() => useDriveShareLink(DRIVE_ID));
      await waitFor(() => expect(result.current.isLoading).toBe(false));

      expect(result.current.selectedRole).toEqual({ kind: 'member' });
    });

    it('should auto-select the isDefault custom role when one exists', async () => {
      mockLinksFetch({ links: [] });
      mockRolesFetch([
        { id: 'role-1', name: 'Viewer', isDefault: false },
        { id: 'role-2', name: 'Member Default', isDefault: true },
      ]);

      const { result } = renderHook(() => useDriveShareLink(DRIVE_ID));
      await waitFor(() => expect(result.current.isLoading).toBe(false));

      expect(result.current.selectedRole).toEqual({ kind: 'custom', customRoleId: 'role-2' });
    });

    it('should expose setSelectedRole to change the role used for generation', async () => {
      mockLinksFetch({ links: [] });
      mockRolesFetch([]);

      const { result } = renderHook(() => useDriveShareLink(DRIVE_ID));
      await waitFor(() => expect(result.current.isLoading).toBe(false));

      act(() => { result.current.setSelectedRole({ kind: 'admin' }); });

      expect(result.current.selectedRole).toEqual({ kind: 'admin' });
    });

    it('should reset selectedRole to member when driveId changes', async () => {
      // First drive has a default custom role → selectedRole becomes 'custom'
      mockLinksFetch({ links: [] });
      mockRolesFetch([{ id: 'role-drive-1', name: 'Editor', isDefault: true }]);

      const { result, rerender } = renderHook(
        ({ driveId }: { driveId: string }) => useDriveShareLink(driveId),
        { initialProps: { driveId: 'drive-1' } },
      );
      await waitFor(() => expect(result.current.isLoading).toBe(false));
      expect(result.current.selectedRole).toEqual({ kind: 'custom', customRoleId: 'role-drive-1' });

      // Switch to a drive with no roles → selectedRole must reset to 'member'
      mockLinksFetch({ links: [] });
      mockRolesFetch([]);

      rerender({ driveId: 'drive-2' });
      // Wait for the eager reset to flush and loading to complete
      await waitFor(() => expect(result.current.selectedRole).toEqual({ kind: 'member' }));
      await waitFor(() => expect(result.current.isLoading).toBe(false));
      // Confirm still 'member' after roles load (no default role on drive-2)
      expect(result.current.selectedRole).toEqual({ kind: 'member' });
    });
  });
});
