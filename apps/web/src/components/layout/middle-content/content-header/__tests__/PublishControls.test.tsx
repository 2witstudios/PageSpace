import { describe, it, expect, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';

// ============================================================================
// Smoke tests for PublishControls' unavailable-state branching.
//
// Validates that:
//   1. A successful response reporting `available: false` (unconfigured,
//      disabled, or a read-only viewer's 403) shows the "isn't available"
//      panel message — a durable, expected state.
//   2. A transient load failure (5xx, network error) shows a distinct
//      "couldn't load" message instead of the same durable-sounding text.
//   3. The 'header' variant (default) stays silent (renders null) in both
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

describe('PublishControls unavailable states', () => {
  it('given a read-only viewer (403), panel variant shows the durable unavailable message', async () => {
    mockFetchWithAuth.mockResolvedValue({
      ok: false,
      status: 403,
      json: async () => ({ error: 'You do not have permission to view this page' }),
    } as Response);

    render(<PublishControls pageId="page_1" variant="panel" />);

    expect(await screen.findByText("Publishing isn't available for this page.")).toBeInTheDocument();
  });

  it('given publishing unconfigured (200, available: false), panel variant shows the durable unavailable message', async () => {
    mockFetchWithAuth.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ published: false, available: false }),
    } as Response);

    render(<PublishControls pageId="page_1" variant="panel" />);

    expect(await screen.findByText("Publishing isn't available for this page.")).toBeInTheDocument();
  });

  it('given a server error (500), panel variant shows a distinct load-failure message', async () => {
    mockFetchWithAuth.mockResolvedValue({
      ok: false,
      status: 500,
      json: async () => ({ error: 'Failed to read publish status' }),
    } as Response);

    render(<PublishControls pageId="page_1" variant="panel" />);

    expect(await screen.findByText("Couldn't load publishing status. Try again shortly.")).toBeInTheDocument();
    expect(screen.queryByText("Publishing isn't available for this page.")).not.toBeInTheDocument();
  });

  it('given a network error, panel variant shows a distinct load-failure message', async () => {
    mockFetchWithAuth.mockRejectedValue(new Error('network down'));

    render(<PublishControls pageId="page_1" variant="panel" />);

    expect(await screen.findByText("Couldn't load publishing status. Try again shortly.")).toBeInTheDocument();
  });

  it('given a read-only viewer (403), header variant (default) renders nothing', async () => {
    mockFetchWithAuth.mockResolvedValue({
      ok: false,
      status: 403,
      json: async () => ({ error: 'You do not have permission to view this page' }),
    } as Response);

    const { container } = render(<PublishControls pageId="page_1" />);

    await waitFor(() => expect(mockFetchWithAuth).toHaveBeenCalled());
    await waitFor(() => expect(container).toBeEmptyDOMElement());
  });

  it('given a server error (500), header variant (default) renders nothing', async () => {
    mockFetchWithAuth.mockResolvedValue({
      ok: false,
      status: 500,
      json: async () => ({ error: 'Failed to read publish status' }),
    } as Response);

    const { container } = render(<PublishControls pageId="page_1" />);

    await waitFor(() => expect(mockFetchWithAuth).toHaveBeenCalled());
    await waitFor(() => expect(container).toBeEmptyDOMElement());
  });
});
