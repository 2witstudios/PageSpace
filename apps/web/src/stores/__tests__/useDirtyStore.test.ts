/**
 * useDirtyStore Tests
 * Tests for dirty flag tracking and cleanup
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { useDirtyStore } from '../useDirtyStore';

describe('useDirtyStore', () => {
  beforeEach(() => {
    // Reset the store before each test
    useDirtyStore.setState({ dirtyFlags: {} });
  });

  describe('existing functionality', () => {
    it('given a page ID and dirty=true, should set the dirty flag', () => {
      const { setDirty, isDirty } = useDirtyStore.getState();

      setDirty('page-123', true);

      expect(isDirty('page-123')).toBe(true);
    });

    it('given a page ID and dirty=false, should clear the dirty flag', () => {
      const { setDirty, isDirty } = useDirtyStore.getState();

      setDirty('page-123', true);
      setDirty('page-123', false);

      expect(isDirty('page-123')).toBe(false);
    });

    it('given multiple dirty pages, should return true for hasDirtyDocuments', () => {
      const { setDirty, hasDirtyDocuments } = useDirtyStore.getState();

      setDirty('page-1', true);
      setDirty('page-2', true);

      expect(hasDirtyDocuments()).toBe(true);
    });
  });

  describe('clearDirty', () => {
    it('given a document has been saved, should remove the page ID from dirtyFlags', () => {
      const { setDirty, clearDirty, isDirty } = useDirtyStore.getState();

      // Arrange: Set page as dirty
      setDirty('page-123', true);
      expect(isDirty('page-123')).toBe(true);

      // Act: Clear the dirty flag
      clearDirty('page-123');

      // Assert: Page is no longer in dirtyFlags
      expect(isDirty('page-123')).toBe(false);
      expect(useDirtyStore.getState().dirtyFlags['page-123']).toBeUndefined();
    });

    it('given multiple dirty pages, should only remove the specified page', () => {
      const { setDirty, clearDirty, isDirty } = useDirtyStore.getState();

      // Arrange: Set multiple pages as dirty
      setDirty('page-1', true);
      setDirty('page-2', true);
      setDirty('page-3', true);

      // Act: Clear only page-2
      clearDirty('page-2');

      // Assert: Only page-2 is removed
      expect(isDirty('page-1')).toBe(true);
      expect(useDirtyStore.getState().dirtyFlags['page-2']).toBeUndefined();
      expect(isDirty('page-3')).toBe(true);
    });

    it('given a non-existent page ID, should not throw', () => {
      const { clearDirty } = useDirtyStore.getState();

      // Act & Assert: Should not throw
      expect(() => clearDirty('non-existent')).not.toThrow();
    });
  });

  describe('clearAllDirty', () => {
    it('given user logs out, should clear all dirty flags', () => {
      const { setDirty, clearAllDirty, hasDirtyDocuments } = useDirtyStore.getState();

      // Arrange: Set multiple pages as dirty
      setDirty('page-1', true);
      setDirty('page-2', true);
      setDirty('page-3', true);
      expect(hasDirtyDocuments()).toBe(true);

      // Act: Clear all
      clearAllDirty();

      // Assert: No dirty documents remain
      expect(hasDirtyDocuments()).toBe(false);
      expect(useDirtyStore.getState().dirtyFlags).toEqual({});
    });
  });
});
