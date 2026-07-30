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

const make403Response = () =>
  ({
    ok: false,
    status: 403,
    json: async () => ({ error: 'You do not have permission to view this page' }),
  }) as Response;

const make500Response = () =>
  ({
    ok: false,
    status: 500,
    json: async () => ({ error: 'Failed to read publish status' }),
  }) as Response;

const makeUnavailableResponse = () =>
  ({
    ok: true,
    status: 200,
    json: async () => ({ published: false, available: false }),
  }) as Response;

describe('PublishControls — unavailable-state branching', () => {
  it('given a read-only viewer (403), panel variant should show the durable unavailable message', async () => {
    mockFetchWithAuth.mockResolvedValue(make403Response());

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
    mockFetchWithAuth.mockResolvedValue(makeUnavailableResponse());

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
    mockFetchWithAuth.mockResolvedValue(make500Response());

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
    mockFetchWithAuth.mockResolvedValue(make403Response());

    const { container } = render(<PublishControls pageId="page_1" />);
    await waitFor(() => assert({
      given: 'a read-only viewer whose status request 403s',
      should: 'render nothing in the default header variant',
      actual: container.textContent,
      expected: '',
    }));
  });

  it('given a server error (500), header variant (default) should render nothing', async () => {
    mockFetchWithAuth.mockResolvedValue(make500Response());

    const { container } = render(<PublishControls pageId="page_1" />);
    await waitFor(() => assert({
      given: 'a 500 from the status endpoint',
      should: 'render nothing in the default header variant (stays silent on transient failures too)',
      actual: container.textContent,
      expected: '',
    }));
  });
});
