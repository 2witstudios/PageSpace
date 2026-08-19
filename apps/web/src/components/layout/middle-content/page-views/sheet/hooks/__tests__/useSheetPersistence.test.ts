import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { createEmptySheet, serializeSheetContent } from '@pagespace/lib/sheets/sheet';

/**
 * Regression tests for the sheet's history-reset and load-failure handling.
 *
 * The bug these guard: the reset effect depended on the whole `documentState`
 * object, which the store recreates on every write. Every local keystroke
 * therefore looked like a fresh server load and cleared the undo stack, so
 * Ctrl+Z did nothing in practice.
 */

type DocumentState = { content: string; isDirty: boolean };

const documentRef: { current: DocumentState | undefined } = { current: undefined };
const updateContentSpy = vi.fn();

vi.mock('@/hooks/useDocument', () => ({
  useDocument: () => ({
    // A NEW object each render, exactly like the real store.
    document: documentRef.current ? { ...documentRef.current } : undefined,
    isLoading: false,
    isSaving: false,
    initializeAndActivate: vi.fn(),
    updateContent: updateContentSpy,
    updateContentFromServer: vi.fn(),
    saveWithDebounce: vi.fn(),
    forceSave: vi.fn().mockResolvedValue(undefined),
    clearDocument: vi.fn(),
  }),
}));

vi.mock('@/lib/auth/auth-fetch', () => ({ fetchWithAuth: vi.fn() }));

import { useSheetPersistence } from '../useSheetPersistence';

const sheetContent = (cells: Record<string, string>) => {
  const sheet = createEmptySheet();
  Object.assign(sheet.cells, cells);
  return serializeSheetContent(sheet);
};

describe('useSheetPersistence', () => {
  beforeEach(() => {
    documentRef.current = undefined;
    updateContentSpy.mockClear();
  });

  const renderPersistence = (resetHistory: (sheet: unknown) => void) =>
    renderHook(() =>
      useSheetPersistence({
        pageId: 'page-1',
        socket: null,
        resetHistory: resetHistory as never,
      })
    );

  it('resets history once when content first loads', () => {
    const resetHistory = vi.fn();
    documentRef.current = { content: sheetContent({ A1: '1' }), isDirty: false };

    renderPersistence(resetHistory);

    expect(resetHistory).toHaveBeenCalledTimes(1);
  });

  it('does NOT reset history when a local edit echoes back through the store', () => {
    const resetHistory = vi.fn();
    documentRef.current = { content: sheetContent({ A1: '1' }), isDirty: false };

    const { result, rerender } = renderPersistence(resetHistory);
    expect(resetHistory).toHaveBeenCalledTimes(1);
    resetHistory.mockClear();

    // A local edit: the view calls updateContent, then the store re-renders us
    // with a brand-new documentState object carrying that same content.
    const edited = sheetContent({ A1: '1', B1: '2' });
    act(() => {
      result.current.updateContent(edited);
    });
    documentRef.current = { content: edited, isDirty: true };
    rerender();

    // If this fires, the undo stack has just been wiped mid-edit.
    expect(resetHistory).not.toHaveBeenCalled();
  });

  it('still resets history when genuinely new server content arrives', () => {
    const resetHistory = vi.fn();
    documentRef.current = { content: sheetContent({ A1: '1' }), isDirty: false };

    const { rerender } = renderPersistence(resetHistory);
    resetHistory.mockClear();

    documentRef.current = { content: sheetContent({ A1: '999' }), isDirty: false };
    rerender();

    expect(resetHistory).toHaveBeenCalledTimes(1);
  });

  it('does not re-reset when the store re-renders with identical content', () => {
    const resetHistory = vi.fn();
    documentRef.current = { content: sheetContent({ A1: '1' }), isDirty: false };

    const { rerender } = renderPersistence(resetHistory);
    resetHistory.mockClear();

    // Same content, new object identity — e.g. an isDirty/lastSaved toggle.
    documentRef.current = { content: documentRef.current.content, isDirty: true };
    rerender();

    expect(resetHistory).not.toHaveBeenCalled();
  });

  it('reports a load error and does not hand an empty sheet to the editor', () => {
    const resetHistory = vi.fn();
    documentRef.current = {
      content: '#%PAGESPACE_SHEETDOC v1\nthis is [not toml',
      isDirty: false,
    };

    const { result } = renderPersistence(resetHistory);

    expect(result.current.loadError).toBeTruthy();
    // Critically: no reset with an empty sheet, which would autosave over the
    // content we failed to read.
    expect(resetHistory).not.toHaveBeenCalled();
  });

  it('clears the load error once parseable content arrives', () => {
    const resetHistory = vi.fn();
    documentRef.current = {
      content: '#%PAGESPACE_SHEETDOC v1\nthis is [not toml',
      isDirty: false,
    };

    const { result, rerender } = renderPersistence(resetHistory);
    expect(result.current.loadError).toBeTruthy();

    documentRef.current = { content: sheetContent({ A1: '5' }), isDirty: false };
    rerender();

    expect(result.current.loadError).toBeNull();
    expect(resetHistory).toHaveBeenCalledTimes(1);
  });
});
