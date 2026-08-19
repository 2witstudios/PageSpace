import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useDocumentManagerStore } from '@/stores/useDocumentManagerStore';
import { useDirtyStore } from '@/stores/useDirtyStore';

vi.mock('@/lib/auth/auth-fetch', () => ({
  fetchWithAuth: vi.fn().mockResolvedValue({
    ok: true,
    json: () => Promise.resolve({ content: 'test', revision: 1 }),
  }),
}));

vi.mock('../useSocket', () => ({
  useSocket: vi.fn(() => ({ id: 'socket-123' })),
}));

vi.mock('sonner', () => ({
  toast: { error: vi.fn() },
}));

import { useDocumentSaving, useDocument } from '../useDocument';
import { fetchWithAuth } from '@/lib/auth/auth-fetch';

describe('useDocument dirty flag integration', () => {
  beforeEach(() => {
    useDocumentManagerStore.setState({
      documents: new Map(),
      activeDocumentId: null,
      savingDocuments: new Set(),
      conflicts: new Map(),
      resolvingConflicts: new Set(),
    });
    useDirtyStore.setState({ dirtyFlags: {} });
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('useDocumentSaving', () => {
    it('given a document save succeeds, should call clearDirty with the page ID', async () => {
      const pageId = 'page-123';

      useDocumentManagerStore.getState().upsertDocument(pageId, 'content', 'html');
      useDocumentManagerStore.getState().updateDocument(pageId, { isDirty: true });
      useDirtyStore.getState().setDirty(pageId, true);

      expect(useDirtyStore.getState().isDirty(pageId)).toBe(true);

      const { result } = renderHook(() => useDocumentSaving(pageId));

      await act(async () => {
        await result.current.saveDocument('content');
      });

      expect(useDirtyStore.getState().isDirty(pageId)).toBe(false);
      expect(useDirtyStore.getState().dirtyFlags[pageId]).toBeUndefined();
    });

    it('given a document save succeeds, should update stored revision from response', async () => {
      const pageId = 'page-123';

      useDocumentManagerStore.getState().upsertDocument(pageId, 'content', 'html');
      useDocumentManagerStore.getState().updateDocument(pageId, { revision: 5 });

      vi.mocked(fetchWithAuth).mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ content: 'content', revision: 6 }),
      } as Response);

      const { result } = renderHook(() => useDocumentSaving(pageId));

      await act(async () => {
        await result.current.saveDocument('content');
      });

      const doc = useDocumentManagerStore.getState().documents.get(pageId);
      expect(doc?.revision).toBe(6);
    });

    it('given a document save fails, should retain the dirty flag for retry', async () => {
      const pageId = 'page-123';

      useDocumentManagerStore.getState().upsertDocument(pageId, 'content', 'html');
      useDocumentManagerStore.getState().updateDocument(pageId, { isDirty: true });
      useDirtyStore.getState().setDirty(pageId, true);

      vi.mocked(fetchWithAuth).mockResolvedValueOnce({
        ok: false,
        status: 500,
        json: () => Promise.resolve({ error: 'Server error' }),
      } as Response);

      const { result } = renderHook(() => useDocumentSaving(pageId));

      await act(async () => {
        try {
          await result.current.saveDocument('content');
        } catch {
          // Expected to fail
        }
      });

      expect(useDirtyStore.getState().isDirty(pageId)).toBe(true);
    });

    it('given a 409 conflict response, should preserve the local buffer and park the server copy', async () => {
      const pageId = 'page-123';
      const { toast } = await import('sonner');

      useDocumentManagerStore.getState().upsertDocument(pageId, 'my unsaved edits', 'html', 3);
      useDocumentManagerStore.getState().updateDocument(pageId, { isDirty: true });
      useDirtyStore.getState().setDirty(pageId, true);

      vi.mocked(fetchWithAuth).mockResolvedValueOnce({
        ok: false,
        status: 409,
        json: () => Promise.resolve({ error: 'Page was modified', currentRevision: 4, expectedRevision: 3 }),
      } as Response);
      vi.mocked(fetchWithAuth).mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ content: 'newer content', revision: 4 }),
      } as Response);

      const { result } = renderHook(() => useDocumentSaving(pageId));

      let saveResult: boolean | undefined;
      await act(async () => {
        saveResult = await result.current.saveDocument('my unsaved edits');
      });

      expect(saveResult).toBe(false);

      // The user's text is untouched — this is the whole point of the fix.
      const doc = useDocumentManagerStore.getState().documents.get(pageId);
      expect(doc?.content).toBe('my unsaved edits');
      expect(doc?.isDirty).toBe(true);
      expect(useDirtyStore.getState().isDirty(pageId)).toBe(true);

      // The server's copy is parked, not merged.
      const conflict = useDocumentManagerStore.getState().conflicts.get(pageId);
      expect(conflict?.remoteContent).toBe('newer content');
      expect(conflict?.remoteRevision).toBe(4);
      expect(typeof conflict?.detectedAt).toBe('number');

      expect(toast.error).toHaveBeenCalledWith(
        'Document was modified elsewhere. Your unsaved changes are still here — choose which version to keep.',
        { id: `conflict-${pageId}` },
      );
    });

    it('given a 409 whose refetch fails, should keep local edits and park no conflict', async () => {
      const pageId = 'page-123';

      useDocumentManagerStore.getState().upsertDocument(pageId, 'my unsaved edits', 'html', 3);
      useDocumentManagerStore.getState().updateDocument(pageId, { isDirty: true });
      useDirtyStore.getState().setDirty(pageId, true);

      vi.mocked(fetchWithAuth).mockResolvedValueOnce({
        ok: false,
        status: 409,
        json: () => Promise.resolve({ error: 'Page was modified', currentRevision: 4, expectedRevision: 3 }),
      } as Response);
      vi.mocked(fetchWithAuth).mockRejectedValueOnce(new Error('network down'));

      const { result } = renderHook(() => useDocumentSaving(pageId));

      let saveResult: boolean | undefined;
      await act(async () => {
        saveResult = await result.current.saveDocument('my unsaved edits');
      });

      expect(saveResult).toBe(false);
      const doc = useDocumentManagerStore.getState().documents.get(pageId);
      expect(doc?.content).toBe('my unsaved edits');
      expect(doc?.isDirty).toBe(true);
      expect(useDocumentManagerStore.getState().conflicts.has(pageId)).toBe(false);
    });

    it('given a 409, should cancel the pending debounce so the autosave loop cannot re-fire', async () => {
      const pageId = 'page-123';

      useDocumentManagerStore.getState().upsertDocument(pageId, 'my unsaved edits', 'html', 3);
      const pendingTimeout = setTimeout(() => {}, 60_000);
      useDocumentManagerStore.getState().updateDocument(pageId, { isDirty: true, saveTimeout: pendingTimeout });

      vi.mocked(fetchWithAuth).mockResolvedValueOnce({
        ok: false,
        status: 409,
        json: () => Promise.resolve({ error: 'Page was modified', currentRevision: 4, expectedRevision: 3 }),
      } as Response);
      vi.mocked(fetchWithAuth).mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ content: 'newer content', revision: 4 }),
      } as Response);

      const { result } = renderHook(() => useDocumentSaving(pageId));

      await act(async () => {
        await result.current.saveDocument('my unsaved edits');
      });

      expect(useDocumentManagerStore.getState().documents.get(pageId)?.saveTimeout).toBeUndefined();
      clearTimeout(pendingTimeout);
    });

    it('given an explicit expectedRevision, should send it instead of the stale stored revision', async () => {
      const pageId = 'page-123';

      useDocumentManagerStore.getState().upsertDocument(pageId, 'content', 'html', 3);

      const { result } = renderHook(() => useDocumentSaving(pageId));

      await act(async () => {
        await result.current.saveDocument('content', { expectedRevision: 9 });
      });

      const opts = vi.mocked(fetchWithAuth).mock.calls[0][1] as { body: string };
      expect(JSON.parse(opts.body)).toMatchObject({ expectedRevision: 9 });
    });

    it('given a save with revision, should send expectedRevision in request body', async () => {
      const pageId = 'page-123';

      useDocumentManagerStore.getState().upsertDocument(pageId, 'content', 'html', 7);

      const { result } = renderHook(() => useDocumentSaving(pageId));

      await act(async () => {
        await result.current.saveDocument('content');
      });

      const call = vi.mocked(fetchWithAuth).mock.calls[0];
      expect(call[0]).toBe(`/api/pages/${pageId}`);
      const opts = call[1] as { method: string; body: string };
      expect(opts.method).toBe('PATCH');
      expect(JSON.parse(opts.body)).toMatchObject({ expectedRevision: 7 });
    });
  });

  describe('useDocument updateContent', () => {
    it('given a document content changes, should set dirty flag in useDirtyStore', async () => {
      const pageId = 'page-123';

      useDocumentManagerStore.getState().upsertDocument(pageId, 'initial', 'html');

      const { result } = renderHook(() => useDocument(pageId));

      expect(useDirtyStore.getState().isDirty(pageId)).toBe(false);

      act(() => {
        result.current.updateContent('new content');
      });

      expect(useDirtyStore.getState().isDirty(pageId)).toBe(true);
    });
  });

  describe('useDocument conflict resolution', () => {
    const parkConflict = (pageId: string) => {
      useDocumentManagerStore.getState().setConflict(pageId, {
        remoteContent: 'their text',
        remoteRevision: 11,
        detectedAt: 1,
      });
    };

    it('given a pending conflict, saveWithDebounce should not fire a PATCH', async () => {
      const pageId = 'page-123';
      useDocumentManagerStore.getState().upsertDocument(pageId, 'my text', 'html', 3);
      useDocumentManagerStore.getState().updateDocument(pageId, { isDirty: true });
      parkConflict(pageId);

      const { result } = renderHook(() => useDocument(pageId));

      await act(async () => {
        result.current.saveWithDebounce('my text', 0);
        await new Promise((resolve) => setTimeout(resolve, 5));
      });

      expect(fetchWithAuth).not.toHaveBeenCalled();
    });

    it('given a pending conflict, forceSave should not fire a PATCH', async () => {
      const pageId = 'page-123';
      useDocumentManagerStore.getState().upsertDocument(pageId, 'my text', 'html', 3);
      useDocumentManagerStore.getState().updateDocument(pageId, { isDirty: true });
      parkConflict(pageId);

      const { result } = renderHook(() => useDocument(pageId));

      let saved: boolean | undefined;
      await act(async () => {
        saved = await result.current.forceSave();
      });

      expect(saved).toBe(false);
      expect(fetchWithAuth).not.toHaveBeenCalled();
    });

    it('given keep-mine, should re-save local content against the remote revision and clear the conflict', async () => {
      const pageId = 'page-123';
      useDocumentManagerStore.getState().upsertDocument(pageId, 'my text', 'html', 3);
      useDocumentManagerStore.getState().updateDocument(pageId, { isDirty: true });
      useDirtyStore.getState().setDirty(pageId, true);
      parkConflict(pageId);

      vi.mocked(fetchWithAuth).mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ content: 'my text', revision: 12 }),
      } as Response);

      const { result } = renderHook(() => useDocument(pageId));

      await act(async () => {
        await result.current.resolveConflict('keep-mine');
      });

      const opts = vi.mocked(fetchWithAuth).mock.calls[0][1] as { method: string; body: string };
      expect(opts.method).toBe('PATCH');
      expect(JSON.parse(opts.body)).toMatchObject({ content: 'my text', expectedRevision: 11 });

      expect(useDocumentManagerStore.getState().conflicts.has(pageId)).toBe(false);
      const doc = useDocumentManagerStore.getState().documents.get(pageId);
      expect(doc?.content).toBe('my text');
      expect(doc?.revision).toBe(12);
    });

    it('given keep-mine that 409s again, should keep the local text and re-park the fresh conflict', async () => {
      const pageId = 'page-123';
      useDocumentManagerStore.getState().upsertDocument(pageId, 'my text', 'html', 3);
      useDocumentManagerStore.getState().updateDocument(pageId, { isDirty: true });
      parkConflict(pageId);

      vi.mocked(fetchWithAuth).mockResolvedValueOnce({
        ok: false,
        status: 409,
        json: () => Promise.resolve({ error: 'Page was modified', currentRevision: 13, expectedRevision: 11 }),
      } as Response);
      vi.mocked(fetchWithAuth).mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ content: 'even newer', revision: 13 }),
      } as Response);

      const { result } = renderHook(() => useDocument(pageId));

      await act(async () => {
        await result.current.resolveConflict('keep-mine');
      });

      expect(useDocumentManagerStore.getState().documents.get(pageId)?.content).toBe('my text');
      const conflict = useDocumentManagerStore.getState().conflicts.get(pageId);
      expect(conflict?.remoteContent).toBe('even newer');
      expect(conflict?.remoteRevision).toBe(13);
    });

    it('given use-theirs, should adopt the remote copy, clear dirty, and send no PATCH', async () => {
      const pageId = 'page-123';
      useDocumentManagerStore.getState().upsertDocument(pageId, 'my text', 'html', 3);
      useDocumentManagerStore.getState().updateDocument(pageId, { isDirty: true });
      useDirtyStore.getState().setDirty(pageId, true);
      parkConflict(pageId);

      const { result } = renderHook(() => useDocument(pageId));

      await act(async () => {
        await result.current.resolveConflict('use-theirs');
      });

      expect(fetchWithAuth).not.toHaveBeenCalled();
      const doc = useDocumentManagerStore.getState().documents.get(pageId);
      expect(doc?.content).toBe('their text');
      expect(doc?.revision).toBe(11);
      expect(doc?.isDirty).toBe(false);
      expect(useDirtyStore.getState().isDirty(pageId)).toBe(false);
      expect(useDocumentManagerStore.getState().conflicts.has(pageId)).toBe(false);
    });

    it('given a resolution save in flight, should let neither typing nor forceSave issue a PATCH', async () => {
      const pageId = 'page-123';
      useDocumentManagerStore.getState().upsertDocument(pageId, 'my text', 'html', 3);
      useDocumentManagerStore.getState().updateDocument(pageId, { isDirty: true });
      parkConflict(pageId);

      // Hold the resolution PATCH open so we can act during its flight window.
      let releaseRetry: (value: Response) => void = () => {};
      const retryInFlight = new Promise<Response>((resolve) => {
        releaseRetry = resolve;
      });
      vi.mocked(fetchWithAuth).mockReturnValueOnce(retryInFlight);

      const { result } = renderHook(() => useDocument(pageId));

      let resolution: Promise<boolean> | undefined;
      act(() => {
        resolution = result.current.resolveConflict('keep-mine');
      });

      // Exactly one request so far: the resolution retry itself.
      expect(fetchWithAuth).toHaveBeenCalledTimes(1);

      // The user keeps typing, and hits Cmd-S, while the retry is still open.
      await act(async () => {
        result.current.saveWithDebounce('my text, still typing', 0);
        await result.current.forceSave();
        await new Promise((r) => setTimeout(r, 5));
      });

      // Still one — no stale-revision PATCH raced the retry.
      expect(fetchWithAuth).toHaveBeenCalledTimes(1);

      await act(async () => {
        releaseRetry({
          ok: true,
          json: () => Promise.resolve({ content: 'my text', revision: 12 }),
        } as Response);
        await resolution;
      });

      expect(useDocumentManagerStore.getState().conflicts.has(pageId)).toBe(false);
    });

    it('given a parked conflict, a direct saveDocument without the resolution opt-in should not PATCH', async () => {
      const pageId = 'page-123';
      useDocumentManagerStore.getState().upsertDocument(pageId, 'my text', 'html', 3);
      parkConflict(pageId);

      const { result } = renderHook(() => useDocumentSaving(pageId));

      let saved: boolean | undefined;
      await act(async () => {
        saved = await result.current.saveDocument('my text');
      });

      expect(saved).toBe(false);
      expect(fetchWithAuth).not.toHaveBeenCalled();
    });

    it('given an edit made while the retry is in flight, should schedule it once the conflict clears', async () => {
      const pageId = 'page-123';
      useDocumentManagerStore.getState().upsertDocument(pageId, 'my text', 'html', 3);
      useDocumentManagerStore.getState().updateDocument(pageId, { isDirty: true });
      parkConflict(pageId);

      let releaseRetry: (value: Response) => void = () => {};
      vi.mocked(fetchWithAuth).mockReturnValueOnce(
        new Promise<Response>((resolve) => {
          releaseRetry = resolve;
        })
      );

      const { result } = renderHook(() => useDocument(pageId));

      let resolution: Promise<boolean> | undefined;
      act(() => {
        resolution = result.current.resolveConflict('keep-mine');
      });

      // The user keeps typing while the retry is open. The autosave guard is
      // correctly closed, so nothing is scheduled for this text — that is the
      // window in which an edit could be stranded.
      act(() => {
        result.current.updateContent('my text, typed during the retry');
      });
      expect(fetchWithAuth).toHaveBeenCalledTimes(1);
      expect(
        useDocumentManagerStore.getState().documents.get(pageId)?.saveTimeout
      ).toBeUndefined();

      await act(async () => {
        releaseRetry({
          ok: true,
          json: () => Promise.resolve({ content: 'my text', revision: 12 }),
        } as Response);
        await resolution;
      });

      // Resolution done, and the mid-retry edit is no longer stranded: it is
      // still dirty AND a save is now scheduled for it. Asserted on the
      // scheduling rather than on the fired request, so the real 1000ms
      // debounce cannot make this test timing-dependent.
      const doc = useDocumentManagerStore.getState().documents.get(pageId);
      expect(useDocumentManagerStore.getState().conflicts.has(pageId)).toBe(false);
      expect(doc?.content).toBe('my text, typed during the retry');
      expect(doc?.isDirty).toBe(true);
      expect(doc?.saveTimeout).toBeDefined();

      clearTimeout(doc?.saveTimeout);
    });

    it('given two views on the same page, should let only one resolution PATCH go out', async () => {
      const pageId = 'page-123';
      useDocumentManagerStore.getState().upsertDocument(pageId, 'my text', 'html', 3);
      useDocumentManagerStore.getState().updateDocument(pageId, { isDirty: true });
      parkConflict(pageId);

      let releaseRetry: (value: Response) => void = () => {};
      vi.mocked(fetchWithAuth).mockReturnValueOnce(
        new Promise<Response>((resolve) => {
          releaseRetry = resolve;
        })
      );

      // Two independent mounts of the same page — the centre panel and an
      // agent pane both showing it.
      const viewA = renderHook(() => useDocument(pageId));
      const viewB = renderHook(() => useDocument(pageId));

      let firstClick: Promise<boolean> | undefined;
      act(() => {
        firstClick = viewA.result.current.resolveConflict('keep-mine');
      });

      // The other view's banner is disabled too, because the flag is shared.
      expect(viewB.result.current.isResolvingConflict).toBe(true);

      let secondClick: boolean | undefined;
      await act(async () => {
        secondClick = await viewB.result.current.resolveConflict('keep-mine');
      });

      expect(secondClick).toBe(false);
      expect(fetchWithAuth).toHaveBeenCalledTimes(1);

      await act(async () => {
        releaseRetry({
          ok: true,
          json: () => Promise.resolve({ content: 'my text', revision: 12 }),
        } as Response);
        await firstClick;
      });

      expect(useDocumentManagerStore.getState().conflicts.has(pageId)).toBe(false);
      expect(viewA.result.current.isResolvingConflict).toBe(false);
    });

    it('given a resolution save that fails, should leave the conflict parked for another try', async () => {
      const pageId = 'page-123';
      useDocumentManagerStore.getState().upsertDocument(pageId, 'my text', 'html', 3);
      useDocumentManagerStore.getState().updateDocument(pageId, { isDirty: true });
      parkConflict(pageId);

      vi.mocked(fetchWithAuth).mockResolvedValueOnce({
        ok: false,
        status: 500,
        json: () => Promise.resolve({ error: 'Server error' }),
      } as Response);

      const { result } = renderHook(() => useDocument(pageId));

      let resolved: boolean | undefined;
      await act(async () => {
        resolved = await result.current.resolveConflict('keep-mine');
      });

      expect(resolved).toBe(false);
      expect(useDocumentManagerStore.getState().conflicts.has(pageId)).toBe(true);
      expect(useDocumentManagerStore.getState().documents.get(pageId)?.content).toBe('my text');
    });

    it('given no local document record, should refuse to resolve rather than save an empty document', async () => {
      const pageId = 'page-123';
      parkConflict(pageId);
      // Conflict parked but the document record is gone from the store.
      expect(useDocumentManagerStore.getState().documents.has(pageId)).toBe(false);

      const { result } = renderHook(() => useDocument(pageId));

      let resolved: boolean | undefined;
      await act(async () => {
        resolved = await result.current.resolveConflict('keep-mine');
      });

      expect(resolved).toBe(false);
      expect(fetchWithAuth).not.toHaveBeenCalled();
      // The conflict stays parked — nothing was silently overwritten.
      expect(useDocumentManagerStore.getState().conflicts.has(pageId)).toBe(true);
    });

    it('given no pending conflict, resolveConflict should be a no-op', async () => {
      const pageId = 'page-123';
      useDocumentManagerStore.getState().upsertDocument(pageId, 'my text', 'html', 3);

      const { result } = renderHook(() => useDocument(pageId));

      await act(async () => {
        await result.current.resolveConflict('keep-mine');
      });

      expect(fetchWithAuth).not.toHaveBeenCalled();
      expect(useDocumentManagerStore.getState().documents.get(pageId)?.content).toBe('my text');
    });
  });

  describe('useDocument initializeAndActivate', () => {
    it('given a page, should always fetch from server regardless of cached state', async () => {
      const pageId = 'page-123';

      vi.mocked(fetchWithAuth).mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ content: 'server content', contentMode: 'html', revision: 2 }),
      } as Response);

      useDocumentManagerStore.getState().upsertDocument(pageId, 'stale cached content', 'html');

      const { result } = renderHook(() => useDocument(pageId));

      await act(async () => {
        await result.current.initializeAndActivate();
      });

      expect(fetchWithAuth).toHaveBeenCalledWith(`/api/pages/${pageId}`);
      const doc = useDocumentManagerStore.getState().documents.get(pageId);
      expect(doc?.content).toBe('server content');
      expect(doc?.revision).toBe(2);
    });

    it('given a dirty document, should fetch from server but preserve unsaved content', async () => {
      const pageId = 'page-123';

      vi.mocked(fetchWithAuth).mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ content: 'server content', contentMode: 'html', revision: 3 }),
      } as Response);

      useDocumentManagerStore.getState().upsertDocument(pageId, 'unsaved user edits', 'html');
      useDocumentManagerStore.getState().updateDocument(pageId, { isDirty: true });

      const { result } = renderHook(() => useDocument(pageId));

      await act(async () => {
        await result.current.initializeAndActivate();
      });

      expect(fetchWithAuth).toHaveBeenCalledWith(`/api/pages/${pageId}`);
      const doc = useDocumentManagerStore.getState().documents.get(pageId);
      // upsertDocument preserves content when isDirty
      expect(doc?.content).toBe('unsaved user edits');
      expect(doc?.isDirty).toBe(true);
    });
  });
});
