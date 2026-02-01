import { describe, it, expect } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useSheetHistory } from '../useSheetHistory';
import type { SheetData } from '@pagespace/lib/client-safe';

const createTestSheet = (cells: Record<string, string> = {}): SheetData => ({
  version: 1,
  rowCount: 10,
  columnCount: 5,
  cells,
});

describe('useSheetHistory', () => {
  it('initializes with the provided sheet', () => {
    const initialSheet = createTestSheet({ A1: '10' });
    const { result } = renderHook(() => useSheetHistory(initialSheet));

    expect(result.current.sheet).toEqual(initialSheet);
    expect(result.current.canUndo).toBe(false);
    expect(result.current.canRedo).toBe(false);
  });

  it('tracks history when setSheet is called', () => {
    const initialSheet = createTestSheet({ A1: '10' });
    const { result } = renderHook(() => useSheetHistory(initialSheet));

    act(() => {
      result.current.setSheet((prev) => ({
        ...prev,
        cells: { ...prev.cells, A2: '20' },
      }));
    });

    expect(result.current.sheet.cells.A2).toBe('20');
    expect(result.current.canUndo).toBe(true);
    expect(result.current.canRedo).toBe(false);
  });

  it('undo reverts to previous state', () => {
    const initialSheet = createTestSheet({ A1: '10' });
    const { result } = renderHook(() => useSheetHistory(initialSheet));

    act(() => {
      result.current.setSheet((prev) => ({
        ...prev,
        cells: { ...prev.cells, A2: '20' },
      }));
    });

    expect(result.current.sheet.cells.A2).toBe('20');

    act(() => {
      result.current.undo();
    });

    expect(result.current.sheet.cells.A2).toBeUndefined();
    expect(result.current.canUndo).toBe(false);
    expect(result.current.canRedo).toBe(true);
  });

  it('redo restores undone state', () => {
    const initialSheet = createTestSheet({ A1: '10' });
    const { result } = renderHook(() => useSheetHistory(initialSheet));

    act(() => {
      result.current.setSheet((prev) => ({
        ...prev,
        cells: { ...prev.cells, A2: '20' },
      }));
    });

    act(() => {
      result.current.undo();
    });

    expect(result.current.sheet.cells.A2).toBeUndefined();

    act(() => {
      result.current.redo();
    });

    expect(result.current.sheet.cells.A2).toBe('20');
    expect(result.current.canUndo).toBe(true);
    expect(result.current.canRedo).toBe(false);
  });

  it('clears future history when new changes are made after undo', () => {
    const initialSheet = createTestSheet({ A1: '10' });
    const { result } = renderHook(() => useSheetHistory(initialSheet));

    act(() => {
      result.current.setSheet((prev) => ({
        ...prev,
        cells: { ...prev.cells, A2: '20' },
      }));
    });

    act(() => {
      result.current.undo();
    });

    expect(result.current.canRedo).toBe(true);

    act(() => {
      result.current.setSheet((prev) => ({
        ...prev,
        cells: { ...prev.cells, A3: '30' },
      }));
    });

    expect(result.current.canRedo).toBe(false);
    expect(result.current.sheet.cells.A3).toBe('30');
  });

  it('does not add to history if sheet is unchanged', () => {
    const initialSheet = createTestSheet({ A1: '10' });
    const { result } = renderHook(() => useSheetHistory(initialSheet));

    act(() => {
      result.current.setSheet((prev) => prev);
    });

    expect(result.current.canUndo).toBe(false);
  });

  it('reset clears history and sets new initial state', () => {
    const initialSheet = createTestSheet({ A1: '10' });
    const { result } = renderHook(() => useSheetHistory(initialSheet));

    act(() => {
      result.current.setSheet((prev) => ({
        ...prev,
        cells: { ...prev.cells, A2: '20' },
      }));
    });

    act(() => {
      result.current.setSheet((prev) => ({
        ...prev,
        cells: { ...prev.cells, A3: '30' },
      }));
    });

    expect(result.current.canUndo).toBe(true);

    const newSheet = createTestSheet({ B1: '100' });
    act(() => {
      result.current.reset(newSheet);
    });

    expect(result.current.sheet).toEqual(newSheet);
    expect(result.current.canUndo).toBe(false);
    expect(result.current.canRedo).toBe(false);
  });

  it('maintains multiple undo/redo steps', () => {
    const initialSheet = createTestSheet({ A1: '1' });
    const { result } = renderHook(() => useSheetHistory(initialSheet));

    act(() => {
      result.current.setSheet((prev) => ({
        ...prev,
        cells: { ...prev.cells, A1: '2' },
      }));
    });

    act(() => {
      result.current.setSheet((prev) => ({
        ...prev,
        cells: { ...prev.cells, A1: '3' },
      }));
    });

    act(() => {
      result.current.setSheet((prev) => ({
        ...prev,
        cells: { ...prev.cells, A1: '4' },
      }));
    });

    expect(result.current.sheet.cells.A1).toBe('4');
    expect(result.current.historyDepth.past).toBe(3);

    act(() => {
      result.current.undo();
    });
    expect(result.current.sheet.cells.A1).toBe('3');

    act(() => {
      result.current.undo();
    });
    expect(result.current.sheet.cells.A1).toBe('2');

    act(() => {
      result.current.redo();
    });
    expect(result.current.sheet.cells.A1).toBe('3');
  });

  it('undo returns null when no history available', () => {
    const initialSheet = createTestSheet({ A1: '10' });
    const { result } = renderHook(() => useSheetHistory(initialSheet));

    let undoResult: ReturnType<typeof result.current.undo>;
    act(() => {
      undoResult = result.current.undo();
    });

    expect(undoResult!).toBeNull();
    expect(result.current.sheet).toEqual(initialSheet);
  });

  it('redo returns null when no future available', () => {
    const initialSheet = createTestSheet({ A1: '10' });
    const { result } = renderHook(() => useSheetHistory(initialSheet));

    let redoResult: ReturnType<typeof result.current.redo>;
    act(() => {
      redoResult = result.current.redo();
    });

    expect(redoResult!).toBeNull();
    expect(result.current.sheet).toEqual(initialSheet);
  });
});
