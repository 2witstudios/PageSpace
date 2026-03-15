import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';

const mockHasDirtyDocuments = vi.hoisted(() => vi.fn());
const mockToastWarning = vi.hoisted(() => vi.fn());

vi.mock('@/stores/useDirtyStore', () => ({
  useDirtyStore: vi.fn((selector: (state: { hasDirtyDocuments: () => boolean }) => unknown) => {
    return selector({ hasDirtyDocuments: mockHasDirtyDocuments });
  }),
}));

vi.mock('sonner', () => ({
  toast: {
    warning: mockToastWarning,
  },
}));

import { useUnsavedChanges } from '../useUnsavedChanges';

describe('useUnsavedChanges', () => {
  beforeEach(() => {
    mockHasDirtyDocuments.mockReset();
    mockToastWarning.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('beforeunload listener', () => {
    it('should add beforeunload event listener on mount', () => {
      const addSpy = vi.spyOn(window, 'addEventListener');
      mockHasDirtyDocuments.mockReturnValue(false);

      renderHook(() => useUnsavedChanges());

      expect(addSpy).toHaveBeenCalledWith('beforeunload', expect.any(Function));

      addSpy.mockRestore();
    });

    it('should remove beforeunload event listener on unmount', () => {
      const removeSpy = vi.spyOn(window, 'removeEventListener');
      mockHasDirtyDocuments.mockReturnValue(false);

      const { unmount } = renderHook(() => useUnsavedChanges());
      unmount();

      expect(removeSpy).toHaveBeenCalledWith('beforeunload', expect.any(Function));

      removeSpy.mockRestore();
    });

    it('should prevent unload when there are dirty documents', () => {
      mockHasDirtyDocuments.mockReturnValue(true);

      renderHook(() => useUnsavedChanges());

      const event = new Event('beforeunload') as BeforeUnloadEvent;
      const preventDefaultSpy = vi.spyOn(event, 'preventDefault');

      window.dispatchEvent(event);

      expect(preventDefaultSpy).toHaveBeenCalled();

      preventDefaultSpy.mockRestore();
    });

    it('should not prevent unload when there are no dirty documents', () => {
      mockHasDirtyDocuments.mockReturnValue(false);

      renderHook(() => useUnsavedChanges());

      const event = new Event('beforeunload') as BeforeUnloadEvent;
      const preventDefaultSpy = vi.spyOn(event, 'preventDefault');

      window.dispatchEvent(event);

      expect(preventDefaultSpy).not.toHaveBeenCalled();

      preventDefaultSpy.mockRestore();
    });
  });

  describe('confirmNavigation', () => {
    it('should return true immediately when no dirty documents exist', async () => {
      mockHasDirtyDocuments.mockReturnValue(false);

      const { result } = renderHook(() => useUnsavedChanges());

      let confirmed: boolean | undefined;
      await act(async () => {
        confirmed = await result.current.confirmNavigation();
      });

      expect(confirmed).toBe(true);
      expect(mockToastWarning).not.toHaveBeenCalled();
    });

    it('should show toast warning when dirty documents exist', async () => {
      mockHasDirtyDocuments.mockReturnValue(true);

      const { result } = renderHook(() => useUnsavedChanges());

      // Don't await since the promise won't resolve until an action is clicked
      act(() => {
        result.current.confirmNavigation();
      });

      expect(mockToastWarning).toHaveBeenCalledWith(
        'You have unsaved changes.',
        expect.objectContaining({
          description: 'Are you sure you want to leave without saving?',
          action: expect.objectContaining({
            label: 'Leave',
            onClick: expect.any(Function),
          }),
          cancel: expect.objectContaining({
            label: 'Stay',
            onClick: expect.any(Function),
          }),
        })
      );
    });

    it('should resolve with true when Leave action is clicked', async () => {
      mockHasDirtyDocuments.mockReturnValue(true);

      mockToastWarning.mockImplementation(
        (_msg: string, opts: { action: { onClick: () => void } }) => {
          // Simulate clicking "Leave"
          opts.action.onClick();
        }
      );

      const { result } = renderHook(() => useUnsavedChanges());

      let confirmed: boolean | undefined;
      await act(async () => {
        confirmed = await result.current.confirmNavigation();
      });

      expect(confirmed).toBe(true);
    });

    it('should resolve with false when Stay action is clicked', async () => {
      mockHasDirtyDocuments.mockReturnValue(true);

      mockToastWarning.mockImplementation(
        (_msg: string, opts: { cancel: { onClick: () => void } }) => {
          // Simulate clicking "Stay"
          opts.cancel.onClick();
        }
      );

      const { result } = renderHook(() => useUnsavedChanges());

      let confirmed: boolean | undefined;
      await act(async () => {
        confirmed = await result.current.confirmNavigation();
      });

      expect(confirmed).toBe(false);
    });
  });
});
