import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useDocumentManagerStore } from '@/stores/useDocumentManagerStore';

vi.mock('@/lib/auth/auth-fetch', () => ({
  fetchWithAuth: vi.fn(),
}));

vi.mock('sonner', () => ({
  toast: { error: vi.fn(), success: vi.fn() },
}));

vi.mock('@/hooks/useSocket', () => ({
  useSocket: vi.fn(() => ({ id: 'socket-123' })),
}));

import { PageSetupButton } from '../PageSetupButton';
import { fetchWithAuth } from '@/lib/auth/auth-fetch';
import { toast } from 'sonner';

const pageId = 'page-123';

/**
 * Converting content mode saves the document first. This PR made a parked save
 * conflict block every write, so that save now returns false — and the old
 * "save your changes first" message became advice the user cannot act on,
 * because the guard is exactly what stops them saving. These tests pin which
 * message each state produces so the branch is not later deleted as redundant.
 */
describe('PageSetupButton content-mode conversion', () => {
  beforeEach(() => {
    useDocumentManagerStore.setState({
      documents: new Map(),
      activeDocumentId: null,
      savingDocuments: new Set(),
      conflicts: new Map(),
      resolvingConflicts: new Set(),
    });
    vi.clearAllMocks();
    // jsdom does not implement window.confirm; the conversion flow gates on it.
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    // The SWR page fetch, so the button renders enabled in 'html' mode.
    vi.mocked(fetchWithAuth).mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ contentMode: 'html' }),
    } as Response);
  });

  const openAndPickMarkdown = async () => {
    const user = userEvent.setup();
    await waitFor(() => expect(screen.getByRole('button')).toBeEnabled());
    await user.click(screen.getByRole('button'));
    await user.click(await screen.findByRole('menuitemradio', { name: /markdown/i }));
  };

  it('given a parked conflict, should tell the user to resolve it rather than to save first', async () => {
    useDocumentManagerStore.getState().upsertDocument(pageId, 'my text', 'html', 3);
    useDocumentManagerStore.getState().updateDocument(pageId, { isDirty: true });
    useDocumentManagerStore.getState().setConflict(pageId, {
      remoteContent: 'their text',
      remoteRevision: 4,
      detectedAt: 1,
    });

    render(<PageSetupButton pageId={pageId} />);
    await openAndPickMarkdown();

    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith(
        'Resolve the editing conflict on this page before converting'
      )
    );
  });

  it('given a save that fails without parking a conflict, should keep the save-your-changes message', async () => {
    useDocumentManagerStore.getState().upsertDocument(pageId, 'my text', 'html', 3);
    useDocumentManagerStore.getState().updateDocument(pageId, { isDirty: true });

    // A 409 whose follow-up refetch fails: saveDocument returns false but parks
    // NO conflict (it will not offer a resolution it cannot honour), which is
    // the reachable path where "save your changes" is still the right advice.
    let patched = false;
    vi.mocked(fetchWithAuth).mockImplementation((_url, init) => {
      if (init?.method === 'PATCH') {
        patched = true;
        return Promise.resolve({
          ok: false,
          status: 409,
          json: () => Promise.resolve({ error: 'Page was modified', currentRevision: 4 }),
        } as Response);
      }
      if (patched) return Promise.reject(new Error('network down'));
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ contentMode: 'html' }),
      } as Response);
    });

    render(<PageSetupButton pageId={pageId} />);
    await openAndPickMarkdown();

    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith('Please save your changes before converting')
    );
    expect(useDocumentManagerStore.getState().conflicts.has(pageId)).toBe(false);
  });
});
