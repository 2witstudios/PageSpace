import { describe, it, vi, beforeEach } from 'vitest';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { assert } from '@/stores/__tests__/riteway';

// ============================================================================
// Regression test for a Codex-flagged bug: this category seeded its draft
// form from `usePublishStatusStore` ONCE (a one-shot ref guard) and never
// again. If the header's Publish settings dialog saved different SEO values
// while this category stayed open, the shared store updated but this form
// kept showing the old values — and clicking Save here would silently roll
// the header's change back. The fix reseeds whenever the store changes AND
// the form is still pristine (untouched), while still protecting a genuine
// in-progress edit from being clobbered.
// ============================================================================

vi.mock('next/navigation', () => ({
  useParams: vi.fn(() => ({ driveId: 'drive_xyz' })),
}));

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

vi.mock('@/lib/auth/auth-fetch', () => ({
  fetchWithAuth: vi.fn(),
}));

import { fetchWithAuth } from '@/lib/auth/auth-fetch';
import { CanvasPublishSettingsSection } from '../CanvasPublishSettingsSection';
import { usePublishStatusStore, EMPTY_PUBLISH_STATUS } from '@/stores/usePublishStatusStore';

const mockFetchWithAuth = vi.mocked(fetchWithAuth);

beforeEach(() => {
  usePublishStatusStore.setState({ statuses: new Map(), inFlight: new Map() });
  mockFetchWithAuth.mockReset();
});

describe('CanvasPublishSettingsSection — pristine reseed', () => {
  it('given the store updates externally while the form is untouched, should reseed the displayed title', async () => {
    mockFetchWithAuth.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ published: true, title: 'Original Title' }),
    } as Response);

    render(<CanvasPublishSettingsSection pageId="page_1" />);

    const titleInput = await screen.findByDisplayValue('Original Title');

    // Simulates the header's Publish settings dialog saving a different
    // title while this category stays mounted.
    act(() => {
      usePublishStatusStore.getState().setStatus('page_1', {
        ...EMPTY_PUBLISH_STATUS,
        published: true,
        available: true,
        settings: { title: 'Updated From Header', description: '', ogImageUrl: '', noindex: false, themeBridgeEnabled: true },
      });
    });

    await waitFor(() => {
      assert({
        given: 'an external status update while the form is pristine',
        should: 'reseed the title field from the new settings',
        actual: titleInput.getAttribute('value'),
        expected: 'Updated From Header',
      });
    });
  });

  it('given the user has edited the form, should NOT clobber the edit when the store updates externally', async () => {
    mockFetchWithAuth.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ published: true, title: 'Original Title' }),
    } as Response);

    render(<CanvasPublishSettingsSection pageId="page_1" />);

    const titleInput = await screen.findByDisplayValue('Original Title');
    await userEvent.clear(titleInput);
    await userEvent.type(titleInput, 'My In-Progress Edit');

    // An unrelated external update (e.g. the header marking the page stale)
    // must not overwrite the user's in-progress edit.
    act(() => {
      usePublishStatusStore.getState().setStatus('page_1', {
        ...EMPTY_PUBLISH_STATUS,
        published: true,
        available: true,
        isStale: true,
        settings: { title: 'Original Title', description: '', ogImageUrl: '', noindex: false, themeBridgeEnabled: true },
      });
    });

    assert({
      given: 'an in-progress edit and an unrelated external status change',
      should: "keep showing the user's edited title, not the reseeded one",
      actual: titleInput.getAttribute('value'),
      expected: 'My In-Progress Edit',
    });
  });
});
