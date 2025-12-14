/**
 * usePage (usePageStore) Tests
 * Tests for page ID state management
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { usePageStore } from '../usePage';

describe('usePageStore', () => {
  beforeEach(() => {
    // Reset the store before each test
    usePageStore.setState({ pageId: null });
  });

  describe('initial state', () => {
    it('given store is created, should have null pageId', () => {
      const { pageId } = usePageStore.getState();
      expect(pageId).toBeNull();
    });
  });

  describe('setPageId', () => {
    it('given a page ID, should set it', () => {
      const { setPageId } = usePageStore.getState();

      setPageId('page-123');

      expect(usePageStore.getState().pageId).toBe('page-123');
    });

    it('given null, should clear the page ID', () => {
      usePageStore.setState({ pageId: 'page-123' });
      const { setPageId } = usePageStore.getState();

      setPageId(null);

      expect(usePageStore.getState().pageId).toBeNull();
    });

    it('given a different page ID, should update it', () => {
      usePageStore.setState({ pageId: 'old-page' });
      const { setPageId } = usePageStore.getState();

      setPageId('new-page');

      expect(usePageStore.getState().pageId).toBe('new-page');
    });
  });

  describe('navigation workflow', () => {
    it('given user navigates between pages, should track current page', () => {
      const { setPageId } = usePageStore.getState();

      setPageId('page-1');
      expect(usePageStore.getState().pageId).toBe('page-1');

      setPageId('page-2');
      expect(usePageStore.getState().pageId).toBe('page-2');

      setPageId('page-3');
      expect(usePageStore.getState().pageId).toBe('page-3');
    });

    it('given user navigates away from a page, should allow clearing', () => {
      const { setPageId } = usePageStore.getState();

      setPageId('page-123');
      setPageId(null);

      expect(usePageStore.getState().pageId).toBeNull();
    });
  });
});
