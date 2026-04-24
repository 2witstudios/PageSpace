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

    it('given a 409 conflict response, should show conflict toast, refetch, and not throw', async () => {
      const pageId = 'page-123';
      const { toast } = await import('sonner');

      useDocumentManagerStore.getState().upsertDocument(pageId, 'content', 'html', 3);
      useDocumentManagerStore.getState().updateDocument(pageId, { isDirty: true });

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
        saveResult = await result.current.saveDocument('content');
      });

      expect(saveResult).toBe(false);
      expect(toast.error).toHaveBeenCalledWith(
        'Document was modified elsewhere. Your local copy has been updated.',
        { id: `conflict-${pageId}` },
      );
      const doc = useDocumentManagerStore.getState().documents.get(pageId);
      expect(doc?.content).toBe('newer content');
      expect(doc?.revision).toBe(4);
      expect(doc?.isDirty).toBe(false);
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
