import { describe, it, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { assert } from '@/stores/__tests__/riteway';

// ============================================================================
// Regression guard: handleToggle only sends { themeBridgeEnabled } in its POST
// body, but the server always returns the full effective settings in
// response. This section must read every field back from that response
// rather than spreading the locally cached settings for the ones it didn't
// touch — the same "trust the response, not the cache" fix PublishControls'
// handlePublish needed after a real bug there (Codex-flagged, see
// PublishControls.test.tsx's unpublish/republish test).
// ============================================================================

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

vi.mock('@/lib/auth/auth-fetch', () => ({
  fetchWithAuth: vi.fn(),
}));

import { fetchWithAuth } from '@/lib/auth/auth-fetch';
import { CanvasAppearanceSettingsSection } from '../CanvasAppearanceSettingsSection';
import { usePublishStatusStore } from '@/stores/usePublishStatusStore';

const mockFetchWithAuth = vi.mocked(fetchWithAuth);

const makeResponse = (body: unknown) => ({ ok: true, status: 200, json: async () => body }) as Response;

beforeEach(() => {
  usePublishStatusStore.setState({ statuses: new Map(), inFlight: new Map() });
  mockFetchWithAuth.mockReset();
});

describe('CanvasAppearanceSettingsSection — settings after toggle', () => {
  it('given a stale cached title, toggling should adopt the title from the save response instead', async () => {
    mockFetchWithAuth
      // Initial GET on mount: cached title is stale relative to what a
      // concurrent header save (or an unpublish/republish) just persisted.
      .mockResolvedValueOnce(makeResponse({ published: true, canEdit: true, themeBridgeEnabled: true, title: 'Stale Cached Title' }))
      // POST from the toggle click: the server's authoritative response.
      .mockResolvedValueOnce(makeResponse({ themeBridgeEnabled: false, title: 'Fresh Server Title' }));

    render(<CanvasAppearanceSettingsSection pageId="page_1" />);

    const toggle = await screen.findByRole('switch');
    await userEvent.click(toggle);

    assert({
      given: 'a toggle save whose response includes a different title than the local cache',
      should: "adopt the response's title, not the stale cached one",
      actual: usePublishStatusStore.getState().statuses.get('page_1')?.settings.title,
      expected: 'Fresh Server Title',
    });
  });
});
