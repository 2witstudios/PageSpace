/**
 * useMultiSelectStore Tests
 * Tests for multi-select mode, page selection, and selector helpers
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  useMultiSelectStore,
  selectIsMultiSelectMode,
  selectActiveDriveId,
  selectSelectedCount,
} from '../useMultiSelectStore';
import type { SelectedPageInfo } from '../useMultiSelectStore';

const makePage = (id: string, overrides?: Partial<SelectedPageInfo>): SelectedPageInfo => ({
  id,
  title: `Page ${id}`,
  type: 'document',
  driveId: 'drive-1',
  parentId: null,
  ...overrides,
});

describe('useMultiSelectStore', () => {
  beforeEach(() => {
    useMultiSelectStore.setState({
      isMultiSelectMode: false,
      selectedPages: new Map(),
      activeDriveId: null,
    });
  });

  describe('initial state', () => {
    it('should not be in multi-select mode', () => {
      expect(useMultiSelectStore.getState().isMultiSelectMode).toBe(false);
    });

    it('should have no selected pages', () => {
      expect(useMultiSelectStore.getState().selectedPages.size).toBe(0);
    });

    it('should have no active drive ID', () => {
      expect(useMultiSelectStore.getState().activeDriveId).toBeNull();
    });
  });

  describe('enterMultiSelectMode', () => {
    it('should enable multi-select mode', () => {
      useMultiSelectStore.getState().enterMultiSelectMode('drive-1');

      expect(useMultiSelectStore.getState().isMultiSelectMode).toBe(true);
    });

    it('should set the active drive ID', () => {
      useMultiSelectStore.getState().enterMultiSelectMode('drive-1');

      expect(useMultiSelectStore.getState().activeDriveId).toBe('drive-1');
    });

    it('should clear any existing selections', () => {
      // Add a selection first
      useMultiSelectStore.getState().selectPage(makePage('page-1'));

      useMultiSelectStore.getState().enterMultiSelectMode('drive-1');

      expect(useMultiSelectStore.getState().selectedPages.size).toBe(0);
    });

    it('should switch drive context when entering from a different drive', () => {
      useMultiSelectStore.getState().enterMultiSelectMode('drive-1');
      useMultiSelectStore.getState().selectPage(makePage('page-1'));

      useMultiSelectStore.getState().enterMultiSelectMode('drive-2');

      expect(useMultiSelectStore.getState().activeDriveId).toBe('drive-2');
      expect(useMultiSelectStore.getState().selectedPages.size).toBe(0);
    });
  });

  describe('exitMultiSelectMode', () => {
    it('should disable multi-select mode', () => {
      useMultiSelectStore.getState().enterMultiSelectMode('drive-1');

      useMultiSelectStore.getState().exitMultiSelectMode();

      expect(useMultiSelectStore.getState().isMultiSelectMode).toBe(false);
    });

    it('should clear the active drive ID', () => {
      useMultiSelectStore.getState().enterMultiSelectMode('drive-1');

      useMultiSelectStore.getState().exitMultiSelectMode();

      expect(useMultiSelectStore.getState().activeDriveId).toBeNull();
    });

    it('should clear all selections', () => {
      useMultiSelectStore.getState().enterMultiSelectMode('drive-1');
      useMultiSelectStore.getState().selectPage(makePage('page-1'));
      useMultiSelectStore.getState().selectPage(makePage('page-2'));

      useMultiSelectStore.getState().exitMultiSelectMode();

      expect(useMultiSelectStore.getState().selectedPages.size).toBe(0);
    });
  });

  describe('toggleMultiSelectMode', () => {
    it('should enter multi-select mode when not active', () => {
      useMultiSelectStore.getState().toggleMultiSelectMode('drive-1');

      expect(useMultiSelectStore.getState().isMultiSelectMode).toBe(true);
      expect(useMultiSelectStore.getState().activeDriveId).toBe('drive-1');
    });

    it('should exit multi-select mode when active for the same drive', () => {
      useMultiSelectStore.getState().enterMultiSelectMode('drive-1');

      useMultiSelectStore.getState().toggleMultiSelectMode('drive-1');

      expect(useMultiSelectStore.getState().isMultiSelectMode).toBe(false);
      expect(useMultiSelectStore.getState().activeDriveId).toBeNull();
    });

    it('should switch drives when toggling with a different drive ID', () => {
      useMultiSelectStore.getState().enterMultiSelectMode('drive-1');

      useMultiSelectStore.getState().toggleMultiSelectMode('drive-2');

      expect(useMultiSelectStore.getState().isMultiSelectMode).toBe(true);
      expect(useMultiSelectStore.getState().activeDriveId).toBe('drive-2');
    });
  });

  describe('selectPage', () => {
    it('should add a page to the selection', () => {
      const page = makePage('page-1');

      useMultiSelectStore.getState().selectPage(page);

      expect(useMultiSelectStore.getState().selectedPages.has('page-1')).toBe(true);
    });

    it('should store the full page info', () => {
      const page = makePage('page-1', { title: 'My Document', type: 'note' });

      useMultiSelectStore.getState().selectPage(page);

      const stored = useMultiSelectStore.getState().selectedPages.get('page-1');
      expect(stored).toEqual(page);
    });

    it('should allow selecting multiple pages', () => {
      useMultiSelectStore.getState().selectPage(makePage('page-1'));
      useMultiSelectStore.getState().selectPage(makePage('page-2'));
      useMultiSelectStore.getState().selectPage(makePage('page-3'));

      expect(useMultiSelectStore.getState().selectedPages.size).toBe(3);
    });

    it('should overwrite when selecting the same page ID again', () => {
      useMultiSelectStore.getState().selectPage(makePage('page-1', { title: 'Old Title' }));
      useMultiSelectStore.getState().selectPage(makePage('page-1', { title: 'New Title' }));

      const stored = useMultiSelectStore.getState().selectedPages.get('page-1');
      expect(stored!.title).toBe('New Title');
      expect(useMultiSelectStore.getState().selectedPages.size).toBe(1);
    });
  });

  describe('deselectPage', () => {
    it('should remove a page from the selection', () => {
      useMultiSelectStore.getState().selectPage(makePage('page-1'));

      useMultiSelectStore.getState().deselectPage('page-1');

      expect(useMultiSelectStore.getState().selectedPages.has('page-1')).toBe(false);
    });

    it('should not affect other selected pages', () => {
      useMultiSelectStore.getState().selectPage(makePage('page-1'));
      useMultiSelectStore.getState().selectPage(makePage('page-2'));

      useMultiSelectStore.getState().deselectPage('page-1');

      expect(useMultiSelectStore.getState().selectedPages.has('page-2')).toBe(true);
      expect(useMultiSelectStore.getState().selectedPages.size).toBe(1);
    });

    it('should not throw when deselecting a non-selected page', () => {
      expect(() => {
        useMultiSelectStore.getState().deselectPage('non-existent');
      }).not.toThrow();
    });
  });

  describe('togglePageSelection', () => {
    it('should select a page when it is not selected', () => {
      const page = makePage('page-1');

      useMultiSelectStore.getState().togglePageSelection(page);

      expect(useMultiSelectStore.getState().selectedPages.has('page-1')).toBe(true);
    });

    it('should deselect a page when it is already selected', () => {
      const page = makePage('page-1');

      useMultiSelectStore.getState().selectPage(page);
      useMultiSelectStore.getState().togglePageSelection(page);

      expect(useMultiSelectStore.getState().selectedPages.has('page-1')).toBe(false);
    });

    it('should toggle back and forth correctly', () => {
      const page = makePage('page-1');

      useMultiSelectStore.getState().togglePageSelection(page); // select
      expect(useMultiSelectStore.getState().selectedPages.has('page-1')).toBe(true);

      useMultiSelectStore.getState().togglePageSelection(page); // deselect
      expect(useMultiSelectStore.getState().selectedPages.has('page-1')).toBe(false);

      useMultiSelectStore.getState().togglePageSelection(page); // select again
      expect(useMultiSelectStore.getState().selectedPages.has('page-1')).toBe(true);
    });
  });

  describe('selectAll', () => {
    it('should select all provided pages', () => {
      const pages = [makePage('page-1'), makePage('page-2'), makePage('page-3')];

      useMultiSelectStore.getState().selectAll(pages);

      expect(useMultiSelectStore.getState().selectedPages.size).toBe(3);
    });

    it('should replace any existing selection', () => {
      useMultiSelectStore.getState().selectPage(makePage('page-old'));

      useMultiSelectStore.getState().selectAll([makePage('page-1'), makePage('page-2')]);

      expect(useMultiSelectStore.getState().selectedPages.has('page-old')).toBe(false);
      expect(useMultiSelectStore.getState().selectedPages.size).toBe(2);
    });

    it('should handle an empty array by clearing selection', () => {
      useMultiSelectStore.getState().selectPage(makePage('page-1'));

      useMultiSelectStore.getState().selectAll([]);

      expect(useMultiSelectStore.getState().selectedPages.size).toBe(0);
    });
  });

  describe('clearSelection', () => {
    it('should remove all selected pages', () => {
      useMultiSelectStore.getState().selectPage(makePage('page-1'));
      useMultiSelectStore.getState().selectPage(makePage('page-2'));

      useMultiSelectStore.getState().clearSelection();

      expect(useMultiSelectStore.getState().selectedPages.size).toBe(0);
    });

    it('should not change multi-select mode state', () => {
      useMultiSelectStore.getState().enterMultiSelectMode('drive-1');
      useMultiSelectStore.getState().selectPage(makePage('page-1'));

      useMultiSelectStore.getState().clearSelection();

      expect(useMultiSelectStore.getState().isMultiSelectMode).toBe(true);
      expect(useMultiSelectStore.getState().activeDriveId).toBe('drive-1');
    });
  });

  describe('isSelected', () => {
    it('should return true when the page is selected', () => {
      useMultiSelectStore.getState().selectPage(makePage('page-1'));

      expect(useMultiSelectStore.getState().isSelected('page-1')).toBe(true);
    });

    it('should return false when the page is not selected', () => {
      expect(useMultiSelectStore.getState().isSelected('page-1')).toBe(false);
    });

    it('should return false after deselecting a page', () => {
      useMultiSelectStore.getState().selectPage(makePage('page-1'));
      useMultiSelectStore.getState().deselectPage('page-1');

      expect(useMultiSelectStore.getState().isSelected('page-1')).toBe(false);
    });
  });

  describe('getSelectedCount', () => {
    it('should return 0 when no pages are selected', () => {
      expect(useMultiSelectStore.getState().getSelectedCount()).toBe(0);
    });

    it('should return the correct count of selected pages', () => {
      useMultiSelectStore.getState().selectPage(makePage('page-1'));
      useMultiSelectStore.getState().selectPage(makePage('page-2'));
      useMultiSelectStore.getState().selectPage(makePage('page-3'));

      expect(useMultiSelectStore.getState().getSelectedCount()).toBe(3);
    });

    it('should update count after deselecting a page', () => {
      useMultiSelectStore.getState().selectPage(makePage('page-1'));
      useMultiSelectStore.getState().selectPage(makePage('page-2'));

      useMultiSelectStore.getState().deselectPage('page-1');

      expect(useMultiSelectStore.getState().getSelectedCount()).toBe(1);
    });
  });

  describe('getSelectedPages', () => {
    it('should return an empty array when no pages are selected', () => {
      expect(useMultiSelectStore.getState().getSelectedPages()).toEqual([]);
    });

    it('should return all selected pages as an array', () => {
      const page1 = makePage('page-1');
      const page2 = makePage('page-2');

      useMultiSelectStore.getState().selectPage(page1);
      useMultiSelectStore.getState().selectPage(page2);

      const pages = useMultiSelectStore.getState().getSelectedPages();
      expect(pages).toHaveLength(2);
      expect(pages).toContainEqual(page1);
      expect(pages).toContainEqual(page2);
    });
  });

  describe('selector helpers', () => {
    describe('selectIsMultiSelectMode', () => {
      it('should return false when multi-select is not active', () => {
        const state = useMultiSelectStore.getState();
        expect(selectIsMultiSelectMode(state)).toBe(false);
      });

      it('should return true when multi-select is active', () => {
        useMultiSelectStore.getState().enterMultiSelectMode('drive-1');

        const state = useMultiSelectStore.getState();
        expect(selectIsMultiSelectMode(state)).toBe(true);
      });
    });

    describe('selectActiveDriveId', () => {
      it('should return null when no drive is active', () => {
        const state = useMultiSelectStore.getState();
        expect(selectActiveDriveId(state)).toBeNull();
      });

      it('should return the active drive ID', () => {
        useMultiSelectStore.getState().enterMultiSelectMode('drive-1');

        const state = useMultiSelectStore.getState();
        expect(selectActiveDriveId(state)).toBe('drive-1');
      });
    });

    describe('selectSelectedCount', () => {
      it('should return 0 when no pages are selected', () => {
        const state = useMultiSelectStore.getState();
        expect(selectSelectedCount(state)).toBe(0);
      });

      it('should return the correct count', () => {
        useMultiSelectStore.getState().selectPage(makePage('page-1'));
        useMultiSelectStore.getState().selectPage(makePage('page-2'));

        const state = useMultiSelectStore.getState();
        expect(selectSelectedCount(state)).toBe(2);
      });
    });
  });
});
