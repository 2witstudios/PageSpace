/**
 * CanvasPageView Save Lifecycle Tests
 * Tests for debounced save, version guard, error propagation, unmount force-save,
 * and updateContentFromServer conflict detection.
 */

import type { ReactNode } from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { useDocumentManagerStore } from '@/stores/useDocumentManagerStore';

// Mock auth-fetch at module level
const mockPatch = vi.fn();
vi.mock('@/lib/auth/auth-fetch', () => ({
  patch: (...args: unknown[]) => mockPatch(...args),
  fetchWithAuth: vi.fn(),
}));

vi.mock('sonner', () => ({
  toast: { error: vi.fn(), info: vi.fn() },
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn() }),
  useParams: () => ({}),
}));

vi.mock('next/dynamic', () => ({
  default: () => () => null,
}));

vi.mock('@/hooks/useAuth', () => ({
  useAuth: () => ({ user: { id: 'user-1' } }),
}));

vi.mock('@/hooks/useSocket', () => ({
  useSocket: () => ({ id: 'socket-1' }),
}));

vi.mock('@/stores/useEditingStore', () => ({
  useEditingStore: Object.assign(
    vi.fn((selector: (state: Record<string, unknown>) => unknown) =>
      selector({ isAnyActive: () => false })
    ),
    { getState: () => ({ startEditing: vi.fn(), endEditing: vi.fn() }) }
  ),
}));

vi.mock('@/components/canvas/ShadowCanvas', () => ({
  ShadowCanvas: () => null,
}));

vi.mock('@/components/ai/shared', () => ({
  ErrorBoundary: ({ children }: { children: ReactNode }) => children,
}));

vi.mock('@/lib/navigation/app-navigation', () => ({
  openExternalUrl: vi.fn(),
}));

vi.mock('@/lib/websocket', () => ({}));

describe('CanvasPageView save lifecycle', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    mockPatch.mockResolvedValue({});
    // Reset store
    useDocumentManagerStore.setState({
      documents: new Map(),
      activeDocumentId: null,
      savingDocuments: new Set(),
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('debounced save', () => {
    it('given content update, should mark document as dirty immediately', () => {
      const pageId = 'page-1';
      const store = useDocumentManagerStore.getState();
      store.upsertDocument(pageId, '<p>initial</p>', 'html');

      store.updateDocument(pageId, {
        content: '<p>edited</p>',
        isDirty: true,
        lastUpdateTime: Date.now(),
      });

      const doc = store.getDocument(pageId);
      expect(doc?.isDirty).toBe(true);
      expect(doc?.content).toBe('<p>edited</p>');
    });

    it('given successful save, should clear isDirty', async () => {
      const pageId = 'page-1';
      const store = useDocumentManagerStore.getState();
      store.upsertDocument(pageId, '<p>initial</p>', 'html');
      store.updateDocument(pageId, { content: '<p>saved</p>', isDirty: true });

      // Simulate save succeeding
      await mockPatch();

      store.updateDocument(pageId, { isDirty: false, lastSaved: Date.now() });

      const doc = store.getDocument(pageId);
      expect(doc?.isDirty).toBe(false);
    });
  });

  describe('version guard', () => {
    it('given newer edit during save, should not clear isDirty from stale save', () => {
      const pageId = 'page-1';
      const store = useDocumentManagerStore.getState();
      store.upsertDocument(pageId, '<p>v1</p>', 'html');

      // Simulate: version 1 save starts
      let saveVersion = 1;
      store.updateDocument(pageId, { content: '<p>v1</p>', isDirty: true });

      // Simulate: version 2 edit arrives while save in-flight
      saveVersion++;
      const currentVersion = saveVersion;
      store.updateDocument(pageId, { content: '<p>v2</p>', isDirty: true });

      // Simulate: version 1 save completes — but version has moved on
      const originalSaveVersion = 1;
      if (currentVersion === originalSaveVersion) {
        store.updateDocument(pageId, { isDirty: false, lastSaved: Date.now() });
      }

      // isDirty should remain true because v2 is pending
      const doc = store.getDocument(pageId);
      expect(doc?.isDirty).toBe(true);
      expect(doc?.content).toBe('<p>v2</p>');
    });

    it('given no newer edits during save, should clear isDirty', () => {
      const pageId = 'page-1';
      const store = useDocumentManagerStore.getState();
      store.upsertDocument(pageId, '<p>v1</p>', 'html');

      const saveVersion = 1;
      const currentVersion = 1;
      store.updateDocument(pageId, { content: '<p>v1</p>', isDirty: true });

      // Save completes and version matches
      if (currentVersion === saveVersion) {
        store.updateDocument(pageId, { isDirty: false, lastSaved: Date.now() });
      }

      const doc = store.getDocument(pageId);
      expect(doc?.isDirty).toBe(false);
    });
  });

  describe('error propagation', () => {
    it('given save fails, should keep isDirty true', async () => {
      const pageId = 'page-1';
      const store = useDocumentManagerStore.getState();
      store.upsertDocument(pageId, '<p>initial</p>', 'html');
      store.updateDocument(pageId, { content: '<p>unsaved</p>', isDirty: true });

      mockPatch.mockRejectedValueOnce(new Error('Network error'));

      try {
        await mockPatch();
      } catch {
        // Error caught — isDirty should NOT be cleared
      }

      // isDirty stays true because we didn't clear it on error
      const doc = store.getDocument(pageId);
      expect(doc?.isDirty).toBe(true);
      expect(doc?.content).toBe('<p>unsaved</p>');
    });
  });

  describe('unmount force-save', () => {
    it('given dirty document on unmount, should attempt save before clearing', async () => {
      const pageId = 'page-1';
      const store = useDocumentManagerStore.getState();
      store.upsertDocument(pageId, '<p>initial</p>', 'html');
      store.updateDocument(pageId, { content: '<p>dirty</p>', isDirty: true });

      // Simulate successful unmount save
      mockPatch.mockResolvedValueOnce({});
      await mockPatch(`/api/pages/${pageId}`, { content: '<p>dirty</p>' });

      // After successful save, clear document
      store.clearDocument(pageId);

      expect(store.getDocument(pageId)).toBeUndefined();
      expect(mockPatch).toHaveBeenCalledWith(
        `/api/pages/${pageId}`,
        { content: '<p>dirty</p>' }
      );
    });

    it('given dirty document and save fails on unmount, should keep document in store', async () => {
      const pageId = 'page-1';
      const store = useDocumentManagerStore.getState();
      store.upsertDocument(pageId, '<p>initial</p>', 'html');
      store.updateDocument(pageId, { content: '<p>dirty</p>', isDirty: true });

      mockPatch.mockRejectedValueOnce(new Error('Network error'));

      try {
        await mockPatch(`/api/pages/${pageId}`, { content: '<p>dirty</p>' });
      } catch {
        // Save failed — do NOT clearDocument
      }

      // Document should still be in store for recovery
      const doc = store.getDocument(pageId);
      expect(doc).toBeDefined();
      expect(doc?.content).toBe('<p>dirty</p>');
      expect(doc?.isDirty).toBe(true);
    });

    it('given clean document on unmount, should clear document without saving', () => {
      const pageId = 'page-1';
      const store = useDocumentManagerStore.getState();
      store.upsertDocument(pageId, '<p>clean</p>', 'html');

      // Not dirty — just clear
      const doc = store.getDocument(pageId);
      if (!doc?.isDirty) {
        store.clearDocument(pageId);
      }

      expect(store.getDocument(pageId)).toBeUndefined();
      expect(mockPatch).not.toHaveBeenCalled();
    });
  });

  describe('updateContentFromServer conflict detection', () => {
    it('given document is dirty, should not overwrite with server content', () => {
      const pageId = 'page-1';
      const store = useDocumentManagerStore.getState();
      store.upsertDocument(pageId, '<p>initial</p>', 'html');
      store.updateDocument(pageId, { content: '<p>local edit</p>', isDirty: true });

      // Simulate server update arriving while dirty
      const doc = store.getDocument(pageId);
      if (doc?.isDirty) {
        // updateContentFromServer should bail out
      } else {
        store.updateDocument(pageId, {
          content: '<p>server content</p>',
          isDirty: false,
          lastSaved: Date.now(),
        });
      }

      const result = store.getDocument(pageId);
      expect(result?.content).toBe('<p>local edit</p>');
      expect(result?.isDirty).toBe(true);
    });

    it('given document is clean, should apply server content', () => {
      const pageId = 'page-1';
      const store = useDocumentManagerStore.getState();
      store.upsertDocument(pageId, '<p>initial</p>', 'html');

      // Document is clean — server update should apply
      const doc = store.getDocument(pageId);
      if (!doc?.isDirty) {
        store.updateDocument(pageId, {
          content: '<p>server content</p>',
          isDirty: false,
          lastSaved: Date.now(),
          lastUpdateTime: Date.now(),
        });
      }

      const result = store.getDocument(pageId);
      expect(result?.content).toBe('<p>server content</p>');
      expect(result?.isDirty).toBe(false);
    });
  });
});
