import { describe, it, vi, beforeEach } from 'vitest';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { assert } from '@/stores/__tests__/riteway';
import { usePublishStatusStore } from '@/stores/usePublishStatusStore';

// ============================================================================
// Smoke tests for PublishControls' unavailable-state branching.
//
// Validates that:
//   1. A definitive unavailability signal (a read-only viewer's 403, or a
//      successful response reporting `available: false`) shows the panel
//      variant's durable "isn't available" message.
//   2. A transient load failure (5xx, network error) shows a distinct
//      "couldn't load" message instead of the same durable-sounding text.
//   3. The 'header' variant (default) stays silent (renders nothing) in both
//      cases, preserving its existing behavior among other header buttons.
// ============================================================================

vi.mock('next/navigation', () => ({
  useParams: vi.fn(() => ({ driveId: 'drive_xyz' })),
}));

vi.mock('sonner', () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock('@/lib/auth/auth-fetch', () => ({
  fetchWithAuth: vi.fn(),
}));

import { fetchWithAuth } from '@/lib/auth/auth-fetch';
import PublishControls from '../PublishControls';

const mockFetchWithAuth = vi.mocked(fetchWithAuth);

const makeStatusResponse = ({ status = 200, body = {} }: { status?: number; body?: unknown } = {}) =>
  ({ ok: status < 400, status, json: async () => body }) as Response;

// The status store is shared across every consumer (PublishControls, the
// canvas Settings tab's Publish/Appearance categories) by design — reset it
// between tests so one test's cached status for "page_1" can't leak into the
// next's initial render.
beforeEach(() => {
  usePublishStatusStore.setState({ statuses: new Map(), inFlight: new Map(), generations: new Map() });
});

describe('PublishControls — unavailable-state branching', () => {
  it('given a read-only viewer (403), panel variant should show the durable unavailable message', async () => {
    mockFetchWithAuth.mockResolvedValue(
      makeStatusResponse({ status: 403, body: { error: 'You do not have permission to view this page' } })
    );

    render(<PublishControls pageId="page_1" variant="panel" />);

    const message = await screen.findByText("Publishing isn't available for this page.");
    assert({
      given: 'a read-only viewer whose status request 403s',
      should: 'show the durable unavailable message in the panel variant',
      actual: message !== null,
      expected: true,
    });
  });

  it('given publishing unconfigured (200, available: false), panel variant should show the durable unavailable message', async () => {
    mockFetchWithAuth.mockResolvedValue(makeStatusResponse({ body: { published: false, available: false } }));

    render(<PublishControls pageId="page_1" variant="panel" />);

    const message = await screen.findByText("Publishing isn't available for this page.");
    assert({
      given: 'a successful response explicitly reporting available: false',
      should: 'show the durable unavailable message in the panel variant',
      actual: message !== null,
      expected: true,
    });
  });

  it('given a server error (500), panel variant should show a distinct load-failure message', async () => {
    mockFetchWithAuth.mockResolvedValue(
      makeStatusResponse({ status: 500, body: { error: 'Failed to read publish status' } })
    );

    render(<PublishControls pageId="page_1" variant="panel" />);

    const message = await screen.findByText("Couldn't load publishing status. Try again shortly.");
    assert({
      given: 'a 500 from the status endpoint',
      should: 'show a load-failure message, not the durable unavailable message',
      actual: [message !== null, screen.queryByText("Publishing isn't available for this page.")],
      expected: [true, null],
    });
  });

  it('given a network error, panel variant should show a distinct load-failure message', async () => {
    mockFetchWithAuth.mockRejectedValue(new Error('network down'));

    render(<PublishControls pageId="page_1" variant="panel" />);

    const message = await screen.findByText("Couldn't load publishing status. Try again shortly.");
    assert({
      given: 'a network error while loading status',
      should: 'show the load-failure message in the panel variant',
      actual: message !== null,
      expected: true,
    });
  });

  it('given a read-only viewer (403), header variant (default) should render nothing', async () => {
    mockFetchWithAuth.mockResolvedValue(
      makeStatusResponse({ status: 403, body: { error: 'You do not have permission to view this page' } })
    );

    const { container } = render(<PublishControls pageId="page_1" />);
    await waitFor(() => assert({
      given: 'a read-only viewer whose status request 403s',
      should: 'render nothing in the default header variant',
      actual: container.textContent,
      expected: '',
    }));
  });

  it('given a server error (500), header variant (default) should render nothing', async () => {
    mockFetchWithAuth.mockResolvedValue(
      makeStatusResponse({ status: 500, body: { error: 'Failed to read publish status' } })
    );

    const { container } = render(<PublishControls pageId="page_1" />);
    await waitFor(() => assert({
      given: 'a 500 from the status endpoint',
      should: 'render nothing in the default header variant (stays silent on transient failures too)',
      actual: container.textContent,
      expected: '',
    }));
  });

  it('given view-but-not-edit access to an unpublished page (available: true, canEdit: false), header variant should render nothing', async () => {
    // Regression test for a Codex-flagged bug: this branch used to key off
    // `available` alone, so a view-only viewer on an unpublished page saw
    // an enabled Publish button that only revealed the permission failure
    // once its own POST 403'd.
    mockFetchWithAuth.mockResolvedValue(
      makeStatusResponse({ body: { published: false, available: true, canEdit: false } })
    );

    const { container } = render(<PublishControls pageId="page_1" />);
    await waitFor(() => assert({
      given: 'a view-only viewer on an unpublished-but-available page',
      should: 'render nothing rather than an enabled Publish button',
      actual: container.textContent,
      expected: '',
    }));
  });
});

// ============================================================================
// Smoke tests for the header variant's available-state buttons — these
// render via the shared `Button` component (not raw `<button>`s), so a role
// query catches a regression that broke the accessible name or the click
// handler wiring during that refactor.
// ============================================================================
describe('PublishControls — available state (header variant)', () => {
  it('given an unpublished, available page, should render a clickable Publish button', async () => {
    mockFetchWithAuth.mockResolvedValue(makeStatusResponse({ body: { published: false, available: true, canEdit: true } }));

    render(<PublishControls pageId="page_1" />);

    const button = await screen.findByRole('button', { name: 'Publish' });
    assert({
      given: 'an unpublished but available page',
      should: 'render a Publish button',
      actual: button.tagName,
      expected: 'BUTTON',
    });
  });

  it('given a published page, should render Copy link and Unpublish buttons', async () => {
    mockFetchWithAuth.mockResolvedValue(makeStatusResponse({
      body: { published: true, canEdit: true, available: true, url: 'https://acme.pagespace.site/welcome', isStale: false },
    }));

    render(<PublishControls pageId="page_1" />);

    const copyLink = await screen.findByRole('button', { name: 'Copy link' });
    const unpublish = await screen.findByRole('button', { name: 'Unpublish' });
    assert({
      given: 'a published, available page',
      should: 'render both the Copy link and Unpublish buttons',
      actual: [copyLink.tagName, unpublish.tagName],
      expected: ['BUTTON', 'BUTTON'],
    });
  });
});

// ============================================================================
// Regression test for a Codex-flagged bug: unpublishing (DELETE) removes the
// published_pages row entirely, so a bare republish (no dialog overrides)
// gets fresh server defaults — but this component used to keep showing the
// PRE-unpublish cached settings in that case, so the dialog (and for
// Canvas, the live preview) disagreed with the published artifact and a
// later Save could silently restore values the server had already reset.
// ============================================================================
describe('PublishControls — settings after unpublish/republish', () => {
  it('given a bare republish after unpublishing, should adopt the server\'s fresh settings, not the pre-unpublish cache', async () => {
    mockFetchWithAuth
      // Initial GET on mount: published with a custom title and theme bridge off.
      .mockResolvedValueOnce(makeStatusResponse({
        body: {
          published: true, canEdit: true, available: true, url: 'https://acme.pagespace.site/welcome',
          title: 'Old Title', themeBridgeEnabled: false,
        },
      }))
      // DELETE (Unpublish click): no body needed, just ok.
      .mockResolvedValueOnce(makeStatusResponse({ body: {} }))
      // POST (Publish click, no overrides): the server recreated the row
      // with fresh defaults — no more custom title, theme bridge back on.
      .mockResolvedValueOnce(makeStatusResponse({
        body: {
          published: true, url: 'https://acme.pagespace.site/welcome',
          title: null, themeBridgeEnabled: true,
        },
      }));

    render(<PublishControls pageId="page_1" />);

    const unpublishButton = await screen.findByRole('button', { name: 'Unpublish' });
    await userEvent.click(unpublishButton);

    const publishButton = await screen.findByRole('button', { name: 'Publish' });
    await userEvent.click(publishButton);

    await waitFor(() => {
      const status = usePublishStatusStore.getState().statuses.get('page_1');
      assert({
        given: 'a republish with no overrides, immediately after unpublishing',
        should: "adopt the server's fresh (reset) settings instead of the pre-unpublish cache",
        actual: [status?.settings.title, status?.settings.themeBridgeEnabled],
        expected: ['', true],
      });
    });
  });
});

// ============================================================================
// Regression test for a Codex-flagged bug: PublishSettingsDialog re-seeded its
// form whenever its `initial` prop changed — but the parent recreates that
// object (a plain literal derived from `status.settings`) on every render, so
// ANY unrelated parent re-render while the dialog stayed open (a shared
// status refresh completing, contentDirty flipping) reset whatever the user
// had already typed. Fixed by reseeding on the closed→open transition only.
// ============================================================================
describe('PublishControls — Publish settings dialog stays stable while open', () => {
  it('given an unrelated store update while the dialog is open, should NOT reset an in-progress edit', async () => {
    mockFetchWithAuth.mockResolvedValue(makeStatusResponse({
      body: { published: true, canEdit: true, available: true, url: 'https://acme.pagespace.site/welcome', title: 'Original Title' },
    }));

    render(<PublishControls pageId="page_1" />);

    const settingsButton = await screen.findByRole('button', { name: 'Publish settings' });
    await userEvent.click(settingsButton);

    const titleInput = await screen.findByLabelText('Title');
    await userEvent.clear(titleInput);
    await userEvent.type(titleInput, 'My In-Progress Edit');

    // Simulates an unrelated parent re-render while the dialog stays open —
    // e.g. a shared usePublishStatusStore refresh from another mounted
    // consumer (a Settings category, CanvasPageView's preview) completing.
    // This recreates PublishControls' `dialogSettings` object with the SAME
    // underlying values, but a new reference — exactly what used to
    // retrigger the dialog's reseed effect.
    act(() => {
      const current = usePublishStatusStore.getState().statuses.get('page_1');
      if (current) {
        usePublishStatusStore.getState().setStatus('page_1', { ...current, isStale: true });
      }
    });

    assert({
      given: 'an unrelated store update while the Publish settings dialog is open with an in-progress edit',
      should: "keep showing the user's edited title, not reseed from the (unrelated) refreshed status",
      actual: (screen.getByLabelText('Title') as HTMLInputElement).value,
      expected: 'My In-Progress Edit',
    });
  });
});
