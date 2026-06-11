import { describe, it, beforeEach, vi } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { assert } from '@/stores/__tests__/riteway';

// ============================================================================
// Tests for PageLinkSection — surfaces the direct page link and page ID in
// the share dialog so users (especially on desktop, which has no address
// bar) can copy them.
// ============================================================================

vi.mock('sonner', () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
  },
}));

import { toast } from 'sonner';
import { PageLinkSection } from '../PageLinkSection';

const writeText = vi.fn().mockResolvedValue(undefined);

describe('PageLinkSection', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // jsdom's navigator.clipboard is getter-only; redefine it for the spy
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText },
      configurable: true,
    });
  });

  it('given a pageId and driveId, renders the direct page link built from the current origin', async () => {
    render(<PageLinkSection pageId="page_abc" driveId="drive_xyz" />);

    await waitFor(() => {
      const linkInput = screen.getByLabelText('Page link') as HTMLInputElement;
      assert({
        given: 'a pageId and driveId',
        should: 'render the /dashboard/{driveId}/{pageId} link on the current origin',
        actual: linkInput.value,
        expected: `${window.location.origin}/dashboard/drive_xyz/page_abc`,
      });
    });
  });

  it('given the page ID field, shows the raw page ID', () => {
    render(<PageLinkSection pageId="page_abc" driveId="drive_xyz" />);

    const idInput = screen.getByLabelText('Page ID') as HTMLInputElement;
    assert({
      given: 'a pageId',
      should: 'show the raw page ID in its own field',
      actual: idInput.value,
      expected: 'page_abc',
    });
  });

  it('given a click on the copy-link button, writes the page link to the clipboard', async () => {
    render(<PageLinkSection pageId="page_abc" driveId="drive_xyz" />);

    await waitFor(() => screen.getByLabelText('Page link'));
    fireEvent.click(screen.getByRole('button', { name: 'Copy page link' }));

    await waitFor(() => {
      assert({
        given: 'a click on the copy-link button',
        should: 'write the page link to the clipboard',
        actual: writeText.mock.calls[0]?.[0],
        expected: `${window.location.origin}/dashboard/drive_xyz/page_abc`,
      });
      assert({
        given: 'a successful copy',
        should: 'show a success toast',
        actual: vi.mocked(toast.success).mock.calls.length > 0,
        expected: true,
      });
    });
  });

  it('given a click on the copy-ID button, writes the page ID to the clipboard', async () => {
    render(<PageLinkSection pageId="page_abc" driveId="drive_xyz" />);

    fireEvent.click(screen.getByRole('button', { name: 'Copy page ID' }));

    await waitFor(() => {
      assert({
        given: 'a click on the copy-ID button',
        should: 'write the page ID to the clipboard',
        actual: writeText.mock.calls[0]?.[0],
        expected: 'page_abc',
      });
    });
  });

  it('given the clipboard write fails, shows an error toast', async () => {
    writeText.mockRejectedValueOnce(new Error('denied'));
    render(<PageLinkSection pageId="page_abc" driveId="drive_xyz" />);

    fireEvent.click(screen.getByRole('button', { name: 'Copy page ID' }));

    await waitFor(() => {
      assert({
        given: 'a clipboard write failure',
        should: 'show an error toast instead of a success toast',
        actual: vi.mocked(toast.error).mock.calls.length > 0,
        expected: true,
      });
    });
  });

  it('given navigator.clipboard is undefined (non-secure origin), shows an error toast instead of throwing', async () => {
    Object.defineProperty(navigator, 'clipboard', {
      value: undefined,
      configurable: true,
    });
    render(<PageLinkSection pageId="page_abc" driveId="drive_xyz" />);

    fireEvent.click(screen.getByRole('button', { name: 'Copy page ID' }));

    await waitFor(() => {
      assert({
        given: 'navigator.clipboard is undefined',
        should: 'show an error toast and not throw an unhandled rejection',
        actual: vi.mocked(toast.error).mock.calls.length > 0,
        expected: true,
      });
      assert({
        given: 'navigator.clipboard is undefined',
        should: 'not show a success toast',
        actual: vi.mocked(toast.success).mock.calls.length,
        expected: 0,
      });
    });
  });
});
