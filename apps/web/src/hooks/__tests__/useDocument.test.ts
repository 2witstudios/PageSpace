/**
 * useDocument Hook Tests
 * Tests for dirty flag integration with useDirtyStore
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { useDocumentManagerStore } from '@/stores/useDocumentManagerStore';
import { useDirtyStore } from '@/stores/useDirtyStore';

// Mock dependencies
vi.mock('@/lib/auth/auth-fetch', () => ({
  patch: vi.fn().mockResolvedValue({ ok: true }),
  fetchWithAuth: vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve({ content: 'test' }) }),
}));

vi.mock('../useSocket', () => ({
  useSocket: vi.fn(() => ({ id: 'socket-123' })),
}));

vi.mock('sonner', () => ({
  toast: { error: vi.fn() },
}));

import { useDocumentSaving, useDocument } from '../useDocument';
import { patch } from '@/lib/auth/auth-fetch';

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

    it('given a document save fails, should retain the dirty flag for retry', async () => {
      const pageId = 'page-123';

      // Setup: Create a dirty document and mock failure
      useDocumentManagerStore.getState().createDocument(pageId, 'content');
      useDocumentManagerStore.getState().updateDocument(pageId, { isDirty: true });
      useDirtyStore.getState().setDirty(pageId, true);

      vi.mocked(patch).mockRejectedValueOnce(new Error('Network error'));

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
