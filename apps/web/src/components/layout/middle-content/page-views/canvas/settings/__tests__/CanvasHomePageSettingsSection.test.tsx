import { describe, it, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { assert } from '@/stores/__tests__/riteway';

// ============================================================================
// Regression test for a Codex-flagged bug: a canvas page's published URL
// depends on whether it's the drive's home page (served at the root vs its
// slug — see the publish GET route). Toggling home-page assignment updated
// only the drive store, leaving `usePublishStatusStore`'s cached url/isHomePage
// stale — the header could keep displaying (and letting Copy link copy) a
// URL that no longer matches what's actually served, until remount. The fix
// refetches this page's publish status right after the drive PATCH succeeds.
// ============================================================================

vi.mock('next/navigation', () => ({
  useParams: vi.fn(() => ({ driveId: 'drive_xyz' })),
}));

vi.mock('sonner', () => ({
  toast: { loading: vi.fn(() => 'toast-id'), success: vi.fn(), error: vi.fn() },
}));

vi.mock('@/lib/auth/auth-fetch', () => ({
  patch: vi.fn(),
}));

import { patch } from '@/lib/auth/auth-fetch';
import { CanvasHomePageSettingsSection } from '../CanvasHomePageSettingsSection';
import { useDriveStore } from '@/hooks/useDrive';
import { usePublishStatusStore } from '@/stores/usePublishStatusStore';

const mockPatch = vi.mocked(patch);

const OWNED_DRIVE = { id: 'drive_xyz', name: 'Acme', isOwned: true, homePageId: null, notFoundPageId: null } as ReturnType<typeof useDriveStore.getState>['drives'][number];

beforeEach(() => {
  mockPatch.mockReset();
  mockPatch.mockResolvedValue({});
  useDriveStore.setState({ drives: [OWNED_DRIVE], isLoading: false, lastFetched: Date.now() });
  const fetchStatusSpy = vi.fn().mockResolvedValue(undefined);
  usePublishStatusStore.setState({ statuses: new Map(), inFlight: new Map(), fetchStatus: fetchStatusSpy });
});

describe('CanvasHomePageSettingsSection — publish status refresh', () => {
  it('given a successful "Set as home page", should refetch this page\'s publish status', async () => {
    render(<CanvasHomePageSettingsSection pageId="page_1" />);

    const setHomeButton = await screen.findByRole('button', { name: 'Set as home page' });
    await userEvent.click(setHomeButton);

    assert({
      given: 'a successful drive PATCH setting this page as home',
      should: "refetch usePublishStatusStore's cached status for this page (its url depends on isHomePage)",
      actual: vi.mocked(usePublishStatusStore.getState().fetchStatus).mock.calls,
      expected: [['page_1']],
    });
  });
});
