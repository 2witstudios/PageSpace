"use client";

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { TreePage, usePageTree } from '@/hooks/usePageTree';
import { useDocument } from '@/hooks/useDocument';
import { useSocket } from '@/hooks/useSocket';
import { useAuth } from '@/hooks/useAuth';
import { PageEventPayload } from '@/lib/websocket';
import { toast } from 'sonner';
import { PullToRefresh } from '@/components/ui/pull-to-refresh';
import { CustomScrollArea } from '@/components/ui/custom-scroll-area';
import {
  SheetData,
  SheetExternalReferenceToken,
  adjustFormulaReferences,
  collectExternalReferences,
  encodeCellAddress,
  decodeCellAddress,
  evaluateSheet,
  PageType,
  parseSheetContent,
  sanitizeSheetData,
  serializeSheetContent,
} from '@pagespace/lib/client-safe';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { FloatingCellEditor } from './FloatingCellEditor';
import { useSheetHistory } from './useSheetHistory';
import { useSuggestion } from '@/hooks/useSuggestion';
import { SuggestionProvider, useSuggestionContext } from '@/components/providers/SuggestionProvider';
import SuggestionPopup from '@/components/mentions/SuggestionPopup';
import { fetchWithAuth } from '@/lib/auth/auth-fetch';

interface SheetViewProps {
  page: TreePage;
}

type GridSelection = {
  row: number;
  column: number;
};

type GridRange = {
  start: GridSelection;
  end: GridSelection;
};

type SelectionState = {
  type: 'single';
  cell: GridSelection;
} | {
  type: 'range';
  range: GridRange;
};

type ExternalSheetState =
  | {
      status: 'loading';
      label: string;
      identifier?: string;
      mentionType?: string;
      pageId: string;
      title: string;
    }
  | {
      status: 'ready';
      label: string;
      identifier?: string;
      mentionType?: string;
      pageId: string;
      title: string;
      sheet: SheetData;
    }
  | {
      status: 'error';
      label: string;
      identifier?: string;
      mentionType?: string;
      pageId?: string;
      title?: string;
      error: string;
    };

const clampSelection = (selection: GridSelection, sheet: SheetData): GridSelection => ({
  row: Math.min(Math.max(selection.row, 0), Math.max(0, sheet.rowCount - 1)),
  column: Math.min(Math.max(selection.column, 0), Math.max(0, sheet.columnCount - 1)),
});

const clampRange = (range: GridRange, sheet: SheetData): GridRange => ({
  start: clampSelection(range.start, sheet),
  end: clampSelection(range.end, sheet),
});

// Get the primary cell for a selection (for formula display and editing)
const getPrimaryCell = (selection: SelectionState): GridSelection => {
  return selection.type === 'single' ? selection.cell : selection.range.start;
};

// Check if a cell is within the current selection
const isCellInSelection = (row: number, column: number, selection: SelectionState): boolean => {
  if (selection.type === 'single') {
    return selection.cell.row === row && selection.cell.column === column;
  }

  const { start, end } = selection.range;
  const minRow = Math.min(start.row, end.row);
  const maxRow = Math.max(start.row, end.row);
  const minCol = Math.min(start.column, end.column);
  const maxCol = Math.max(start.column, end.column);

  return row >= minRow && row <= maxRow && column >= minCol && column <= maxCol;
};

// Get selection address string for display
const getSelectionAddress = (selection: SelectionState): string => {
  if (selection.type === 'single') {
    return encodeCellAddress(selection.cell.row, selection.cell.column);
  }

  const { start, end } = selection.range;
  if (start.row === end.row && start.column === end.column) {
    return encodeCellAddress(start.row, start.column);
  }

  const startAddr = encodeCellAddress(start.row, start.column);
  const endAddr = encodeCellAddress(end.row, end.column);
  return `${startAddr}:${endAddr}`;
};

const getColumnLabel = (columnIndex: number) => encodeCellAddress(0, columnIndex).replace(/\d+/g, '');

// Utility function to check if a key should trigger direct cell editing
const isPrintableKey = (key: string): boolean => {
  // Single printable characters (letters, numbers, symbols)
  if (key.length === 1 && key.match(/[\x20-\x7E]/)) {
    return true;
  }
  // Special cases that should start editing
  return key === 'F2';
};

// Get the DOM rectangle for a specific cell
const getCellRect = (row: number, column: number, gridElement: HTMLElement | null): DOMRect | null => {
  if (!gridElement) return null;

  const cellElement = gridElement.querySelector(`[data-cell="${encodeCellAddress(row, column)}"]`);
  if (!cellElement) return null;

  return cellElement.getBoundingClientRect();
};

const SheetViewComponent: React.FC<SheetViewProps> = ({ page }) => {
  const initialSheet = useMemo(() => sanitizeSheetData(parseSheetContent(page.content)), [page.content]);
  const {
    sheet,
    setSheet,
    undo,
    redo,
    canUndo,
    canRedo,
    reset: resetHistory,
  } = useSheetHistory(initialSheet);
  const [selection, setSelection] = useState<SelectionState>({
    type: 'single',
    cell: { row: 0, column: 0 }
  });
  const [formulaValue, setFormulaValue] = useState('');
  const [isFormulaFocused, setIsFormulaFocused] = useState(false);
  const [isReadOnly, setIsReadOnly] = useState(false);

  // Mouse/touch drag selection state
  const [isDragging, setIsDragging] = useState(false);
  const [dragStart, setDragStart] = useState<GridSelection | null>(null);

  // Touch interaction state
  const touchStartRef = useRef<{ x: number; y: number; time: number } | null>(null);
  const longPressTimerRef = useRef<NodeJS.Timeout | null>(null);

  // Context menu state (desktop right-click menu)
  const [contextMenu, setContextMenu] = useState<{
    show: boolean;
    x: number;
    y: number;
    cell: GridSelection | null;
  }>({
    show: false,
    x: 0,
    y: 0,
    cell: null
  });

  // Mobile action sheet state (long-press menu)
  const [mobileActionSheet, setMobileActionSheet] = useState<{
    show: boolean;
    cell: GridSelection | null;
  }>({
    show: false,
    cell: null
  });

  // Copy mode state
  const [copiedData, setCopiedData] = useState<{
    mode: 'formulas' | 'values';
    data: string;
    source: SelectionState;
  } | null>(null);

  // Floating editor state
  const [editingCell, setEditingCell] = useState<GridSelection | null>(null);
  const [editingValue, setEditingValue] = useState('');
  const [editingCellRect, setEditingCellRect] = useState<DOMRect | null>(null);
  const [initialKey, setInitialKey] = useState<string | undefined>(undefined);

  // Accessibility announcements
  const [announcement, setAnnouncement] = useState('');

  // Clear announcements after a delay
  useEffect(() => {
    if (announcement) {
      const timer = setTimeout(() => setAnnouncement(''), 3000);
      return () => clearTimeout(timer);
    }
  }, [announcement]);

  const formulaInputRef = useRef<HTMLInputElement>(null);
  const gridRef = useRef<HTMLDivElement>(null);
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const socket = useSocket();
  const { user } = useAuth();
  const { tree } = usePageTree(page.driveId);
  const [externalSheets, setExternalSheets] = useState<Record<string, ExternalSheetState>>({});
  const externalFetchesRef = useRef<Set<string>>(new Set());
  const externalReferences = useMemo(() => collectExternalReferences(sheet), [sheet]);
  const flattenedPages = useMemo(() => {
    const items: TreePage[] = [];
    const walk = (nodes: TreePage[]) => {
      for (const node of nodes) {
        items.push(node);
        if (node.children && node.children.length > 0) {
          walk(node.children);
        }
      }
    };
    if (tree && tree.length > 0) {
      walk(tree);
    }
    return items;
  }, [tree]);

  const parentMap = useMemo(() => {
    const map = new Map<string, string | null>();
    for (const node of flattenedPages) {
      map.set(node.id, node.parentId ?? null);
    }
    return map;
  }, [flattenedPages]);

  const resolveReferenceTarget = useCallback(
    (reference: SheetExternalReferenceToken) => {
      if (reference.identifier) {
        const byId = flattenedPages.find(
          (node) => node.id === reference.identifier && node.type === PageType.SHEET
        );
        if (byId) {
          return { pageId: byId.id, title: byId.title };
        }
      }

      const normalizedLabel = reference.label.trim().toLowerCase();
      const labelMatches = flattenedPages.filter(
        (node) =>
          node.type === PageType.SHEET && node.title.trim().toLowerCase() === normalizedLabel
      );

      if (labelMatches.length === 1) {
        return { pageId: labelMatches[0].id, title: labelMatches[0].title };
      }

      if (labelMatches.length > 1) {
        const getAncestorChain = (id?: string | null) => {
          const chain: string[] = [];
          const visited = new Set<string>();
          let current: string | null | undefined = id ?? null;
          while (current) {
            if (visited.has(current)) {
              break;
            }
            chain.push(current);
            visited.add(current);
            current = parentMap.get(current) ?? null;
          }
          return chain;
        };

        const currentAncestors = new Set(getAncestorChain(page.id));

        const ranked = labelMatches
          .map((node) => {
            const chain = getAncestorChain(node.id);
            const sharedDepth = chain.reduce(
              (depth, ancestor) => (currentAncestors.has(ancestor) ? depth + 1 : depth),
              0
            );
            return {
              node,
              isSibling: node.parentId === page.parentId,
              sharedDepth,
              depth: chain.length,
              position: typeof node.position === 'number' ? node.position : Number.MAX_SAFE_INTEGER,
            };
          })
          .sort((a, b) => {
            if (a.isSibling !== b.isSibling) {
              return a.isSibling ? -1 : 1;
            }
            if (b.sharedDepth !== a.sharedDepth) {
              return b.sharedDepth - a.sharedDepth;
            }
            if (a.depth !== b.depth) {
              return a.depth - b.depth;
            }
            if (a.position !== b.position) {
              return a.position - b.position;
            }
            return a.node.title.localeCompare(b.node.title);
          });

        if (ranked.length > 0) {
          const { node } = ranked[0];
          return { pageId: node.id, title: node.title };
        }
      }

      return null;
    },
    [flattenedPages, page.id, page.parentId, parentMap]
  );

  const {
    document: documentState,
    initializeAndActivate,
    updateContent,
    updateContentFromServer,
    saveWithDebounce,
    forceSave,
  } = useDocument(page.id); // ✅ PageId-only pattern

  // Store forceSave in ref to prevent cleanup effects from re-running
  const forceSaveRef = useRef(forceSave);
  useEffect(() => {
    forceSaveRef.current = forceSave;
  }, [forceSave]);

  // Track isDirty in ref for window blur handler
  const isDirtyRef = useRef(false);
  useEffect(() => {
    isDirtyRef.current = documentState?.isDirty || false;
  }, [documentState?.isDirty]);

  // Pull-to-refresh handler
  const handleRefresh = useCallback(async () => {
    try {
      const response = await fetchWithAuth(`/api/pages/${page.id}`);
      if (response.ok) {
        const updatedPage = await response.json();
        updateContentFromServer(updatedPage.content);
      }
    } catch (error) {
      console.error('Failed to refresh sheet:', error);
    }
  }, [page.id, updateContentFromServer]);

  // Disable pull-to-refresh when editing
  const isPullToRefreshDisabled = !!editingCell || documentState?.isDirty || isFormulaFocused;

  useEffect(() => {
    setExternalSheets((prev) => {
      const next: Record<string, ExternalSheetState> = {};
      let changed = false;

      for (const reference of externalReferences) {
        if (prev[reference.raw]) {
          next[reference.raw] = prev[reference.raw];
        } else {
          changed = true;
        }
      }

      if (!changed && Object.keys(next).length === Object.keys(prev).length) {
        return prev;
      }

      return next;
    });
  }, [externalReferences]);

  useEffect(() => {
    externalReferences.forEach((reference) => {
      const existing = externalSheets[reference.raw];
      if (existing && (existing.status === 'loading' || existing.status === 'ready')) {
        return;
      }

      const target = resolveReferenceTarget(reference);
      if (!target) {
        setExternalSheets((prev) => ({
          ...prev,
          [reference.raw]: {
            status: 'error',
            label: reference.label,
            identifier: reference.identifier,
            mentionType: reference.mentionType,
            error: `Referenced page "${reference.label}" could not be found`,
          },
        }));
        return;
      }

      if (externalFetchesRef.current.has(reference.raw)) {
        return;
      }

      externalFetchesRef.current.add(reference.raw);

      setExternalSheets((prev) => ({
        ...prev,
        [reference.raw]: {
          status: 'loading',
          label: reference.label,
          identifier: reference.identifier,
          mentionType: reference.mentionType,
          pageId: target.pageId,
          title: target.title,
        },
      }));

      fetchWithAuth(`/api/pages/${target.pageId}`)
        .then(async (response) => {
          if (!response.ok) {
            if (response.status === 403) {
              throw new Error(`You do not have access to "${target.title}"`);
            }
            throw new Error('Failed to load referenced page');
          }

          const contentType = response.headers.get('content-type');
          if (!contentType || !contentType.includes('application/json')) {
            const fallbackMessage = await response
              .text()
              .then((text) => text.trim())
              .catch(() => '');
            throw new Error(
              fallbackMessage || 'Received unexpected response when loading referenced page'
            );
          }

          let parsedResponse: unknown;
          try {
            parsedResponse = await response.json();
          } catch {
            throw new Error('Failed to parse referenced page response');
          }

          if (!parsedResponse || typeof parsedResponse !== 'object') {
            throw new Error('Referenced page response was not valid JSON');
          }

          const data = parsedResponse as { type?: PageType; content?: unknown };

          if (data.type && data.type !== PageType.SHEET) {
            throw new Error(`Referenced page "${target.title}" is not a sheet`);
          }

          if (!('content' in data)) {
            throw new Error('Referenced page response did not include any content');
          }

          const parsed = sanitizeSheetData(parseSheetContent(data.content));
          setExternalSheets((prev) => ({
            ...prev,
            [reference.raw]: {
              status: 'ready',
              label: reference.label,
              identifier: reference.identifier,
              mentionType: reference.mentionType,
              pageId: target.pageId,
              title: target.title,
              sheet: parsed,
            },
          }));
        })
        .catch((error) => {
          const message = error instanceof Error ? error.message : 'Failed to load referenced page';
          setExternalSheets((prev) => ({
            ...prev,
            [reference.raw]: {
              status: 'error',
              label: reference.label,
              identifier: reference.identifier,
              mentionType: reference.mentionType,
              pageId: target.pageId,
              title: target.title,
              error: message,
            },
          }));
        })
        .finally(() => {
          externalFetchesRef.current.delete(reference.raw);
        });
    });
  }, [externalReferences, externalSheets, resolveReferenceTarget]);

  const evaluationOptions = useMemo(
    () => ({
      pageId: page.id,
      pageTitle: page.title,
      resolveExternalReference: (reference: SheetExternalReferenceToken) => {
        const entry = externalSheets[reference.raw];
        if (!entry) {
          return {
            pageId: reference.identifier ?? reference.raw,
            pageTitle: reference.label,
            error: `Referenced page "${reference.label}" is loading`,
          };
        }

        if (entry.status === 'ready') {
          return {
            pageId: entry.pageId,
            pageTitle: entry.title,
            sheet: entry.sheet,
          };
        }

        if (entry.status === 'loading') {
          return {
            pageId: entry.pageId,
            pageTitle: entry.title,
            error: `Referenced page "${entry.title}" is loading`,
          };
        }

        return {
          pageId: entry.pageId ?? reference.identifier ?? reference.raw,
          pageTitle: entry.title ?? reference.label,
          error: entry.error,
        };
      },
    }),
    [externalSheets, page.id, page.title]
  );

  const evaluation = useMemo(() => evaluateSheet(sheet, evaluationOptions), [sheet, evaluationOptions]);
  const currentSelection = selection.type === 'single'
    ? clampSelection(selection.cell, sheet)
    : clampSelection(selection.range.start, sheet);
  const currentAddress = encodeCellAddress(currentSelection.row, currentSelection.column);
  const currentCell = evaluation.byAddress[currentAddress];
  const currentError = currentCell?.error;
  const currentDisplay = currentCell?.error ? '#ERROR' : currentCell?.display ?? '';
  const currentRaw = sheet.cells[currentAddress] ?? '';
  const selectionAddress = getSelectionAddress(selection);

  // Calculate selection statistics for the status bar
  const selectionStats = useMemo(() => {
    const cells: { value: number; hasValue: boolean }[] = [];

    if (selection.type === 'single') {
      const cellAddress = encodeCellAddress(selection.cell.row, selection.cell.column);
      const cellData = evaluation.byAddress[cellAddress];
      if (cellData && cellData.type === 'number' && typeof cellData.value === 'number') {
        cells.push({ value: cellData.value, hasValue: true });
      } else if (cellData && cellData.value !== '') {
        cells.push({ value: NaN, hasValue: true });
      }
    } else {
      const { start, end } = selection.range;
      const minRow = Math.min(start.row, end.row);
      const maxRow = Math.max(start.row, end.row);
      const minCol = Math.min(start.column, end.column);
      const maxCol = Math.max(start.column, end.column);

      for (let row = minRow; row <= maxRow; row++) {
        for (let col = minCol; col <= maxCol; col++) {
          const cellAddress = encodeCellAddress(row, col);
          const cellData = evaluation.byAddress[cellAddress];
          if (cellData && cellData.type === 'number' && typeof cellData.value === 'number') {
            cells.push({ value: cellData.value, hasValue: true });
          } else if (cellData && cellData.value !== '') {
            cells.push({ value: NaN, hasValue: true });
          }
        }
      }
    }

    const numericCells = cells.filter(c => c.hasValue && Number.isFinite(c.value));
    const nonEmptyCells = cells.filter(c => c.hasValue);

    if (numericCells.length === 0) {
      return { sum: null, average: null, count: nonEmptyCells.length, numericCount: 0 };
    }

    const sum = numericCells.reduce((acc, c) => acc + c.value, 0);
    const average = sum / numericCells.length;

    return {
      sum,
      average,
      count: nonEmptyCells.length,
      numericCount: numericCells.length,
    };
  }, [selection, evaluation.byAddress]);

  const suggestionContext = useSuggestionContext();
  const handleFormulaValueChange = useCallback(
    (value: string) => {
      setFormulaValue(value);
      if (editingCell) {
        setEditingValue(value);
      }
    },
    [editingCell]
  );

  // Sheet-specific trigger pattern: allows @ after formula operators and whitespace
  // Allows: ( = + - * / , < > ! and whitespace characters, or at start of string
  const sheetTriggerPattern = /^$|^[\s(=+\-*/,<>!]$/;

  const suggestion = useSuggestion({
    inputRef: formulaInputRef as React.RefObject<HTMLTextAreaElement | HTMLInputElement>,
    onValueChange: handleFormulaValueChange,
    trigger: '@',
    allowedTypes: ['page'],
    driveId: page.driveId,
    mentionFormat: 'markdown-typed',
    variant: 'chat',
    popupPlacement: 'bottom',
    appendSpace: false,
    triggerPattern: sheetTriggerPattern,
  });

  const applySheetUpdate = useCallback(
    (updater: (previous: SheetData) => SheetData, shouldPersist = true) => {
      setSheet((previous) => {
        const updated = updater(previous);
        const sanitized = sanitizeSheetData({ ...updated });
        if (shouldPersist) {
          const serialized = serializeSheetContent(sanitized);
          updateContent(serialized);
          saveWithDebounce(serialized);
        }
        return sanitized;
      });
    },
    [saveWithDebounce, updateContent, setSheet]
  );

  // Start editing a cell with optional initial key
  const startCellEdit = useCallback(
    (row: number, column: number, key?: string) => {
      if (isReadOnly) {
        toast.error("You don't have permission to edit this sheet");
        return;
      }

      const cellAddress = encodeCellAddress(row, column);
      const cellRect = getCellRect(row, column, gridRef.current);

      if (!cellRect) return;

      const currentValue = sheet.cells[cellAddress] ?? '';
      let initialValue = currentValue;

      // Handle special keys
      if (key === 'F2') {
        // F2 starts editing with current value
        initialValue = currentValue;
      } else if (key && isPrintableKey(key) && key.length === 1) {
        // Replace content with the typed character
        initialValue = key;
      }

      setEditingCell({ row, column });
      setEditingValue(initialValue);
      setEditingCellRect(cellRect);
      setInitialKey(key && key.length === 1 ? key : undefined);

      // Update formula bar to match
      setFormulaValue(initialValue);

      // Announce edit mode to screen readers
      setAnnouncement(`Editing cell ${cellAddress}`);
    },
    [sheet.cells, isReadOnly]
  );

  // Commit cell edit
  const commitCellEdit = useCallback(
    (value: string) => {
      if (!editingCell || isReadOnly) return;

      const cellAddress = encodeCellAddress(editingCell.row, editingCell.column);
      const trimmed = value;

      applySheetUpdate((previous) => {
        const nextCells = { ...previous.cells };
        if (trimmed.trim() === '') {
          delete nextCells[cellAddress];
        } else {
          nextCells[cellAddress] = trimmed;
        }
        return {
          ...previous,
          version: previous.version + 1,
          cells: nextCells,
        };
      });

      // Exit editing mode
      setEditingCell(null);
      setEditingValue('');
      setEditingCellRect(null);
      setInitialKey(undefined);

      // Update formula bar
      setFormulaValue(trimmed);

      // Announce completion to screen readers
      setAnnouncement(`Cell ${cellAddress} updated`);

      // Return focus to grid
      requestAnimationFrame(() => {
        gridRef.current?.focus({ preventScroll: true });
      });
    },
    [editingCell, isReadOnly, applySheetUpdate]
  );

  // Cancel cell edit
  const cancelCellEdit = useCallback(() => {
    if (!editingCell) return;

    const cellAddress = encodeCellAddress(editingCell.row, editingCell.column);
    const originalValue = sheet.cells[cellAddress] ?? '';

    // Restore original values
    setEditingCell(null);
    setEditingValue('');
    setEditingCellRect(null);
    setInitialKey(undefined);
    setFormulaValue(originalValue);

    // Announce cancellation to screen readers
    const cancelledCellAddress = encodeCellAddress(editingCell.row, editingCell.column);
    setAnnouncement(`Edit cancelled for cell ${cancelledCellAddress}`);

    // Return focus to grid
    requestAnimationFrame(() => {
      gridRef.current?.focus({ preventScroll: true });
    });
  }, [editingCell, sheet.cells]);

  const handleCommitFormula = useCallback(
    (value: string) => {
      if (isReadOnly) {
        toast.error("You don't have permission to edit this sheet");
        return;
      }
      const trimmed = value;
      setFormulaValue(trimmed);
      applySheetUpdate((previous) => {
        const nextCells = { ...previous.cells };
        if (trimmed.trim() === '') {
          delete nextCells[currentAddress];
        } else {
          nextCells[currentAddress] = trimmed;
        }
        return {
          ...previous,
          version: previous.version + 1,
          cells: nextCells,
        };
      });
    },
    [applySheetUpdate, currentAddress, isReadOnly]
  );

  const handleAddRow = useCallback(() => {
    if (isReadOnly) {
      toast.error("You don't have permission to edit this sheet");
      return;
    }
    applySheetUpdate((previous) => ({
      ...previous,
      version: previous.version + 1,
      rowCount: previous.rowCount + 1,
    }));
  }, [applySheetUpdate, isReadOnly]);

  const handleAddColumn = useCallback(() => {
    if (isReadOnly) {
      toast.error("You don't have permission to edit this sheet");
      return;
    }
    applySheetUpdate((previous) => ({
      ...previous,
      version: previous.version + 1,
      columnCount: previous.columnCount + 1,
    }));
  }, [applySheetUpdate, isReadOnly]);

  // Undo handler
  const handleUndo = useCallback(() => {
    if (isReadOnly || !canUndo) return;

    const previousState = undo();
    if (previousState) {
      const serialized = serializeSheetContent(previousState);
      updateContent(serialized);
      saveWithDebounce(serialized);
      toast.success('Undo', { duration: 1500 });
      setAnnouncement('Undo performed');
    }
  }, [isReadOnly, canUndo, undo, updateContent, saveWithDebounce]);

  // Redo handler
  const handleRedo = useCallback(() => {
    if (isReadOnly || !canRedo) return;

    const nextState = redo();
    if (nextState) {
      const serialized = serializeSheetContent(nextState);
      updateContent(serialized);
      saveWithDebounce(serialized);
      toast.success('Redo', { duration: 1500 });
      setAnnouncement('Redo performed');
    }
  }, [isReadOnly, canRedo, redo, updateContent, saveWithDebounce]);

  const handleCellMouseDown = useCallback(
    (row: number, column: number, event: React.MouseEvent) => {
      if (isReadOnly) return;

      event.preventDefault();
      const cell = clampSelection({ row, column }, sheet);

      setIsDragging(true);
      setDragStart(cell);
      setSelection({
        type: 'single',
        cell
      });
      setIsFormulaFocused(false);

      // Close context menu
      setContextMenu(prev => ({ ...prev, show: false }));

      // Exit editing mode if selecting a different cell
      if (editingCell && (editingCell.row !== cell.row || editingCell.column !== cell.column)) {
        setEditingCell(null);
        setEditingValue('');
        setEditingCellRect(null);
        setInitialKey(undefined);
      }

      requestAnimationFrame(() => {
        gridRef.current?.focus({ preventScroll: true });
      });
    },
    [sheet, editingCell, isReadOnly]
  );

  const handleCellRightClick = useCallback(
    (row: number, column: number, event: React.MouseEvent) => {
      event.preventDefault();
      event.stopPropagation();

      const cell = clampSelection({ row, column }, sheet);

      // Update selection if right-clicking a different cell
      if (!isCellInSelection(row, column, selection)) {
        setSelection({
          type: 'single',
          cell
        });
      }

      // Show context menu at cursor position
      setContextMenu({
        show: true,
        x: event.clientX,
        y: event.clientY,
        cell
      });
    },
    [sheet, selection]
  );

  const handleCellMouseEnter = useCallback(
    (row: number, column: number) => {
      if (!isDragging || !dragStart) return;

      const endCell = clampSelection({ row, column }, sheet);
      const startCell = dragStart;

      if (startCell.row === endCell.row && startCell.column === endCell.column) {
        setSelection({
          type: 'single',
          cell: startCell
        });
      } else {
        setSelection({
          type: 'range',
          range: {
            start: startCell,
            end: endCell
          }
        });
      }
    },
    [isDragging, dragStart, sheet]
  );

  const handleMouseUp = useCallback(() => {
    if (isDragging) {
      setIsDragging(false);
      setDragStart(null);
    }
  }, [isDragging]);

  // Touch event handlers for mobile
  const handleCellTouchStart = useCallback(
    (row: number, column: number, event: React.TouchEvent) => {
      const touch = event.touches[0];
      touchStartRef.current = {
        x: touch.clientX,
        y: touch.clientY,
        time: Date.now(),
      };

      // Set up long press detection for context menu
      if (longPressTimerRef.current) {
        clearTimeout(longPressTimerRef.current);
      }

      const cell = clampSelection({ row, column }, sheet);
      longPressTimerRef.current = setTimeout(() => {
        // Long press detected - show mobile action sheet
        if (!isCellInSelection(row, column, selection)) {
          setSelection({
            type: 'single',
            cell,
          });
        }
        setMobileActionSheet({
          show: true,
          cell,
        });
        // Haptic feedback if available
        if (navigator.vibrate) {
          navigator.vibrate(50);
        }
      }, 500); // 500ms for long press
    },
    [sheet, selection]
  );

  const handleCellTouchMove = useCallback(
    (event: React.TouchEvent) => {
      // Cancel long press if moved too far
      if (touchStartRef.current && longPressTimerRef.current) {
        const touch = event.touches[0];
        const dx = Math.abs(touch.clientX - touchStartRef.current.x);
        const dy = Math.abs(touch.clientY - touchStartRef.current.y);
        if (dx > 10 || dy > 10) {
          clearTimeout(longPressTimerRef.current);
          longPressTimerRef.current = null;
        }
      }
    },
    []
  );

  // Close mobile action sheet
  const closeMobileActionSheet = useCallback(() => {
    setMobileActionSheet({ show: false, cell: null });
  }, []);

  // Add global mouse up listener to handle drag end outside grid
  useEffect(() => {
    if (isDragging) {
      document.addEventListener('mouseup', handleMouseUp);
      return () => {
        document.removeEventListener('mouseup', handleMouseUp);
      };
    }
  }, [isDragging, handleMouseUp]);

  // Parse clipboard data to detect table structure
  const parseClipboardData = useCallback((text: string) => {
    const lines = text.split(/\r?\n/).filter(line => line.length > 0);
    if (lines.length === 0) return null;

    // Try tab-separated first, then comma-separated
    let cells: string[][] = [];
    let maxColumns = 0;

    // Check if it's tab-separated
    const hasTabSeparation = lines.some(line => line.includes('\t'));

    if (hasTabSeparation) {
      cells = lines.map(line => line.split('\t'));
    } else {
      // Check for comma separation
      const hasCommaSeparation = lines.some(line => line.includes(','));
      if (hasCommaSeparation) {
        cells = lines.map(line => line.split(',').map(cell => cell.trim()));
      } else {
        // Single column data
        cells = lines.map(line => [line]);
      }
    }

    maxColumns = Math.max(...cells.map(row => row.length));

    // Pad rows to have consistent column count
    cells = cells.map(row => {
      while (row.length < maxColumns) {
        row.push('');
      }
      return row;
    });

    return {
      data: cells,
      rows: cells.length,
      columns: maxColumns
    };
  }, []);

  // Handle paste operation
  const handlePaste = useCallback(
    async (mode: 'auto' | 'values' | 'formulas' = 'auto', event?: ClipboardEvent) => {
      if (isReadOnly || editingCell) return;

      event?.preventDefault();

      try {
        const clipboardText = await navigator.clipboard.readText();
        const tableData = parseClipboardData(clipboardText);

        if (!tableData) return;

        const primaryCell = getPrimaryCell(selection);
        const startRow = primaryCell.row;
        const startCol = primaryCell.column;

        // Check if we need to expand the sheet
        const requiredRows = Math.max(sheet.rowCount, startRow + tableData.rows);
        const requiredCols = Math.max(sheet.columnCount, startCol + tableData.columns);

        // Determine paste behavior
        const isInternalPaste = copiedData && copiedData.data === clipboardText;
        const pasteMode = mode === 'auto' ?
          (isInternalPaste ? copiedData.mode : 'values') :
          mode;

        applySheetUpdate((previous) => {
          const nextCells = { ...previous.cells };

          // Apply paste data with proper handling for formulas
          for (let row = 0; row < tableData.rows; row++) {
            for (let col = 0; col < tableData.columns; col++) {
              const cellAddress = encodeCellAddress(startRow + row, startCol + col);
              let value = tableData.data[row][col].trim();

              if (value === '') {
                delete nextCells[cellAddress];
                continue;
              }

              // Handle formula adjustment if pasting formulas and it's an internal paste
              if (pasteMode === 'formulas' && isInternalPaste && copiedData && value.startsWith('=')) {
                // Calculate offset from original copy position
                const copyStart = copiedData.source.type === 'single'
                  ? copiedData.source.cell
                  : copiedData.source.range.start;

                const rowOffset = (startRow + row) - (copyStart.row + row);
                const colOffset = (startCol + col) - (copyStart.column + col);

                // Only adjust if there's an offset
                if (rowOffset !== 0 || colOffset !== 0) {
                  value = adjustFormulaReferences(value, rowOffset, colOffset);
                }
              } else if (pasteMode === 'values' && value.startsWith('=')) {
                // For values mode, don't paste formulas - this shouldn't happen with proper copy
                // but handle it gracefully
                continue;
              }

              nextCells[cellAddress] = value;
            }
          }

          return {
            ...previous,
            version: previous.version + 1,
            rowCount: requiredRows,
            columnCount: requiredCols,
            cells: nextCells,
          };
        });

        // Update selection to show pasted range if multi-cell
        if (tableData.rows > 1 || tableData.columns > 1) {
          setSelection({
            type: 'range',
            range: {
              start: { row: startRow, column: startCol },
              end: {
                row: startRow + tableData.rows - 1,
                column: startCol + tableData.columns - 1
              }
            }
          });
        }

        const modeText = pasteMode === 'formulas' ? ' (formulas)' :
                         pasteMode === 'values' ? ' (values)' : '';
        toast.success(`Pasted ${tableData.rows} row(s) and ${tableData.columns} column(s)${modeText}`);
      } catch (error) {
        console.error('Paste failed:', error);
        toast.error('Failed to paste clipboard data');
      }
    },
    [isReadOnly, editingCell, selection, sheet, parseClipboardData, applySheetUpdate, copiedData]
  );

  // Handle copy operation
  const handleCopy = useCallback(
    async (mode: 'formulas' | 'values' = 'formulas', event?: KeyboardEvent) => {
      if (editingCell) return; // Don't copy while editing

      event?.preventDefault();

      try {
        let copyData = '';

        if (selection.type === 'single') {
          // Copy single cell
          const cellAddress = encodeCellAddress(selection.cell.row, selection.cell.column);
          if (mode === 'formulas') {
            copyData = sheet.cells[cellAddress] ?? '';
          } else {
            copyData = evaluation.display[selection.cell.row]?.[selection.cell.column] ?? '';
          }
        } else {
          // Copy range of cells
          const { start, end } = selection.range;
          const minRow = Math.min(start.row, end.row);
          const maxRow = Math.max(start.row, end.row);
          const minCol = Math.min(start.column, end.column);
          const maxCol = Math.max(start.column, end.column);

          const rows: string[] = [];
          for (let row = minRow; row <= maxRow; row++) {
            const cols: string[] = [];
            for (let col = minCol; col <= maxCol; col++) {
              if (mode === 'formulas') {
                const cellAddress = encodeCellAddress(row, col);
                const cellValue = sheet.cells[cellAddress] ?? '';
                cols.push(cellValue);
              } else {
                const displayValue = evaluation.display[row]?.[col] ?? '';
                cols.push(displayValue);
              }
            }
            rows.push(cols.join('\t')); // Tab-separated values
          }
          copyData = rows.join('\n'); // Newline-separated rows
        }

        await navigator.clipboard.writeText(copyData);

        // Store copied data info for paste behavior
        setCopiedData({
          mode,
          data: copyData,
          source: selection
        });

        const cellCount = selection.type === 'single' ? 1 :
          Math.abs(selection.range.end.row - selection.range.start.row + 1) *
          Math.abs(selection.range.end.column - selection.range.start.column + 1);

        const modeText = mode === 'formulas' ? 'formulas' : 'values';
        toast.success(`Copied ${cellCount} cell${cellCount > 1 ? 's' : ''} (${modeText}) to clipboard`);
      } catch (error) {
        console.error('Copy failed:', error);
        toast.error('Failed to copy to clipboard');
      }
    },
    [editingCell, selection, sheet.cells, evaluation.display]
  );

  // Add paste event listener
  useEffect(() => {
    const gridElement = gridRef.current;
    if (gridElement) {
      const pasteHandler = (event: ClipboardEvent) => handlePaste('auto', event);
      gridElement.addEventListener('paste', pasteHandler);
      return () => {
        gridElement.removeEventListener('paste', pasteHandler);
      };
    }
  }, [handlePaste]);

  // Close context menu on clicks outside
  useEffect(() => {
    if (contextMenu.show) {
      const handleClickOutside = () => {
        setContextMenu(prev => ({ ...prev, show: false }));
      };
      document.addEventListener('click', handleClickOutside);
      document.addEventListener('contextmenu', handleClickOutside);
      return () => {
        document.removeEventListener('click', handleClickOutside);
        document.removeEventListener('contextmenu', handleClickOutside);
      };
    }
  }, [contextMenu.show]);

  const handleCellSelect = useCallback(
    (row: number, column: number) => {
      const next = clampSelection({ row, column }, sheet);
      setSelection({
        type: 'single',
        cell: next
      });
      setIsFormulaFocused(false);

      // Exit editing mode if selecting a different cell
      if (editingCell && (editingCell.row !== next.row || editingCell.column !== next.column)) {
        setEditingCell(null);
        setEditingValue('');
        setEditingCellRect(null);
        setInitialKey(undefined);
      }

      requestAnimationFrame(() => {
        gridRef.current?.focus({ preventScroll: true });
      });
    },
    [sheet, editingCell]
  );

  // Double tap detection ref for mobile editing
  const lastTapRef = useRef<{ row: number; column: number; time: number } | null>(null);

  // Touch end handler - defined after handleCellSelect to avoid forward reference
  const handleCellTouchEnd = useCallback(
    (row: number, column: number, event: React.TouchEvent) => {
      // Clear long press timer
      if (longPressTimerRef.current) {
        clearTimeout(longPressTimerRef.current);
        longPressTimerRef.current = null;
      }

      // Check if this was a tap (quick touch without much movement)
      if (touchStartRef.current) {
        const touchDuration = Date.now() - touchStartRef.current.time;
        const touch = event.changedTouches[0];
        const dx = Math.abs(touch.clientX - touchStartRef.current.x);
        const dy = Math.abs(touch.clientY - touchStartRef.current.y);

        // If it was a quick tap without much movement
        if (touchDuration < 300 && dx < 10 && dy < 10) {
          event.preventDefault();

          // Check for double tap (must be on same cell within 300ms)
          const now = Date.now();
          if (
            lastTapRef.current &&
            lastTapRef.current.row === row &&
            lastTapRef.current.column === column &&
            now - lastTapRef.current.time < 300
          ) {
            // Double tap detected - start editing
            if (!isReadOnly) {
              startCellEdit(row, column);
            }
            lastTapRef.current = null;
          } else {
            // Single tap - select cell and record for potential double tap
            handleCellSelect(row, column);
            lastTapRef.current = { row, column, time: now };
          }
        }
      }

      touchStartRef.current = null;
    },
    [handleCellSelect, isReadOnly, startCellEdit]
  );

  const handleGridKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      const { key, shiftKey, ctrlKey, metaKey } = event;
      const primaryCell = getPrimaryCell(selection);
      let { row, column } = clampSelection(primaryCell, sheet);

      // Don't interfere if we're already editing
      if (editingCell) return;

      // Handle copy shortcut
      if ((ctrlKey || metaKey) && key.toLowerCase() === 'c') {
        event.preventDefault();
        handleCopy();
        return;
      }

      // Don't trigger editing for modifier key combinations (except F2)
      if ((ctrlKey || metaKey) && key !== 'F2') {
        return;
      }

      // Handle Delete and Backspace as instant delete actions
      if (key === 'Delete' || key === 'Backspace') {
        if (isReadOnly) {
          toast.error("You don't have permission to edit this sheet");
          return;
        }

        event.preventDefault();
        const cellAddress = encodeCellAddress(row, column);

        applySheetUpdate((previous) => {
          const nextCells = { ...previous.cells };
          delete nextCells[cellAddress];
          return {
            ...previous,
            version: previous.version + 1,
            cells: nextCells,
          };
        });

        // Update formula bar to show empty value
        setFormulaValue('');

        // Announce deletion to screen readers
        setAnnouncement(`Cell ${cellAddress} cleared`);
        return;
      }

      // Check if this key should start direct cell editing
      if (isPrintableKey(key)) {
        event.preventDefault();
        startCellEdit(row, column, key);
        return;
      }

      switch (key) {
        case 'ArrowUp':
          event.preventDefault();
          row = Math.max(0, row - 1);
          break;
        case 'ArrowDown':
          event.preventDefault();
          row = Math.min(sheet.rowCount - 1, row + 1);
          break;
        case 'ArrowLeft':
          event.preventDefault();
          column = Math.max(0, column - 1);
          break;
        case 'ArrowRight':
          event.preventDefault();
          column = Math.min(sheet.columnCount - 1, column + 1);
          break;
        case 'Tab':
          event.preventDefault();
          if (shiftKey) {
            if (column === 0) {
              column = sheet.columnCount - 1;
              row = Math.max(0, row - 1);
            } else {
              column = Math.max(0, column - 1);
            }
          } else {
            column += 1;
            if (column >= sheet.columnCount) {
              column = 0;
              row = Math.min(sheet.rowCount - 1, row + 1);
            }
          }
          break;
        case 'Enter':
          event.preventDefault();
          if (!isReadOnly) {
            // Enter can either start editing or move to next row
            if (shiftKey) {
              row = Math.max(0, row - 1);
            } else {
              row = Math.min(sheet.rowCount - 1, row + 1);
            }
          }
          break;
        default:
          return;
      }

      setSelection({
        type: 'single',
        cell: { row, column }
      });
    },
    [isReadOnly, selection, sheet, editingCell, startCellEdit, handleCopy, applySheetUpdate, setFormulaValue, setAnnouncement]
  );

  const handleFormulaKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLInputElement>) => {
      suggestion.handleKeyDown(event);
      if (event.defaultPrevented || suggestionContext.isOpen) {
        return;
      }

      if (event.key === 'Enter' && !event.shiftKey) {
        event.preventDefault();
        if (editingCell) {
          // Commit the floating editor value
          commitCellEdit(formulaValue);
        } else {
          handleCommitFormula(formulaValue);
        }
        event.currentTarget.blur();
      }
      if (event.key === 'Escape') {
        event.preventDefault();
        if (editingCell) {
          cancelCellEdit();
        } else {
          setFormulaValue(currentRaw);
        }
        event.currentTarget.blur();
      }
    },
    [
      suggestion,
      suggestionContext.isOpen,
      editingCell,
      commitCellEdit,
      formulaValue,
      handleCommitFormula,
      cancelCellEdit,
      currentRaw,
    ]
  );

  // Initialize sheet when page changes
  useEffect(() => {
    initializeAndActivate();
  }, [initializeAndActivate, page.id]);

  useEffect(() => {
    setSelection({
      type: 'single',
      cell: { row: 0, column: 0 }
    });
  }, [page.id]);

  // Update sheet when document content updates from server
  useEffect(() => {
    if (documentState) {
      const newSheet = sanitizeSheetData(parseSheetContent(documentState.content));
      // Reset history when content is loaded/reloaded from server
      // This prevents undo from going back to a stale state
      resetHistory(newSheet);
    }
  }, [documentState, resetHistory]);

  // Update cell rectangle when editing cell changes or on scroll/resize
  useEffect(() => {
    if (!editingCell) return;

    const updateCellRect = () => {
      const rect = getCellRect(editingCell.row, editingCell.column, gridRef.current);
      if (rect) {
        setEditingCellRect(rect);
      } else {
        // Cell is no longer visible, cancel editing
        cancelCellEdit();
      }
    };

    // Update immediately
    updateCellRect();

    // Add scroll and resize listeners
    // Use scrollContainerRef for scroll events since CustomScrollArea handles scrolling
    const scrollElement = scrollContainerRef.current;
    const handleScroll = () => updateCellRect();
    const handleResize = () => updateCellRect();

    if (scrollElement) {
      scrollElement.addEventListener('scroll', handleScroll, { passive: true });
    }
    window.addEventListener('resize', handleResize, { passive: true });

    return () => {
      if (scrollElement) {
        scrollElement.removeEventListener('scroll', handleScroll);
      }
      window.removeEventListener('resize', handleResize);
    };
  }, [editingCell, cancelCellEdit]);

  // Update formula bar when selection or sheet changes
  useEffect(() => {
    const normalized = encodeCellAddress(currentSelection.row, currentSelection.column);
    if (!isFormulaFocused && !editingCell) {
      setFormulaValue(sheet.cells[normalized] ?? '');
    }
  }, [currentSelection.column, currentSelection.row, isFormulaFocused, editingCell, sheet.cells]);

  // Clamp selection if sheet dimensions shrink
  useEffect(() => {
    setSelection((prev) => {
      if (prev.type === 'single') {
        return {
          type: 'single',
          cell: clampSelection(prev.cell, sheet)
        };
      } else {
        return {
          type: 'range',
          range: clampRange(prev.range, sheet)
        };
      }
    });
  }, [sheet.columnCount, sheet.rowCount, sheet]);

  // Permission check
  useEffect(() => {
    const checkPermissions = async () => {
      if (!user?.id) return;
      try {
        const response = await fetchWithAuth(`/api/pages/${page.id}/permissions/check?userId=${user.id}`);
        if (response.ok) {
          const permissions = await response.json();
          setIsReadOnly(!permissions.canEdit);
          if (!permissions.canEdit) {
            toast.info("You don't have permission to edit this sheet", {
              duration: 4000,
              position: 'bottom-right',
            });
          }
        }
      } catch (error) {
        console.error('Failed to check permissions:', error);
      }
    };

    checkPermissions();
  }, [page.id, user?.id]);

  // Socket updates
  useEffect(() => {
    if (!socket) return;

    const handleContentUpdate = async (eventData: PageEventPayload) => {
      if (eventData.pageId !== page.id) return;
      try {
        const response = await fetchWithAuth(`/api/pages/${page.id}`);
        if (!response.ok) return;
        const updatedPage = await response.json();
        if (updatedPage.content !== documentState?.content && !documentState?.isDirty) {
          updateContentFromServer(updatedPage.content);
        }
      } catch (error) {
        console.error('Failed to fetch updated sheet content:', error);
      }
    };

    socket.on('page:content-updated', handleContentUpdate);
    return () => {
      socket.off('page:content-updated', handleContentUpdate);
    };
  }, [documentState?.content, documentState?.isDirty, page.id, socket, updateContentFromServer]);

  // Cleanup on unmount - auto-save any unsaved changes
  // Empty deps array ensures cleanup only runs on TRUE component unmount
  useEffect(() => {
    return () => {
      if (isDirtyRef.current) {
        forceSaveRef.current().catch(console.error);
      }
    };
  }, []); // ✅ Empty deps - only runs on mount/unmount

  // Auto-save on window blur
  useEffect(() => {
    // Only run on client side with proper window API
    if (typeof window === 'undefined' || !window.addEventListener) return;

    const handleBlur = () => {
      // Check if dirty using ref (always current)
      if (isDirtyRef.current) {
        forceSaveRef.current().catch(console.error);
      }
    };

    window.addEventListener('blur', handleBlur);
    return () => {
      if (typeof window !== 'undefined' && window.removeEventListener) {
        window.removeEventListener('blur', handleBlur);
      }
    };
  }, []); // ✅ Empty deps - uses refs for latest state

  // Store undo/redo handlers in refs to avoid re-adding event listeners
  const handleUndoRef = useRef(handleUndo);
  const handleRedoRef = useRef(handleRedo);
  useEffect(() => {
    handleUndoRef.current = handleUndo;
    handleRedoRef.current = handleRedo;
  }, [handleUndo, handleRedo]);

  // Handle keyboard shortcuts
  useEffect(() => {
    // Only run on client side with proper document API
    if (typeof document === 'undefined' || !document.addEventListener) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      // Ctrl+S / Cmd+S to save
      if ((e.ctrlKey || e.metaKey) && e.key === 's') {
        e.preventDefault();
        forceSaveRef.current();
        return;
      }

      // Ctrl+Z / Cmd+Z to undo
      if ((e.ctrlKey || e.metaKey) && e.key === 'z' && !e.shiftKey) {
        e.preventDefault();
        handleUndoRef.current();
        return;
      }

      // Ctrl+Shift+Z / Cmd+Shift+Z or Ctrl+Y / Cmd+Y to redo
      if ((e.ctrlKey || e.metaKey) && ((e.key === 'z' && e.shiftKey) || e.key === 'y')) {
        e.preventDefault();
        handleRedoRef.current();
        return;
      }
    };

    document.addEventListener('keydown', handleKeyDown);
    return () => {
      if (typeof document !== 'undefined' && document.removeEventListener) {
        document.removeEventListener('keydown', handleKeyDown);
      }
    };
  }, []); // ✅ Empty deps - uses refs for latest handlers

  return (
    <div className="flex h-full flex-col">
      {/* Mobile-responsive formula bar */}
      <div className="border-b bg-muted/40">
        {/* Cell info row - responsive layout */}
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 pt-2 pb-1 sm:px-4 sm:pt-3">
          <div className="flex items-center gap-2">
            <span className="text-[10px] font-medium uppercase text-muted-foreground sm:text-xs">
              {selection.type === 'range' ? 'Range' : 'Cell'}
            </span>
            <span className="font-semibold text-sm sm:text-base">{selectionAddress}</span>
          </div>
          <div className="hidden text-xs text-muted-foreground sm:block">
            Value: {currentDisplay || '—'}
          </div>
          {/* Mobile action buttons - visible only on small screens */}
          <div className="ml-auto flex items-center gap-1 sm:hidden">
            <Button
              variant="ghost"
              size="sm"
              onClick={handleUndo}
              disabled={isReadOnly || !canUndo}
              className="h-7 w-7 p-0"
              aria-label="Undo"
            >
              <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M3 7v6h6" />
                <path d="M21 17a9 9 0 0 0-9-9 9 9 0 0 0-6 2.3L3 13" />
              </svg>
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={handleRedo}
              disabled={isReadOnly || !canRedo}
              className="h-7 w-7 p-0"
              aria-label="Redo"
            >
              <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M21 7v6h-6" />
                <path d="M3 17a9 9 0 0 1 9-9 9 9 0 0 1 6 2.3L21 13" />
              </svg>
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={handleAddColumn}
              disabled={isReadOnly}
              className="h-7 px-2 text-xs"
              aria-label="Add column"
            >
              +Col
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={handleAddRow}
              disabled={isReadOnly}
              className="h-7 px-2 text-xs"
              aria-label="Add row"
            >
              +Row
            </Button>
          </div>
        </div>
        {/* Formula input row */}
        <div className="flex items-center gap-2 px-3 pb-2 sm:gap-3 sm:px-4 sm:pb-3">
          <span className="hidden text-xs font-medium uppercase text-muted-foreground sm:block">Formula</span>
          <div className="relative flex-1">
            <input
              ref={formulaInputRef}
              value={formulaValue}
              onFocus={() => {
                setIsFormulaFocused(true);
                // If we're not already editing, start editing the current cell
                if (!editingCell) {
                  const { row, column } = currentSelection;
                  startCellEdit(row, column);
                }
              }}
              onBlur={(event) => {
                setIsFormulaFocused(false);
                if (editingCell && event.target.value !== currentRaw) {
                  commitCellEdit(event.target.value);
                } else if (!editingCell && event.target.value !== currentRaw) {
                  handleCommitFormula(event.target.value);
                }
              }}
              onChange={(event) => {
                suggestion.handleValueChange(event.target.value);
              }}
              onKeyDown={handleFormulaKeyDown}
              disabled={isReadOnly}
              className={cn(
                'w-full rounded border border-input bg-background px-2 py-1.5 text-sm focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/20',
                'sm:py-1',
                isReadOnly && 'cursor-not-allowed opacity-75'
              )}
              placeholder="Enter value or formula"
            />
            <SuggestionPopup
              isOpen={suggestionContext.isOpen}
              items={suggestionContext.items}
              selectedIndex={suggestionContext.selectedIndex}
              position={suggestionContext.position}
              loading={suggestionContext.loading}
              error={suggestionContext.error}
              onSelect={suggestion.actions.selectSuggestion}
              onSelectionChange={suggestion.actions.selectItem}
              variant="inline"
              popupPlacement="bottom"
            />
          </div>
          {/* Desktop action buttons */}
          <div className="hidden items-center gap-2 sm:flex">
            <Button
              variant="ghost"
              size="sm"
              onClick={handleUndo}
              disabled={isReadOnly || !canUndo}
              title="Undo (Ctrl+Z)"
              className="h-8 w-8 p-0"
            >
              <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M3 7v6h6" />
                <path d="M21 17a9 9 0 0 0-9-9 9 9 0 0 0-6 2.3L3 13" />
              </svg>
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={handleRedo}
              disabled={isReadOnly || !canRedo}
              title="Redo (Ctrl+Shift+Z)"
              className="h-8 w-8 p-0"
            >
              <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M21 7v6h-6" />
                <path d="M3 17a9 9 0 0 1 9-9 9 9 0 0 1 6 2.3L21 13" />
              </svg>
            </Button>
            <div className="mx-1 h-4 w-px bg-border" />
            <Button variant="outline" size="sm" onClick={handleAddColumn} disabled={isReadOnly}>
              + Column
            </Button>
            <Button variant="outline" size="sm" onClick={handleAddRow} disabled={isReadOnly}>
              + Row
            </Button>
          </div>
        </div>
        {currentError && (
          <div className="px-3 pb-2 text-xs text-destructive sm:px-4 sm:pb-3">Error: {currentError}</div>
        )}
      </div>
      <PullToRefresh
        direction="top"
        onRefresh={handleRefresh}
        disabled={isPullToRefreshDisabled}
        className="flex-1"
      >
        <CustomScrollArea ref={scrollContainerRef} className="h-full">
          <div
            ref={gridRef}
            role="grid"
            aria-label="Spreadsheet"
            aria-rowcount={sheet.rowCount}
            aria-colcount={sheet.columnCount}
            aria-activedescendant={`cell-${currentAddress}`}
            tabIndex={0}
            onKeyDown={handleGridKeyDown}
            className="focus:outline-none touch-pan-x touch-pan-y"
          >
        <table className="min-w-max border-collapse text-sm" role="presentation">
          <thead>
            <tr role="row">
              <th
                role="columnheader"
                className="sticky left-0 top-0 z-20 h-8 w-10 border border-border bg-muted text-left text-xs font-semibold text-muted-foreground sm:w-14"
                aria-label="Row headers"
              ></th>
              {Array.from({ length: sheet.columnCount }).map((_, columnIndex) => (
                <th
                  key={`column-${columnIndex}`}
                  role="columnheader"
                  aria-colindex={columnIndex + 1}
                  className="sticky top-0 z-10 h-8 min-w-[80px] border border-border bg-muted px-2 text-left text-xs font-semibold text-muted-foreground sm:min-w-[120px] sm:px-3"
                >
                  {getColumnLabel(columnIndex)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {Array.from({ length: sheet.rowCount }).map((_, rowIndex) => (
              <tr key={`row-${rowIndex}`} role="row">
                <th
                  role="rowheader"
                  aria-rowindex={rowIndex + 1}
                  className="sticky left-0 z-10 h-9 border border-border bg-muted px-1.5 text-left text-xs font-semibold text-muted-foreground sm:h-10 sm:px-2"
                >
                  {rowIndex + 1}
                </th>
                {Array.from({ length: sheet.columnCount }).map((_, columnIndex) => {
                  const cellAddress = encodeCellAddress(rowIndex, columnIndex);
                  const isSelected = isCellInSelection(rowIndex, columnIndex, selection);
                  const isPrimaryCell = currentSelection.row === rowIndex && currentSelection.column === columnIndex;
                  const cellError = evaluation.errors[rowIndex]?.[columnIndex];
                  const displayValue = evaluation.display[rowIndex]?.[columnIndex] ?? '';
                  return (
                    <td
                      key={cellAddress}
                      id={`cell-${cellAddress}`}
                      role="gridcell"
                      aria-rowindex={rowIndex + 1}
                      aria-colindex={columnIndex + 1}
                      aria-selected={isSelected}
                      aria-readonly={isReadOnly}
                      aria-label={`${cellAddress}: ${displayValue || 'empty'}`}
                      data-cell={cellAddress}
                      tabIndex={isPrimaryCell ? 0 : -1}
                      className={cn(
                        'h-9 min-w-[80px] cursor-pointer border border-border bg-background px-2 align-middle text-sm',
                        'sm:h-10 sm:min-w-[120px] sm:px-3',
                        'transition-colors hover:bg-muted/40 focus:outline-none focus:ring-2 focus:ring-primary focus:ring-inset',
                        // Mobile: larger tap targets with active states
                        'active:bg-muted/60 touch-manipulation',
                        isSelected && 'bg-primary/10',
                        isPrimaryCell && 'outline outline-2 outline-offset-[-2px] outline-primary',
                        cellError && 'bg-destructive/10 text-destructive',
                        editingCell && editingCell.row === rowIndex && editingCell.column === columnIndex && 'opacity-50',
                        isDragging && 'select-none'
                      )}
                      onMouseDown={(e) => handleCellMouseDown(rowIndex, columnIndex, e)}
                      onMouseEnter={() => handleCellMouseEnter(rowIndex, columnIndex)}
                      onClick={() => handleCellSelect(rowIndex, columnIndex)}
                      onContextMenu={(e) => handleCellRightClick(rowIndex, columnIndex, e)}
                      onDoubleClick={() => {
                        if (!isReadOnly) {
                          startCellEdit(rowIndex, columnIndex);
                        }
                      }}
                      // Touch events for mobile
                      onTouchStart={(e) => handleCellTouchStart(rowIndex, columnIndex, e)}
                      onTouchMove={handleCellTouchMove}
                      onTouchEnd={(e) => handleCellTouchEnd(rowIndex, columnIndex, e)}
                    >
                      <span className="block w-full truncate">
                        {displayValue}
                      </span>
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
        </CustomScrollArea>
      </PullToRefresh>

      {/* Floating Cell Editor */}
      <FloatingCellEditor
        value={editingValue}
        cellRect={editingCellRect}
        isVisible={!!editingCell}
        onCommit={commitCellEdit}
        onCancel={cancelCellEdit}
        onValueChange={(value) => {
          setEditingValue(value);
          setFormulaValue(value); // Keep formula bar in sync
        }}
        isReadOnly={isReadOnly}
        initialKey={initialKey}
        driveId={page.driveId}
      />

      {/* Context Menu */}
      {contextMenu.show && (
        <div
          className="fixed z-50 bg-background border border-border rounded-md shadow-lg py-1 min-w-[160px]"
          style={{
            left: `${Math.min(contextMenu.x, window.innerWidth - 180)}px`,
            top: `${Math.min(contextMenu.y, window.innerHeight - 200)}px`,
          }}
          onClick={(e) => e.stopPropagation()}
        >
          <div
            className="flex items-center px-3 py-2 text-sm cursor-pointer hover:bg-muted transition-colors"
            onClick={() => {
              handleCopy('formulas');
              setContextMenu(prev => ({ ...prev, show: false }));
            }}
          >
            Copy
          </div>
          <div
            className="flex items-center px-3 py-2 text-sm cursor-pointer hover:bg-muted transition-colors"
            onClick={() => {
              handleCopy('values');
              setContextMenu(prev => ({ ...prev, show: false }));
            }}
          >
            Copy Values
          </div>
          <div className="h-px bg-border my-1" />
          <div
            className={cn(
              "flex items-center px-3 py-2 text-sm cursor-pointer hover:bg-muted transition-colors",
              (!copiedData && !navigator.clipboard) && "opacity-50 cursor-not-allowed"
            )}
            onClick={() => {
              if (copiedData || navigator.clipboard) {
                handlePaste('auto');
                setContextMenu(prev => ({ ...prev, show: false }));
              }
            }}
          >
            Paste
          </div>
          <div
            className={cn(
              "flex items-center px-3 py-2 text-sm cursor-pointer hover:bg-muted transition-colors",
              (!copiedData && !navigator.clipboard) && "opacity-50 cursor-not-allowed"
            )}
            onClick={() => {
              if (copiedData || navigator.clipboard) {
                handlePaste('values');
                setContextMenu(prev => ({ ...prev, show: false }));
              }
            }}
          >
            Paste Values
          </div>
        </div>
      )}

      {/* Mobile Action Sheet (long-press menu) */}
      {mobileActionSheet.show && (
        <>
          {/* Backdrop */}
          <div
            className="fixed inset-0 z-40 bg-black/50 sm:hidden"
            onClick={closeMobileActionSheet}
            aria-hidden="true"
          />
          {/* Action Sheet */}
          <div
            className="fixed inset-x-0 bottom-0 z-50 rounded-t-2xl bg-background p-4 pb-[calc(2rem+env(safe-area-inset-bottom))] shadow-lg sm:hidden"
            role="dialog"
            aria-modal="true"
            aria-label="Cell actions"
          >
            {/* Handle bar */}
            <div className="mx-auto mb-4 h-1 w-12 rounded-full bg-muted-foreground/30" />

            {/* Cell info */}
            <div className="mb-4 text-center">
              <span className="text-sm font-medium text-muted-foreground">
                Cell {mobileActionSheet.cell ? encodeCellAddress(mobileActionSheet.cell.row, mobileActionSheet.cell.column) : ''}
              </span>
            </div>

            {/* Action buttons */}
            <div className="space-y-2">
              <button
                className="flex w-full items-center justify-center gap-2 rounded-lg bg-muted/50 px-4 py-3 text-base font-medium transition-colors active:bg-muted"
                onClick={() => {
                  if (mobileActionSheet.cell && !isReadOnly) {
                    startCellEdit(mobileActionSheet.cell.row, mobileActionSheet.cell.column);
                  }
                  closeMobileActionSheet();
                }}
                disabled={isReadOnly}
              >
                Edit Cell
              </button>
              <button
                className="flex w-full items-center justify-center gap-2 rounded-lg bg-muted/50 px-4 py-3 text-base font-medium transition-colors active:bg-muted"
                onClick={() => {
                  handleCopy('formulas');
                  closeMobileActionSheet();
                }}
              >
                Copy
              </button>
              <button
                className="flex w-full items-center justify-center gap-2 rounded-lg bg-muted/50 px-4 py-3 text-base font-medium transition-colors active:bg-muted"
                onClick={() => {
                  handleCopy('values');
                  closeMobileActionSheet();
                }}
              >
                Copy Value
              </button>
              <button
                className={cn(
                  "flex w-full items-center justify-center gap-2 rounded-lg bg-muted/50 px-4 py-3 text-base font-medium transition-colors active:bg-muted",
                  (!copiedData && !navigator.clipboard) && "opacity-50"
                )}
                onClick={() => {
                  if (copiedData || navigator.clipboard) {
                    handlePaste('auto');
                  }
                  closeMobileActionSheet();
                }}
                disabled={!copiedData && !navigator.clipboard}
              >
                Paste
              </button>
              <button
                className={cn(
                  "flex w-full items-center justify-center gap-2 rounded-lg bg-destructive/10 px-4 py-3 text-base font-medium text-destructive transition-colors active:bg-destructive/20",
                  isReadOnly && "opacity-50"
                )}
                onClick={() => {
                  if (!isReadOnly && mobileActionSheet.cell) {
                    const cellAddress = encodeCellAddress(mobileActionSheet.cell.row, mobileActionSheet.cell.column);
                    applySheetUpdate((previous) => {
                      const nextCells = { ...previous.cells };
                      delete nextCells[cellAddress];
                      return {
                        ...previous,
                        version: previous.version + 1,
                        cells: nextCells,
                      };
                    });
                    setFormulaValue('');
                  }
                  closeMobileActionSheet();
                }}
                disabled={isReadOnly}
              >
                Clear Cell
              </button>
            </div>

            {/* Cancel button */}
            <button
              className="mt-4 flex w-full items-center justify-center rounded-lg border border-border px-4 py-3 text-base font-medium transition-colors active:bg-muted"
              onClick={closeMobileActionSheet}
            >
              Cancel
            </button>
          </div>
        </>
      )}

      {/* Screen reader announcements */}
      <div
        role="status"
        aria-live="polite"
        aria-atomic="true"
        className="sr-only"
      >
        {announcement}
      </div>

      {/* Quick Stats Footer */}
      <div className="flex items-center justify-between border-t bg-muted/30 px-3 py-1.5 text-xs text-muted-foreground sm:px-4">
        <div className="flex items-center gap-4">
          <span className="font-medium">{selectionAddress}</span>
          {selection.type === 'range' && (
            <span className="text-muted-foreground/70">
              {Math.abs(selection.range.end.row - selection.range.start.row) + 1} × {Math.abs(selection.range.end.column - selection.range.start.column) + 1} cells
            </span>
          )}
        </div>
        <div className="flex items-center gap-3 sm:gap-4">
          {selectionStats.numericCount > 0 && (
            <>
              <span className="hidden sm:inline">
                <span className="text-muted-foreground/70">Sum: </span>
                <span className="font-medium tabular-nums">{selectionStats.sum?.toLocaleString(undefined, { maximumFractionDigits: 4 })}</span>
              </span>
              <span>
                <span className="text-muted-foreground/70">Avg: </span>
                <span className="font-medium tabular-nums">{selectionStats.average?.toLocaleString(undefined, { maximumFractionDigits: 4 })}</span>
              </span>
            </>
          )}
          <span>
            <span className="text-muted-foreground/70">Count: </span>
            <span className="font-medium tabular-nums">{selectionStats.count}</span>
          </span>
        </div>
      </div>
    </div>
  );
};

const SheetView: React.FC<SheetViewProps> = (props) => (
  <SuggestionProvider>
    <SheetViewComponent {...props} />
  </SuggestionProvider>
);

export default SheetView;
