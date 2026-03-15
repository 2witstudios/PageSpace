/**
 * useDocumentManagerStore Tests
 * Tests for document lifecycle management: create, update, get, activate, save tracking, and cleanup
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { useDocumentManagerStore } from '../useDocumentManagerStore';

describe('useDocumentManagerStore', () => {
  beforeEach(() => {
    useDocumentManagerStore.setState({
      documents: new Map(),
      activeDocumentId: null,
      savingDocuments: new Set(),
    });
  });

  describe('initial state', () => {
    it('should have an empty documents map', () => {
      const { documents } = useDocumentManagerStore.getState();
      expect(documents.size).toBe(0);
    });

    it('should have no active document', () => {
      const { activeDocumentId } = useDocumentManagerStore.getState();
      expect(activeDocumentId).toBeNull();
    });

    it('should have no saving documents', () => {
      const { savingDocuments } = useDocumentManagerStore.getState();
      expect(savingDocuments.size).toBe(0);
    });
  });

  describe('createDocument', () => {
    it('should create a document with default values when no content or mode provided', () => {
      const { createDocument, getDocument } = useDocumentManagerStore.getState();

      createDocument('page-1');

      const doc = getDocument('page-1');
      expect(doc).toBeDefined();
      expect(doc!.id).toBe('page-1');
      expect(doc!.content).toBe('');
      expect(doc!.contentMode).toBe('html');
      expect(doc!.isDirty).toBe(false);
      expect(doc!.version).toBe(0);
    });

    it('should create a document with provided initial content', () => {
      const { createDocument, getDocument } = useDocumentManagerStore.getState();

      createDocument('page-1', '<p>Hello</p>');

      const doc = getDocument('page-1');
      expect(doc!.content).toBe('<p>Hello</p>');
    });

    it('should create a document with the specified content mode', () => {
      const { createDocument, getDocument } = useDocumentManagerStore.getState();

      createDocument('page-1', '# Heading', 'markdown');

      const doc = getDocument('page-1');
      expect(doc!.contentMode).toBe('markdown');
    });

    it('should set lastSaved and lastUpdateTime to the current timestamp', () => {
      const now = Date.now();
      const { createDocument, getDocument } = useDocumentManagerStore.getState();

      createDocument('page-1');

      const doc = getDocument('page-1');
      expect(doc!.lastSaved).toBeGreaterThanOrEqual(now);
      expect(doc!.lastUpdateTime).toBeGreaterThanOrEqual(now);
    });

    it('should not overwrite an existing document when creating with the same ID', () => {
      const { createDocument, getDocument } = useDocumentManagerStore.getState();

      createDocument('page-1', 'original content');

      // Update the document to make it dirty so we can verify it was not overwritten
      useDocumentManagerStore.getState().updateDocument('page-1', {
        content: 'modified content',
        isDirty: true,
      });

      // Try to create again with different content
      useDocumentManagerStore.getState().createDocument('page-1', 'new content');

      const doc = getDocument('page-1');
      expect(doc!.content).toBe('modified content');
      expect(doc!.isDirty).toBe(true);
    });

    it('should allow creating multiple documents with different IDs', () => {
      const { createDocument } = useDocumentManagerStore.getState();

      createDocument('page-1', 'content 1');
      createDocument('page-2', 'content 2');
      createDocument('page-3', 'content 3');

      const { documents } = useDocumentManagerStore.getState();
      expect(documents.size).toBe(3);
    });
  });

  describe('updateDocument', () => {
    it('should update the content of an existing document', () => {
      const { createDocument, updateDocument, getDocument } = useDocumentManagerStore.getState();

      createDocument('page-1', 'initial');
      updateDocument('page-1', { content: 'updated' });

      expect(getDocument('page-1')!.content).toBe('updated');
    });

    it('should update multiple fields at once', () => {
      const { createDocument, updateDocument, getDocument } = useDocumentManagerStore.getState();

      createDocument('page-1');
      updateDocument('page-1', {
        content: 'new content',
        isDirty: true,
        version: 5,
      });

      const doc = getDocument('page-1');
      expect(doc!.content).toBe('new content');
      expect(doc!.isDirty).toBe(true);
      expect(doc!.version).toBe(5);
    });

    it('should not modify other documents when updating one', () => {
      const { createDocument, updateDocument, getDocument } = useDocumentManagerStore.getState();

      createDocument('page-1', 'content 1');
      createDocument('page-2', 'content 2');

      updateDocument('page-1', { content: 'updated' });

      expect(getDocument('page-2')!.content).toBe('content 2');
    });

    it('should do nothing when updating a non-existent document', () => {
      const { updateDocument } = useDocumentManagerStore.getState();

      // Should not throw
      expect(() => updateDocument('non-existent', { content: 'test' })).not.toThrow();

      const { documents } = useDocumentManagerStore.getState();
      expect(documents.size).toBe(0);
    });

    it('should preserve existing fields not included in the update', () => {
      const { createDocument, updateDocument, getDocument } = useDocumentManagerStore.getState();

      createDocument('page-1', 'initial', 'markdown');
      updateDocument('page-1', { isDirty: true });

      const doc = getDocument('page-1');
      expect(doc!.content).toBe('initial');
      expect(doc!.contentMode).toBe('markdown');
      expect(doc!.isDirty).toBe(true);
    });

    it('should allow updating the revision field', () => {
      const { createDocument, updateDocument, getDocument } = useDocumentManagerStore.getState();

      createDocument('page-1');
      updateDocument('page-1', { revision: 42 });

      expect(getDocument('page-1')!.revision).toBe(42);
    });
  });

  describe('getDocument', () => {
    it('should return the document when it exists', () => {
      const { createDocument, getDocument } = useDocumentManagerStore.getState();

      createDocument('page-1', 'test content');

      const doc = getDocument('page-1');
      expect(doc).toBeDefined();
      expect(doc!.id).toBe('page-1');
    });

    it('should return undefined when the document does not exist', () => {
      const { getDocument } = useDocumentManagerStore.getState();

      const doc = getDocument('non-existent');
      expect(doc).toBeUndefined();
    });
  });

  describe('setActiveDocument', () => {
    it('should set the active document ID', () => {
      const { createDocument, setActiveDocument } = useDocumentManagerStore.getState();

      createDocument('page-1');
      setActiveDocument('page-1');

      expect(useDocumentManagerStore.getState().activeDocumentId).toBe('page-1');
    });

    it('should allow setting the active document to null', () => {
      const { createDocument, setActiveDocument } = useDocumentManagerStore.getState();

      createDocument('page-1');
      setActiveDocument('page-1');
      setActiveDocument(null);

      expect(useDocumentManagerStore.getState().activeDocumentId).toBeNull();
    });

    it('should allow changing the active document', () => {
      const { createDocument, setActiveDocument } = useDocumentManagerStore.getState();

      createDocument('page-1');
      createDocument('page-2');

      setActiveDocument('page-1');
      expect(useDocumentManagerStore.getState().activeDocumentId).toBe('page-1');

      setActiveDocument('page-2');
      expect(useDocumentManagerStore.getState().activeDocumentId).toBe('page-2');
    });
  });

  describe('getActiveDocument', () => {
    it('should return the active document when one is set', () => {
      const { createDocument, setActiveDocument, getActiveDocument } = useDocumentManagerStore.getState();

      createDocument('page-1', 'active content');
      setActiveDocument('page-1');

      const doc = getActiveDocument();
      expect(doc).toBeDefined();
      expect(doc!.id).toBe('page-1');
      expect(doc!.content).toBe('active content');
    });

    it('should return undefined when no active document is set', () => {
      const { getActiveDocument } = useDocumentManagerStore.getState();

      const doc = getActiveDocument();
      expect(doc).toBeUndefined();
    });

    it('should return undefined when activeDocumentId references a non-existent document', () => {
      const { setActiveDocument, getActiveDocument } = useDocumentManagerStore.getState();

      setActiveDocument('non-existent');

      const doc = getActiveDocument();
      expect(doc).toBeUndefined();
    });
  });

  describe('markAsSaving', () => {
    it('should add the page ID to the saving set', () => {
      const { markAsSaving } = useDocumentManagerStore.getState();

      markAsSaving('page-1');

      const { savingDocuments } = useDocumentManagerStore.getState();
      expect(savingDocuments.has('page-1')).toBe(true);
    });

    it('should allow marking multiple documents as saving', () => {
      const { markAsSaving } = useDocumentManagerStore.getState();

      markAsSaving('page-1');
      markAsSaving('page-2');

      const { savingDocuments } = useDocumentManagerStore.getState();
      expect(savingDocuments.size).toBe(2);
      expect(savingDocuments.has('page-1')).toBe(true);
      expect(savingDocuments.has('page-2')).toBe(true);
    });

    it('should handle marking the same document as saving twice', () => {
      const { markAsSaving } = useDocumentManagerStore.getState();

      markAsSaving('page-1');
      markAsSaving('page-1');

      const { savingDocuments } = useDocumentManagerStore.getState();
      expect(savingDocuments.size).toBe(1);
    });
  });

  describe('markAsSaved', () => {
    it('should remove the page ID from the saving set', () => {
      const { markAsSaving, markAsSaved } = useDocumentManagerStore.getState();

      markAsSaving('page-1');
      expect(useDocumentManagerStore.getState().savingDocuments.has('page-1')).toBe(true);

      markAsSaved('page-1');
      expect(useDocumentManagerStore.getState().savingDocuments.has('page-1')).toBe(false);
    });

    it('should set isDirty to false on the document', () => {
      const { createDocument, updateDocument, markAsSaved, getDocument } = useDocumentManagerStore.getState();

      createDocument('page-1');
      updateDocument('page-1', { isDirty: true });
      expect(getDocument('page-1')!.isDirty).toBe(true);

      markAsSaved('page-1');

      expect(useDocumentManagerStore.getState().getDocument('page-1')!.isDirty).toBe(false);
    });

    it('should update the lastSaved timestamp', () => {
      const { createDocument, markAsSaved, getDocument } = useDocumentManagerStore.getState();

      createDocument('page-1');
      const originalSaved = getDocument('page-1')!.lastSaved;

      // Small delay to ensure timestamp differs
      vi.spyOn(Date, 'now').mockReturnValue(originalSaved + 1000);

      markAsSaved('page-1');

      const doc = useDocumentManagerStore.getState().getDocument('page-1');
      expect(doc!.lastSaved).toBeGreaterThan(originalSaved);

      vi.restoreAllMocks();
    });

    it('should not throw when marking a non-saving document as saved', () => {
      expect(() => {
        useDocumentManagerStore.getState().markAsSaved('non-existent');
      }).not.toThrow();
    });
  });

  describe('clearDocument', () => {
    it('should remove the document from the documents map', () => {
      const { createDocument, clearDocument, getDocument } = useDocumentManagerStore.getState();

      createDocument('page-1');
      clearDocument('page-1');

      expect(getDocument('page-1')).toBeUndefined();
    });

    it('should remove the page from the saving set', () => {
      const { createDocument, markAsSaving, clearDocument } = useDocumentManagerStore.getState();

      createDocument('page-1');
      markAsSaving('page-1');
      clearDocument('page-1');

      expect(useDocumentManagerStore.getState().savingDocuments.has('page-1')).toBe(false);
    });

    it('should reset activeDocumentId to null when clearing the active document', () => {
      const { createDocument, setActiveDocument, clearDocument } = useDocumentManagerStore.getState();

      createDocument('page-1');
      setActiveDocument('page-1');
      expect(useDocumentManagerStore.getState().activeDocumentId).toBe('page-1');

      clearDocument('page-1');

      expect(useDocumentManagerStore.getState().activeDocumentId).toBeNull();
    });

    it('should not change activeDocumentId when clearing a non-active document', () => {
      const { createDocument, setActiveDocument, clearDocument } = useDocumentManagerStore.getState();

      createDocument('page-1');
      createDocument('page-2');
      setActiveDocument('page-1');

      clearDocument('page-2');

      expect(useDocumentManagerStore.getState().activeDocumentId).toBe('page-1');
    });

    it('should not affect other documents when clearing one', () => {
      const { createDocument, clearDocument, getDocument } = useDocumentManagerStore.getState();

      createDocument('page-1', 'content 1');
      createDocument('page-2', 'content 2');

      clearDocument('page-1');

      expect(getDocument('page-1')).toBeUndefined();
      expect(getDocument('page-2')).toBeDefined();
      expect(getDocument('page-2')!.content).toBe('content 2');
    });

    it('should not throw when clearing a non-existent document', () => {
      expect(() => {
        useDocumentManagerStore.getState().clearDocument('non-existent');
      }).not.toThrow();
    });
  });

  describe('clearAllDocuments', () => {
    it('should remove all documents', () => {
      const { createDocument, clearAllDocuments } = useDocumentManagerStore.getState();

      createDocument('page-1');
      createDocument('page-2');
      createDocument('page-3');

      clearAllDocuments();

      const { documents } = useDocumentManagerStore.getState();
      expect(documents.size).toBe(0);
    });

    it('should reset activeDocumentId to null', () => {
      const { createDocument, setActiveDocument, clearAllDocuments } = useDocumentManagerStore.getState();

      createDocument('page-1');
      setActiveDocument('page-1');

      clearAllDocuments();

      expect(useDocumentManagerStore.getState().activeDocumentId).toBeNull();
    });

    it('should clear all saving documents', () => {
      const { createDocument, markAsSaving, clearAllDocuments } = useDocumentManagerStore.getState();

      createDocument('page-1');
      createDocument('page-2');
      markAsSaving('page-1');
      markAsSaving('page-2');

      clearAllDocuments();

      expect(useDocumentManagerStore.getState().savingDocuments.size).toBe(0);
    });

    it('should leave the store in a clean initial state', () => {
      const { createDocument, setActiveDocument, markAsSaving, clearAllDocuments } = useDocumentManagerStore.getState();

      createDocument('page-1');
      createDocument('page-2');
      setActiveDocument('page-1');
      markAsSaving('page-2');

      clearAllDocuments();

      const state = useDocumentManagerStore.getState();
      expect(state.documents.size).toBe(0);
      expect(state.activeDocumentId).toBeNull();
      expect(state.savingDocuments.size).toBe(0);
    });
  });
});
