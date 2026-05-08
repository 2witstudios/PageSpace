import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { assert } from '@/stores/__tests__/riteway';

// ============================================================================
// Smoke tests for the ShareDialog off-platform invite branch.
//
// Validates that:
//   1. A 404 from /api/users/find surfaces the invite-CTA button label.
//   2. Clicking the invite CTA POSTs to /share-invite with the right payload.
//   3. DELETE is excluded from the share-invite payload on the off-platform path.
// ============================================================================

vi.mock('sonner', () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
  },
}));

vi.mock('@/lib/auth/auth-fetch', () => ({
  fetchWithAuth: vi.fn(),
  post: vi.fn(),
}));

vi.mock('@/hooks/usePage', () => ({
  usePageStore: vi.fn((selector: (s: { pageId: string }) => string) =>
    selector({ pageId: 'page_abc' })
  ),
}));

vi.mock('@/hooks/usePageTree', () => ({
  usePageTree: vi.fn(() => ({
    tree: [
      {
        id: 'page_abc',
        title: 'Test Page',
        children: [],
        type: 'document',
        driveId: 'drive_xyz',
        isTrashed: false,
        order: 0,
        parentId: null,
      },
    ],
  })),
}));

vi.mock('@/lib/tree/tree-utils', () => ({
  findNodeAndParent: vi.fn(() => ({
    node: {
      id: 'page_abc',
      title: 'Test Page',
      children: [],
      type: 'document',
      driveId: 'drive_xyz',
      isTrashed: false,
      order: 0,
      parentId: null,
    },
    parent: null,
  })),
}));

vi.mock('next/navigation', () => ({
  useParams: vi.fn(() => ({ driveId: 'drive_xyz' })),
}));

vi.mock('@/hooks/usePermissions', () => ({
  usePermissions: vi.fn(() => ({
    permissions: { canView: true, canEdit: true, canShare: true, canDelete: true },
  })),
  getPermissionErrorMessage: vi.fn(() => 'You need share permission'),
}));

vi.mock('@/hooks/useMobile', () => ({
  useMobile: vi.fn(() => false),
}));

vi.mock(
  '@/components/layout/middle-content/content-header/page-settings/PermissionsList',
  () => ({
    PermissionsList: () => <div data-testid="permissions-list" />,
  }),
);

import { fetchWithAuth, post } from '@/lib/auth/auth-fetch';
import { toast } from 'sonner';
import { ShareDialog } from '../ShareDialog';

const make404Response = () =>
  new Response(JSON.stringify({ error: 'User not found' }), {
    status: 404,
    headers: { 'Content-Type': 'application/json' },
  });

const make200UserResponse = () =>
  new Response(JSON.stringify({ id: 'user_existing' }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });

const makeInviteSuccess = () =>
  new Response(JSON.stringify({ kind: 'invited', email: 'new@example.com' }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });

describe('ShareDialog — off-platform invite branch', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const openDialogAndFillEmail = async (
    user: ReturnType<typeof userEvent.setup>,
    email: string,
  ) => {
    const shareButton = screen.getByRole('button', { name: /share/i });
    await user.click(shareButton);
    const emailInput = screen.getByPlaceholderText(/add people by email/i);
    await user.clear(emailInput);
    await user.type(emailInput, email);
  };

  it('given /api/users/find returns 404, renders the invite-to-PageSpace CTA button', async () => {
    vi.mocked(fetchWithAuth).mockResolvedValue(make404Response());

    const user = userEvent.setup();
    render(<ShareDialog />);

    await openDialogAndFillEmail(user, 'new@example.com');

    const grantButton = screen.getByRole('button', { name: /grant access/i });
    await user.click(grantButton);

    await waitFor(() => {
      const inviteButton = screen.getByRole('button', {
        name: /invite.*pagespace.*share this page/i,
      });
      assert({
        given: 'a 404 from /api/users/find',
        should: 'show invite-to-PageSpace CTA button',
        actual: inviteButton !== null,
        expected: true,
      });
    });
  });

  it('given user clicks invite CTA, POSTs to /share-invite with VIEW permission', async () => {
    vi.mocked(fetchWithAuth)
      .mockResolvedValueOnce(make404Response())   // /api/users/find
      .mockResolvedValueOnce(makeInviteSuccess()); // /share-invite

    const user = userEvent.setup();
    render(<ShareDialog />);

    await openDialogAndFillEmail(user, 'new@example.com');
    const grantButton = screen.getByRole('button', { name: /grant access/i });
    await user.click(grantButton);

    await waitFor(() => {
      screen.getByRole('button', { name: /invite.*pagespace.*share this page/i });
    });

    const inviteButton = screen.getByRole('button', { name: /invite.*pagespace.*share this page/i });
    await user.click(inviteButton);

    await waitFor(() => {
      const calls = vi.mocked(fetchWithAuth).mock.calls;
      const shareInviteCall = calls.find(([url]) =>
        typeof url === 'string' && url.includes('/share-invite'),
      );
      assert({
        given: 'user clicks the invite CTA',
        should: 'POST to /share-invite',
        actual: shareInviteCall !== undefined,
        expected: true,
      });

      if (shareInviteCall) {
        const options = shareInviteCall[1] as RequestInit;
        const body = JSON.parse(options.body as string) as {
          email: string;
          permissions: string[];
        };
        assert({
          given: 'only VIEW is selected',
          should: 'send permissions: ["VIEW"]',
          actual: body.permissions,
          expected: ['VIEW'],
        });
      }
    });
  });

  it('given DELETE is checked before 404, the share-invite payload does NOT include DELETE', async () => {
    vi.mocked(fetchWithAuth)
      .mockResolvedValueOnce(make404Response())
      .mockResolvedValueOnce(makeInviteSuccess());

    const user = userEvent.setup();
    render(<ShareDialog />);

    await openDialogAndFillEmail(user, 'new@example.com');

    // Check the Delete checkbox before looking up the user
    const deleteCheckbox = screen.getByRole('checkbox', { name: /delete/i });
    await user.click(deleteCheckbox);

    const grantButton = screen.getByRole('button', { name: /grant access/i });
    await user.click(grantButton);

    await waitFor(() => {
      screen.getByRole('button', { name: /invite.*pagespace.*share this page/i });
    });

    const inviteButton = screen.getByRole('button', { name: /invite.*pagespace.*share this page/i });
    await user.click(inviteButton);

    await waitFor(() => {
      const calls = vi.mocked(fetchWithAuth).mock.calls;
      const shareInviteCall = calls.find(([url]) =>
        typeof url === 'string' && url.includes('/share-invite'),
      );
      if (shareInviteCall) {
        const options = shareInviteCall[1] as RequestInit;
        const body = JSON.parse(options.body as string) as { permissions: string[] };
        assert({
          given: 'DELETE was checked before the 404',
          should: 'not include DELETE in the share-invite payload',
          actual: body.permissions.includes('DELETE'),
          expected: false,
        });
      }
    });
  });

  it('given /api/users/find returns 200, uses the direct grant path (not share-invite)', async () => {
    vi.mocked(fetchWithAuth).mockResolvedValueOnce(make200UserResponse());
    vi.mocked(post).mockResolvedValueOnce({ id: 'perm_1' });

    const user = userEvent.setup();
    render(<ShareDialog />);

    await openDialogAndFillEmail(user, 'existing@example.com');
    const grantButton = screen.getByRole('button', { name: /grant access/i });
    await user.click(grantButton);

    await waitFor(() => {
      const shareInviteCall = vi.mocked(fetchWithAuth).mock.calls.find(([url]) =>
        typeof url === 'string' && url.includes('/share-invite'),
      );
      assert({
        given: '/api/users/find returns 200',
        should: 'not call /share-invite',
        actual: shareInviteCall,
        expected: undefined,
      });
      expect(post).toHaveBeenCalledWith(
        expect.stringContaining('/permissions'),
        expect.objectContaining({ userId: 'user_existing' }),
      );
    });
  });
});
