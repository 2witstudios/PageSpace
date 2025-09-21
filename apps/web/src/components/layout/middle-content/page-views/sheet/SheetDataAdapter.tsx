"use client";

import { useCallback, useMemo } from 'react';
import { SheetData, parseA1Notation, toA1Notation, extractCellReferences } from '@/lib/sheet-utils';

export interface SheetDataAdapter {
  // Data access
  getCellValue: (cellRef: string) => string | number | null;
  getCellFormula: (cellRef: string) => string | undefined;
  getCellType: (cellRef: string) => string;
  getCellFormatting: (cellRef: string) => Record<string, unknown>;

  // Data modification
  setCellValue: (cellRef: string, value: string | number | null) => void;
  setCellFormula: (cellRef: string, formula: string) => void;
  setCellRange: (startRef: string, endRef: string, values: (string | number | null)[][]) => void;

  // Bulk operations
  getCellRange: (startRef: string, endRef: string) => (string | number | null)[][];
  clearRange: (startRef: string, endRef: string) => void;

  // Dependencies
  getDependents: (cellRef: string) => string[];
  getPrecedents: (cellRef: string) => string[];

  // Utility
  isFormula: (cellRef: string) => boolean;
  getUsedRange: () => { startRef: string; endRef: string } | null;
}

interface SheetDataAdapterProps {
  sheetData: SheetData;
  onDataChange: (newData: SheetData) => void;
  children: (adapter: SheetDataAdapter) => React.ReactNode;
}

export const SheetDataAdapterProvider: React.FC<SheetDataAdapterProps> = ({
  sheetData,
  onDataChange,
  children
}) => {
  // Calculate dependencies
  const dependencies = useMemo(() => {
    const deps: { [cellRef: string]: string[] } = {};
    const reverseDeps: { [cellRef: string]: string[] } = {};

    Object.entries(sheetData.cells).forEach(([cellRef, cell]) => {
      if (cell.formula) {
        const precedents = extractCellReferences(cell.formula);
        deps[cellRef] = precedents;

        // Build reverse dependencies
        precedents.forEach(precedentRef => {
          if (!reverseDeps[precedentRef]) {
            reverseDeps[precedentRef] = [];
          }
          reverseDeps[precedentRef].push(cellRef);
        });
      }
    });

    return { deps, reverseDeps };
  }, [sheetData.cells]);

  const getCellValue = useCallback((cellRef: string): string | number | null => {
    const cell = sheetData.cells[cellRef];
    if (!cell) return '';

    // Handle boolean values by converting to string
    if (typeof cell.value === 'boolean') {
      return cell.value ? 'TRUE' : 'FALSE';
    }

    return cell.value;
  }, [sheetData.cells]);

  const getCellFormula = useCallback((cellRef: string): string | undefined => {
    const cell = sheetData.cells[cellRef];
    return cell?.formula;
  }, [sheetData.cells]);

  const getCellType = useCallback((cellRef: string): string => {
    const cell = sheetData.cells[cellRef];
    return cell?.type || 'string';
  }, [sheetData.cells]);

  const getCellFormatting = useCallback((cellRef: string): Record<string, unknown> => {
    const cell = sheetData.cells[cellRef];
    return cell?.formatting || {};
  }, [sheetData.cells]);

  const setCellValue = useCallback((cellRef: string, value: string | number | null) => {
    const newCells = { ...sheetData.cells };

    if (value === '' || value === null || value === undefined) {
      // Delete empty cells
      delete newCells[cellRef];
    } else {
      const existingCell = newCells[cellRef] || {};
      newCells[cellRef] = {
        ...existingCell,
        value,
        type: typeof value === 'number' ? 'number' : 'string'
      };

      // Clear formula if setting a direct value
      if (existingCell.formula) {
        delete newCells[cellRef].formula;
        newCells[cellRef].type = typeof value === 'number' ? 'number' : 'string';
      }
    }

    const newData: SheetData = {
      ...sheetData,
      cells: newCells,
      metadata: {
        ...sheetData.metadata,
        lastModified: Date.now()
      }
    };

    onDataChange(newData);
  }, [sheetData, onDataChange]);

  const setCellFormula = useCallback((cellRef: string, formula: string) => {
    const newCells = { ...sheetData.cells };

    if (!formula || formula === '') {
      // Remove formula, keep value
      if (newCells[cellRef]) {
        delete newCells[cellRef].formula;
        newCells[cellRef].type = typeof newCells[cellRef].value === 'number' ? 'number' : 'string';
      }
    } else {
      const existingCell = newCells[cellRef] || { value: '' };
      newCells[cellRef] = {
        ...existingCell,
        formula,
        type: 'formula'
      };
    }

    const newData: SheetData = {
      ...sheetData,
      cells: newCells,
      metadata: {
        ...sheetData.metadata,
        lastModified: Date.now()
      }
    };

    onDataChange(newData);
  }, [sheetData, onDataChange]);

  const getCellRange = useCallback((startRef: string, endRef: string): (string | number | null)[][] => {
    const start = parseA1Notation(startRef);
    const end = parseA1Notation(endRef);

    const minRow = Math.min(start.row, end.row);
    const maxRow = Math.max(start.row, end.row);
    const minCol = Math.min(start.col, end.col);
    const maxCol = Math.max(start.col, end.col);

    const result: (string | number | null)[][] = [];

    for (let row = minRow; row <= maxRow; row++) {
      const rowData: (string | number | null)[] = [];
      for (let col = minCol; col <= maxCol; col++) {
        const cellRef = toA1Notation(row, col);
        rowData.push(getCellValue(cellRef));
      }
      result.push(rowData);
    }

    return result;
  }, [getCellValue]);

  const setCellRange = useCallback((startRef: string, endRef: string, values: (string | number | null)[][]) => {
    const start = parseA1Notation(startRef);
    const newCells = { ...sheetData.cells };

    values.forEach((row, rowIndex) => {
      row.forEach((value, colIndex) => {
        const cellRef = toA1Notation(start.row + rowIndex, start.col + colIndex);

        if (value === '' || value === null || value === undefined) {
          delete newCells[cellRef];
        } else {
          const existingCell = newCells[cellRef] || {};
          newCells[cellRef] = {
            ...existingCell,
            value,
            type: typeof value === 'number' ? 'number' : 'string'
          };

          // Clear formula if setting a direct value
          if (existingCell.formula) {
            delete newCells[cellRef].formula;
          }
        }
      });
    });

    const newData: SheetData = {
      ...sheetData,
      cells: newCells,
      metadata: {
        ...sheetData.metadata,
        lastModified: Date.now()
      }
    };

    onDataChange(newData);
  }, [sheetData, onDataChange]);

  const clearRange = useCallback((startRef: string, endRef: string) => {
    const start = parseA1Notation(startRef);
    const end = parseA1Notation(endRef);

    const minRow = Math.min(start.row, end.row);
    const maxRow = Math.max(start.row, end.row);
    const minCol = Math.min(start.col, end.col);
    const maxCol = Math.max(start.col, end.col);

    const newCells = { ...sheetData.cells };

    for (let row = minRow; row <= maxRow; row++) {
      for (let col = minCol; col <= maxCol; col++) {
        const cellRef = toA1Notation(row, col);
        delete newCells[cellRef];
      }
    }

    const newData: SheetData = {
      ...sheetData,
      cells: newCells,
      metadata: {
        ...sheetData.metadata,
        lastModified: Date.now()
      }
    };

    onDataChange(newData);
  }, [sheetData, onDataChange]);

  const getDependents = useCallback((cellRef: string): string[] => {
    return dependencies.reverseDeps[cellRef] || [];
  }, [dependencies.reverseDeps]);

  const getPrecedents = useCallback((cellRef: string): string[] => {
    return dependencies.deps[cellRef] || [];
  }, [dependencies.deps]);

  const isFormula = useCallback((cellRef: string): boolean => {
    return !!sheetData.cells[cellRef]?.formula;
  }, [sheetData.cells]);

  const getUsedRange = useCallback((): { startRef: string; endRef: string } | null => {
    const cellRefs = Object.keys(sheetData.cells);
    if (cellRefs.length === 0) return null;

    let minRow = Infinity;
    let maxRow = -Infinity;
    let minCol = Infinity;
    let maxCol = -Infinity;

    cellRefs.forEach(cellRef => {
      const { row, col } = parseA1Notation(cellRef);
      minRow = Math.min(minRow, row);
      maxRow = Math.max(maxRow, row);
      minCol = Math.min(minCol, col);
      maxCol = Math.max(maxCol, col);
    });

    return {
      startRef: toA1Notation(minRow, minCol),
      endRef: toA1Notation(maxRow, maxCol)
    };
  }, [sheetData.cells]);

  const adapter: SheetDataAdapter = {
    getCellValue,
    getCellFormula,
    getCellType,
    getCellFormatting,
    setCellValue,
    setCellFormula,
    setCellRange,
    getCellRange,
    clearRange,
    getDependents,
    getPrecedents,
    isFormula,
    getUsedRange
  };

  return <>{children(adapter)}</>;
};