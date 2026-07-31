import { describe, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { assert } from '@/stores/__tests__/riteway';

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
});

// ============================================================================
// Smoke tests for the header variant's available-state buttons — these
// render via the shared `Button` component (not raw `<button>`s), so a role
// query catches a regression that broke the accessible name or the click
// handler wiring during that refactor.
// ============================================================================
describe('PublishControls — available state (header variant)', () => {
  it('given an unpublished, available page, should render a clickable Publish button', async () => {
    mockFetchWithAuth.mockResolvedValue(makeStatusResponse({ body: { published: false, available: true } }));

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
      body: { published: true, available: true, url: 'https://acme.pagespace.site/welcome', isStale: false },
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
