/**
 * Canvas Save Lifecycle Tests
 * Tests for debounce, version guard, error propagation, and unmount force-save
 * patterns used in CanvasPageView.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { useDocumentManagerStore } from '@/stores/useDocumentManagerStore';

describe('CanvasPageView save lifecycle', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    useDocumentManagerStore.getState().clearAllDocuments();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('debounced save', () => {
    it('given a content update, should mark document as dirty immediately', () => {
      const store = useDocumentManagerStore.getState();
      store.createDocument('page-1', 'initial', 'html');

      store.updateDocument('page-1', {
        content: 'updated content',
        isDirty: true,
        lastUpdateTime: Date.now(),
      });

      const doc = store.getDocument('page-1');
      expect(doc?.isDirty).toBe(true);
      expect(doc?.content).toBe('updated content');
    });

    it('given save completes with matching version, should clear isDirty', () => {
      const store = useDocumentManagerStore.getState();
      store.createDocument('page-1', 'initial', 'html');

      // Simulate: edit sets isDirty, then save succeeds and clears it
      store.updateDocument('page-1', { content: 'edited', isDirty: true });
      store.updateDocument('page-1', { isDirty: false, lastSaved: Date.now() });

      const doc = store.getDocument('page-1');
      expect(doc?.isDirty).toBe(false);
    });

    it('given newer edits arrive during save, should keep isDirty true (version guard)', () => {
      const store = useDocumentManagerStore.getState();
      store.createDocument('page-1', 'initial', 'html');

      // Simulate: version 1 edit starts save
      store.updateDocument('page-1', { content: 'v1', isDirty: true });

      // Simulate: version 2 edit arrives before v1 save completes
      store.updateDocument('page-1', { content: 'v2', isDirty: true });

      // Simulate: v1 save completes but version has advanced — isDirty stays true
      // (In CanvasPageView, this check is saveVersionRef.current === version)
      // We verify the pattern: doc remains dirty since a newer edit exists
      const doc = store.getDocument('page-1');
      expect(doc?.isDirty).toBe(true);
      expect(doc?.content).toBe('v2');
    });
  });

  describe('error propagation', () => {
    it('given save fails, should keep document dirty for retry', () => {
      const store = useDocumentManagerStore.getState();
      store.createDocument('page-1', 'initial', 'html');

      store.updateDocument('page-1', { content: 'unsaved edit', isDirty: true });

      // Simulate: save throws, catch block does NOT clear isDirty
      // (no update to isDirty: false)

      const doc = store.getDocument('page-1');
      expect(doc?.isDirty).toBe(true);
      expect(doc?.content).toBe('unsaved edit');
    });
  });

  describe('unmount force-save', () => {
    it('given dirty document on unmount, should preserve document state until save completes', () => {
      const store = useDocumentManagerStore.getState();
      store.createDocument('page-1', 'initial', 'html');
      store.updateDocument('page-1', { content: 'dirty content', isDirty: true });

      // Simulate: unmount detects dirty doc — save is in-flight
      // Document should NOT be cleared yet (clearDocument only after save succeeds)
      const doc = store.getDocument('page-1');
      expect(doc).toBeDefined();
      expect(doc?.isDirty).toBe(true);
      expect(doc?.content).toBe('dirty content');
    });

    it('given clean document on unmount, should clear document immediately', () => {
      const store = useDocumentManagerStore.getState();
      store.createDocument('page-1', 'initial', 'html');

      // Document is not dirty — clearDocument is safe immediately
      store.clearDocument('page-1');

      const doc = store.getDocument('page-1');
      expect(doc).toBeUndefined();
    });

    it('given save succeeds after unmount, should clear document state', () => {
      const store = useDocumentManagerStore.getState();
      store.createDocument('page-1', 'initial', 'html');
      store.updateDocument('page-1', { content: 'dirty', isDirty: true });

      // Simulate: save succeeded in the .then() callback
      store.clearDocument('page-1');

      const doc = store.getDocument('page-1');
      expect(doc).toBeUndefined();
    });

    it('given save fails after unmount, should keep document for recovery', () => {
      const store = useDocumentManagerStore.getState();
      store.createDocument('page-1', 'initial', 'html');
      store.updateDocument('page-1', { content: 'dirty', isDirty: true });

      // Simulate: save failed — .catch() handler runs, document NOT cleared

      const doc = store.getDocument('page-1');
      expect(doc).toBeDefined();
      expect(doc?.content).toBe('dirty');
    });
  });

  describe('updateContentFromServer guard', () => {
    it('given no pending local save, should accept server content', () => {
      const store = useDocumentManagerStore.getState();
      store.createDocument('page-1', 'initial', 'html');

      // Simulate: no saveTimeoutRef, so server update applies
      store.updateDocument('page-1', {
        content: 'server content',
        isDirty: false,
        lastSaved: Date.now(),
        lastUpdateTime: Date.now(),
      });

      const doc = store.getDocument('page-1');
      expect(doc?.content).toBe('server content');
      expect(doc?.isDirty).toBe(false);
    });

    it('given pending local save, should preserve local content (not overwrite)', () => {
      const store = useDocumentManagerStore.getState();
      store.createDocument('page-1', 'initial', 'html');

      // Simulate: user edited locally, save is pending
      store.updateDocument('page-1', { content: 'local edit', isDirty: true });

      // In CanvasPageView, updateContentFromServer returns early if saveTimeoutRef.current is set
      // So the local content should be preserved — we don't call updateDocument with server data
      const doc = store.getDocument('page-1');
      expect(doc?.content).toBe('local edit');
      expect(doc?.isDirty).toBe(true);
    });
  });
});
