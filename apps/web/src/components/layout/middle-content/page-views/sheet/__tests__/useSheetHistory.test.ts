import { describe, it, expect } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useSheetHistory } from '../useSheetHistory';
import type { SheetData } from '@pagespace/lib/sheets/sheet';

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

describe('useSheetHistory presentation changes', () => {
  /**
   * The change-detection compared only cells/rowCount/columnCount, so a
   * formatting-only edit counted as a no-op: it was sent to the server but
   * dropped from state, and the next edit serialized the stale state and
   * deleted the formatting again. Every persisted field must be compared.
   */
  const change = (
    label: string,
    mutate: (previous: SheetData) => SheetData,
    initial: SheetData = createTestSheet({ A1: '10' })
  ) => {
    it(`records a change to ${label}`, () => {
      const { result } = renderHook(() => useSheetHistory(initial));

      act(() => {
        result.current.setSheet(mutate);
      });

      expect(result.current.canUndo, label).toBe(true);
    });
  };

  change('a cell format', (prev) => ({ ...prev, formats: { A1: { bold: true } } }));
  change('a column format', (prev) => ({ ...prev, columnFormats: { A: { align: 'right' } } }));
  change('a column width', (prev) => ({ ...prev, columnWidths: { A: 180 } }));
  change('a row height', (prev) => ({ ...prev, rowHeights: { '1': 32 } }));
  change('frozen rows', (prev) => ({ ...prev, frozenRows: 1 }));
  change('frozen columns', (prev) => ({ ...prev, frozenColumns: 2 }));
  change('the sheet name', (prev) => ({ ...prev, sheetName: 'Renamed' }));
  change(
    'a carried-through tab',
    (prev) => ({
      ...prev,
      extraSheets: [
        {
          name: 'Second',
          order: 1,
          meta: { rowCount: 5, columnCount: 5 },
          columns: {},
          cells: {},
          ranges: {},
          dependencies: {},
        },
      ],
    })
  );
  change('a named range', (prev) => ({ ...prev, ranges: { myRange: { ref: 'A1:B2' } } }));

  it('undoes a formatting-only edit back to unformatted', () => {
    const initial = createTestSheet({ A1: '10' });
    const { result } = renderHook(() => useSheetHistory(initial));

    act(() => {
      result.current.setSheet((prev) => ({ ...prev, formats: { A1: { bold: true } } }));
    });
    expect(result.current.sheet.formats).toEqual({ A1: { bold: true } });

    act(() => {
      result.current.undo();
    });
    expect(result.current.sheet.formats).toBeUndefined();
  });

  it('still treats an identical sheet as no change', () => {
    const initial: SheetData = {
      ...createTestSheet({ A1: '10' }),
      formats: { A1: { bold: true } },
      columnWidths: { A: 180 },
    };
    const { result } = renderHook(() => useSheetHistory(initial));

    act(() => {
      // A new object with the same content — e.g. a re-serialize round trip.
      result.current.setSheet((prev) => ({ ...prev, formats: { ...prev.formats } }));
    });

    expect(result.current.canUndo).toBe(false);
  });
});
