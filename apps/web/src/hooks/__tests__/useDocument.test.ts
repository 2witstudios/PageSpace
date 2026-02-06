/**
 * useDocument Hook Tests
 * Tests for dirty flag integration with useDirtyStore
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useDocumentManagerStore } from '@/stores/useDocumentManagerStore';
import { useDirtyStore } from '@/stores/useDirtyStore';

// Mock dependencies
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
    // Reset stores
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

      // Setup: Create a dirty document
      useDocumentManagerStore.getState().createDocument(pageId, 'content');
      useDocumentManagerStore.getState().updateDocument(pageId, { isDirty: true });
      useDirtyStore.getState().setDirty(pageId, true);

      // Verify dirty state before save
      expect(useDirtyStore.getState().isDirty(pageId)).toBe(true);

      // Render the saving hook
      const { result } = renderHook(() => useDocumentSaving(pageId));

      // Act: Save the document
      await act(async () => {
        await result.current.saveDocument('content');
      });

      // Assert: Dirty flag should be cleared
      expect(useDirtyStore.getState().isDirty(pageId)).toBe(false);
      expect(useDirtyStore.getState().dirtyFlags[pageId]).toBeUndefined();
    });

    it('given a document save succeeds, should update stored revision from response', async () => {
      const pageId = 'page-123';

      // Setup: Create a document with initial revision
      useDocumentManagerStore.getState().createDocument(pageId, 'content');
      useDocumentManagerStore.getState().updateDocument(pageId, { revision: 5 });

      // Mock response with incremented revision
      vi.mocked(fetchWithAuth).mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ content: 'content', revision: 6 }),
      } as Response);

      const { result } = renderHook(() => useDocumentSaving(pageId));

      await act(async () => {
        await result.current.saveDocument('content');
      });

      // Assert: Stored revision should be updated
      const doc = useDocumentManagerStore.getState().documents.get(pageId);
      expect(doc?.revision).toBe(6);
    });

    it('given a document save fails, should retain the dirty flag for retry', async () => {
      const pageId = 'page-123';

      // Setup: Create a dirty document and mock failure
      useDocumentManagerStore.getState().createDocument(pageId, 'content');
      useDocumentManagerStore.getState().updateDocument(pageId, { isDirty: true });
      useDirtyStore.getState().setDirty(pageId, true);

      vi.mocked(fetchWithAuth).mockResolvedValueOnce({
        ok: false,
        status: 500,
        json: () => Promise.resolve({ error: 'Server error' }),
      } as Response);

      // Render the saving hook
      const { result } = renderHook(() => useDocumentSaving(pageId));

      // Act: Attempt to save (will fail)
      await act(async () => {
        try {
          await result.current.saveDocument('content');
        } catch {
          // Expected to fail
        }
      });

      // Assert: Dirty flag should remain
      expect(useDirtyStore.getState().isDirty(pageId)).toBe(true);
    });

    it('given a 409 conflict response, should show conflict toast, refetch, and not throw', async () => {
      const pageId = 'page-123';
      const { toast } = await import('sonner');

      // Setup: Create a document with revision
      useDocumentManagerStore.getState().createDocument(pageId, 'content');
      useDocumentManagerStore.getState().updateDocument(pageId, { isDirty: true, revision: 3 });

      // First call: PATCH returns 409
      vi.mocked(fetchWithAuth).mockResolvedValueOnce({
        ok: false,
        status: 409,
        json: () => Promise.resolve({ error: 'Page was modified', currentRevision: 4, expectedRevision: 3 }),
      } as Response);
      // Second call: GET refetch returns latest page
      vi.mocked(fetchWithAuth).mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ content: 'newer content', revision: 4 }),
      } as Response);

      const { result } = renderHook(() => useDocumentSaving(pageId));

      let saveResult: boolean | undefined;
      await act(async () => {
        saveResult = await result.current.saveDocument('content');
      });

      // Assert: Should return false (not throw)
      expect(saveResult).toBe(false);
      // Assert: Conflict toast shown
      expect(toast.error).toHaveBeenCalledWith(
        'Document was modified elsewhere. Your local copy has been updated.',
        { id: `conflict-${pageId}` },
      );
      // Assert: Document updated with latest server state
      const doc = useDocumentManagerStore.getState().documents.get(pageId);
      expect(doc?.content).toBe('newer content');
      expect(doc?.revision).toBe(4);
      expect(doc?.isDirty).toBe(false);
    });

    it('given a save with revision, should send expectedRevision in request body', async () => {
      const pageId = 'page-123';

      // Setup: Create a document with a known revision
      useDocumentManagerStore.getState().createDocument(pageId, 'content');
      useDocumentManagerStore.getState().updateDocument(pageId, { revision: 7 });

      const { result } = renderHook(() => useDocumentSaving(pageId));

      await act(async () => {
        await result.current.saveDocument('content');
      });

      // Assert: fetchWithAuth called with expectedRevision in body
      expect(fetchWithAuth).toHaveBeenCalledWith(
        `/api/pages/${pageId}`,
        expect.objectContaining({
          method: 'PATCH',
          body: expect.stringContaining('"expectedRevision":7'),
        }),
      );
    });
  });

  describe('useDocument updateContent', () => {
    it('given a document content changes, should set dirty flag in useDirtyStore', async () => {
      const pageId = 'page-123';

      // Setup: Create document
      useDocumentManagerStore.getState().createDocument(pageId, 'initial');

      // Render the document hook
      const { result } = renderHook(() => useDocument(pageId, 'initial'));

      // Verify not dirty initially
      expect(useDirtyStore.getState().isDirty(pageId)).toBe(false);

      // Act: Update content
      act(() => {
        result.current.updateContent('new content');
      });

      // Assert: Should be marked dirty
      expect(useDirtyStore.getState().isDirty(pageId)).toBe(true);
    });
  });
});
