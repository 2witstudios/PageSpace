"use client";

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { TreePage, usePageTree } from '@/hooks/usePageTree';
import { useSocket } from '@/hooks/useSocket';
import { useAuth } from '@/hooks/useAuth';
import { toast } from 'sonner';
import { PullToRefresh } from '@/components/ui/pull-to-refresh';
import { CustomScrollArea } from '@/components/ui/custom-scroll-area';
import {
  SheetData,
  SheetExternalReferenceToken,
  collectExternalReferences,
  encodeCellAddress,
  evaluateSheet,
  parseSheetContent,
  sanitizeSheetData,
  serializeSheetContent,
} from '@pagespace/lib/sheets/sheet';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { FloatingCellEditor } from './FloatingCellEditor';
import { useSheetHistory } from './useSheetHistory';
import { useSuggestion } from '@/hooks/useSuggestion';
import { SuggestionProvider, useSuggestionContext } from '@/components/providers/SuggestionProvider';
import { MentionPickerPortal } from '@/components/mentions/MentionPickerPortal';
import { fetchWithAuth } from '@/lib/auth/auth-fetch';
import { useSheetFind } from './hooks/useSheetFind';
import {
  clampSelection,
  clampRange,
  getPrimaryCell,
  isCellInSelection,
  getSelectionAddress,
  getColumnLabel,
  nextSelectionForKey,
  type GridSelection,
  type SelectionState,
} from './core/selection';
import {
  parseClipboardData,
  buildCopyPayload,
  resolvePasteMode,
  computePasteCells,
  pasteResultSelection,
  type CopyMode,
  type PasteMode,
} from './core/clipboard';
import {
  applyCellWrite,
  applyCellDelete,
  initialEditValueForKey,
  isPrintableKey,
  addRow,
  addColumn,
} from './core/cell-ops';
import {
  flattenTree,
  buildParentMap,
  resolveReferenceTarget,
  resolveExternalReference,
} from './core/references';
import { computeSelectionStats } from './core/stats';
import { clampContextMenuPosition } from './core/layout';
import { useSheetTouch } from './hooks/useSheetTouch';
import { useAnnouncements } from './hooks/useAnnouncements';
import { useSheetPermissions } from './hooks/useSheetPermissions';
import { useContextMenu } from './hooks/useContextMenu';
import { useExternalSheets } from './hooks/useExternalSheets';
import { useSheetPersistence } from './hooks/useSheetPersistence';
import { useSheetKeyboardShortcuts } from './hooks/useSheetKeyboardShortcuts';

interface SheetViewProps {
  page: TreePage;
}

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

  // Mouse/touch drag selection state
  const [isDragging, setIsDragging] = useState(false);
  const [dragStart, setDragStart] = useState<GridSelection | null>(null);

  // Context menu (desktop right-click). Bounds/viewport are snapshotted on open.
  const { contextMenu, openContextMenu, closeContextMenu } = useContextMenu();

  // Measured grid width (undefined until first measurement) and clipboard
  // availability — both read once outside render, never per-render from the DOM.
  const [containerWidth, setContainerWidth] = useState<number | undefined>(undefined);
  const [canUseClipboard, setCanUseClipboard] = useState(false);

  // Copy mode state
  const [copiedData, setCopiedData] = useState<{
    mode: CopyMode;
    data: string;
    source: SelectionState;
  } | null>(null);

  // Floating editor state
  const [editingCell, setEditingCell] = useState<GridSelection | null>(null);
  const [editingValue, setEditingValue] = useState('');
  const [editingCellRect, setEditingCellRect] = useState<DOMRect | null>(null);
  const [initialKey, setInitialKey] = useState<string | undefined>(undefined);

  // Accessibility announcements (transient live-region message)
  const { announcement, announce } = useAnnouncements();

  const formulaInputRef = useRef<HTMLInputElement>(null);
  const gridRef = useRef<HTMLDivElement>(null);
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const socket = useSocket();
  const { user } = useAuth();
  const isReadOnly = useSheetPermissions(page.id, user?.id);
  const { tree } = usePageTree(page.driveId);
  const externalReferences = useMemo(() => collectExternalReferences(sheet), [sheet]);
  const flattenedPages = useMemo(() => (tree && tree.length > 0 ? flattenTree(tree) : []), [tree]);

  const parentMap = useMemo(() => buildParentMap(flattenedPages), [flattenedPages]);

  const resolveReference = useCallback(
    (reference: SheetExternalReferenceToken) =>
      resolveReferenceTarget(reference, {
        flattenedPages,
        parentMap,
        currentPageId: page.id,
        currentParentId: page.parentId,
      }),
    [flattenedPages, parentMap, page.id, page.parentId]
  );

  const {
    documentState,
    updateContent,
    updateContentFromServer,
    saveWithDebounce,
    forceSaveNow,
  } = useSheetPersistence({ pageId: page.id, socket, resetHistory });

  // Pull-to-refresh handler
  const handleRefresh = useCallback(async () => {
    try {
      const response = await fetchWithAuth(`/api/pages/${page.id}`);
      if (response.ok) {
        const updatedPage = await response.json();
        updateContentFromServer(updatedPage.content, updatedPage.revision);
      }
    } catch (error) {
      console.error('Failed to refresh sheet:', error);
    }
  }, [page.id, updateContentFromServer]);

  // Disable pull-to-refresh when editing
  const isPullToRefreshDisabled = !!editingCell || documentState?.isDirty || isFormulaFocused;

  const externalSheets = useExternalSheets(externalReferences, resolveReference);

  const evaluationOptions = useMemo(
    () => ({
      pageId: page.id,
      pageTitle: page.title,
      resolveExternalReference: (reference: SheetExternalReferenceToken) =>
        resolveExternalReference(reference, externalSheets),
    }),
    [externalSheets, page.id, page.title]
  );

  const evaluation = useMemo(() => evaluateSheet(sheet, evaluationOptions), [sheet, evaluationOptions]);

  // Find-in-sheet: highlight set + current match (scrolls into view).
  const { findAddressSet, currentFindAddress } = useSheetFind(sheet, evaluation.display, gridRef);

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
  const selectionStats = useMemo(
    () => computeSelectionStats(selection, evaluation.byAddress),
    [selection, evaluation.byAddress]
  );

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
      const initialValue = initialEditValueForKey(currentValue, key);

      setEditingCell({ row, column });
      setEditingValue(initialValue);
      setEditingCellRect(cellRect);
      setInitialKey(key && key.length === 1 ? key : undefined);

      // Update formula bar to match
      setFormulaValue(initialValue);

      // Announce edit mode to screen readers
      announce(`Editing cell ${cellAddress}`);
    },
    [sheet.cells, isReadOnly, announce]
  );

  // Commit cell edit
  const commitCellEdit = useCallback(
    (value: string) => {
      if (!editingCell || isReadOnly) return;

      const cellAddress = encodeCellAddress(editingCell.row, editingCell.column);

      applySheetUpdate((previous) => applyCellWrite(previous, cellAddress, value));

      // Exit editing mode
      setEditingCell(null);
      setEditingValue('');
      setEditingCellRect(null);
      setInitialKey(undefined);

      // Update formula bar
      setFormulaValue(value);

      // Announce completion to screen readers
      announce(`Cell ${cellAddress} updated`);

      // Return focus to grid
      requestAnimationFrame(() => {
        gridRef.current?.focus({ preventScroll: true });
      });
    },
    [editingCell, isReadOnly, applySheetUpdate, announce]
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
    announce(`Edit cancelled for cell ${cancelledCellAddress}`);

    // Return focus to grid
    requestAnimationFrame(() => {
      gridRef.current?.focus({ preventScroll: true });
    });
  }, [editingCell, sheet.cells, announce]);

  const handleCommitFormula = useCallback(
    (value: string) => {
      if (isReadOnly) {
        toast.error("You don't have permission to edit this sheet");
        return;
      }
      setFormulaValue(value);
      applySheetUpdate((previous) => applyCellWrite(previous, currentAddress, value));
    },
    [applySheetUpdate, currentAddress, isReadOnly]
  );

  const handleAddRow = useCallback(() => {
    if (isReadOnly) {
      toast.error("You don't have permission to edit this sheet");
      return;
    }
    applySheetUpdate(addRow);
  }, [applySheetUpdate, isReadOnly]);

  const handleAddColumn = useCallback(() => {
    if (isReadOnly) {
      toast.error("You don't have permission to edit this sheet");
      return;
    }
    applySheetUpdate(addColumn);
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
      announce('Undo performed');
    }
  }, [isReadOnly, canUndo, undo, updateContent, saveWithDebounce, announce]);

  // Redo handler
  const handleRedo = useCallback(() => {
    if (isReadOnly || !canRedo) return;

    const nextState = redo();
    if (nextState) {
      const serialized = serializeSheetContent(nextState);
      updateContent(serialized);
      saveWithDebounce(serialized);
      toast.success('Redo', { duration: 1500 });
      announce('Redo performed');
    }
  }, [isReadOnly, canRedo, redo, updateContent, saveWithDebounce, announce]);

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
      closeContextMenu();

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
    [sheet, editingCell, isReadOnly, closeContextMenu]
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

      // Open the context menu at the cursor. The hook snapshots the grid bounds
      // and viewport now (event handler, not render) so the pure clamp can
      // position the menu without touching the DOM during render.
      openContextMenu(event.clientX, event.clientY, cell, gridRef.current);
    },
    [sheet, selection, openContextMenu]
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

  // Add global mouse up listener to handle drag end outside grid
  useEffect(() => {
    if (isDragging) {
      document.addEventListener('mouseup', handleMouseUp);
      return () => {
        document.removeEventListener('mouseup', handleMouseUp);
      };
    }
  }, [isDragging, handleMouseUp]);

  // Handle paste operation
  const handlePaste = useCallback(
    async (mode: PasteMode = 'auto', event?: ClipboardEvent) => {
      if (isReadOnly || editingCell) return;

      event?.preventDefault();

      try {
        const clipboardText = await navigator.clipboard.readText();
        const tableData = parseClipboardData(clipboardText);

        if (!tableData) return;

        const start = getPrimaryCell(selection);

        // Determine paste behavior (internal pastes reuse the copied mode).
        const isInternalPaste = !!copiedData && copiedData.data === clipboardText;
        const pasteMode = resolvePasteMode(mode, isInternalPaste, copiedData?.mode);
        const copyStart = isInternalPaste && copiedData ? getPrimaryCell(copiedData.source) : undefined;

        applySheetUpdate((previous) =>
          computePasteCells({
            previous,
            table: tableData,
            start,
            pasteMode,
            isInternalPaste,
            copyStart,
          })
        );

        // Update selection to show the pasted range if multi-cell.
        const nextSelection = pasteResultSelection(start, tableData);
        if (nextSelection) {
          setSelection(nextSelection);
        }

        const modeText = pasteMode === 'formulas' ? ' (formulas)' : ' (values)';
        toast.success(`Pasted ${tableData.rows} row(s) and ${tableData.columns} column(s)${modeText}`);
      } catch (error) {
        console.error('Paste failed:', error);
        toast.error('Failed to paste clipboard data');
      }
    },
    [isReadOnly, editingCell, selection, applySheetUpdate, copiedData]
  );

  // Handle copy operation
  const handleCopy = useCallback(
    async (mode: CopyMode = 'formulas', event?: KeyboardEvent) => {
      if (editingCell) return; // Don't copy while editing

      event?.preventDefault();

      try {
        const { data: copyData, cellCount } = buildCopyPayload(
          selection,
          sheet,
          evaluation.display,
          mode
        );

        await navigator.clipboard.writeText(copyData);

        // Store copied data info for paste behavior
        setCopiedData({
          mode,
          data: copyData,
          source: selection,
        });

        const modeText = mode === 'formulas' ? 'formulas' : 'values';
        toast.success(`Copied ${cellCount} cell${cellCount > 1 ? 's' : ''} (${modeText}) to clipboard`);
      } catch (error) {
        console.error('Copy failed:', error);
        toast.error('Failed to copy to clipboard');
      }
    },
    [editingCell, selection, sheet, evaluation.display]
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

  // Clipboard availability is a one-time capability check, not a per-render
  // `navigator` read.
  useEffect(() => {
    setCanUseClipboard(typeof navigator !== 'undefined' && !!navigator.clipboard);
  }, []);

  // Measure the grid width into state so the floating editor's responsive sizing
  // never reads getBoundingClientRect() during render.
  useEffect(() => {
    const gridElement = gridRef.current;
    if (!gridElement) return;
    const measure = () => setContainerWidth(gridElement.getBoundingClientRect().width);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(gridElement);
    return () => observer.disconnect();
  }, []);

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

  // Mobile touch gestures (long-press action sheet, tap-to-select, double-tap-to-edit).
  const onLongPressSelect = useCallback((cell: GridSelection) => {
    setSelection({ type: 'single', cell });
  }, []);
  const {
    mobileActionSheet,
    closeMobileActionSheet,
    handleCellTouchStart,
    handleCellTouchMove,
    handleCellTouchEnd,
  } = useSheetTouch({
    sheet,
    selection,
    isReadOnly,
    onTap: handleCellSelect,
    onDoubleTap: startCellEdit,
    onLongPressSelect,
  });

  const handleGridKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      const { key, shiftKey, ctrlKey, metaKey } = event;
      const primaryCell = getPrimaryCell(selection);
      const { row, column } = clampSelection(primaryCell, sheet);

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

        applySheetUpdate((previous) => applyCellDelete(previous, cellAddress));

        // Update formula bar to show empty value
        setFormulaValue('');

        // Announce deletion to screen readers
        announce(`Cell ${cellAddress} cleared`);
        return;
      }

      // Check if this key should start direct cell editing
      if (isPrintableKey(key)) {
        event.preventDefault();
        startCellEdit(row, column, key);
        return;
      }

      const next = nextSelectionForKey({ key, shiftKey, isReadOnly }, { row, column }, sheet);
      if (!next) {
        return;
      }
      event.preventDefault();

      setSelection({
        type: 'single',
        cell: next
      });
    },
    [isReadOnly, selection, sheet, editingCell, startCellEdit, handleCopy, applySheetUpdate, setFormulaValue, announce]
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

  // Reset the selection to the origin when navigating to a different page.
  useEffect(() => {
    setSelection({
      type: 'single',
      cell: { row: 0, column: 0 }
    });
  }, [page.id]);

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

    // Also recompute when the panel container resizes (sidebar drag)
    const resizeObserver = new ResizeObserver(updateCellRect);
    if (gridRef.current) resizeObserver.observe(gridRef.current);

    return () => {
      if (scrollElement) {
        scrollElement.removeEventListener('scroll', handleScroll);
      }
      window.removeEventListener('resize', handleResize);
      resizeObserver.disconnect();
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

  // Global keyboard shortcuts (Ctrl/Cmd + S / Z / Y) — attached once, ref-driven.
  useSheetKeyboardShortcuts({ onSave: forceSaveNow, onUndo: handleUndo, onRedo: handleRedo });

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
            <MentionPickerPortal
              isOpen={suggestionContext.isOpen}
              position={suggestionContext.position}
              driveId={page.driveId}
              allowedTypes={['page']}
              initialQuery={suggestion.query}
              onSelect={suggestion.actions.selectSuggestion}
              onClose={suggestion.actions.close}
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
                        isDragging && 'select-none',
                        findAddressSet.has(cellAddress) && 'find-highlight',
                        currentFindAddress === cellAddress && 'find-highlight-current'
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
        containerWidth={containerWidth}
      />

      {/* Context Menu */}
      {contextMenu.show && (
        <div
          className="fixed z-50 bg-background border border-border rounded-md shadow-lg py-1 min-w-[160px]"
          style={clampContextMenuPosition(contextMenu.x, contextMenu.y, contextMenu.bounds, contextMenu.viewport)}
          onClick={(e) => e.stopPropagation()}
        >
          <div
            className="flex items-center px-3 py-2 text-sm cursor-pointer hover:bg-muted transition-colors"
            onClick={() => {
              handleCopy('formulas');
              closeContextMenu();
            }}
          >
            Copy
          </div>
          <div
            className="flex items-center px-3 py-2 text-sm cursor-pointer hover:bg-muted transition-colors"
            onClick={() => {
              handleCopy('values');
              closeContextMenu();
            }}
          >
            Copy Values
          </div>
          <div className="h-px bg-border my-1" />
          <div
            className={cn(
              "flex items-center px-3 py-2 text-sm cursor-pointer hover:bg-muted transition-colors",
              (!copiedData && !canUseClipboard) && "opacity-50 cursor-not-allowed"
            )}
            onClick={() => {
              if (copiedData || canUseClipboard) {
                handlePaste('auto');
                closeContextMenu();
              }
            }}
          >
            Paste
          </div>
          <div
            className={cn(
              "flex items-center px-3 py-2 text-sm cursor-pointer hover:bg-muted transition-colors",
              (!copiedData && !canUseClipboard) && "opacity-50 cursor-not-allowed"
            )}
            onClick={() => {
              if (copiedData || canUseClipboard) {
                handlePaste('values');
                closeContextMenu();
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
                  (!copiedData && !canUseClipboard) && "opacity-50"
                )}
                onClick={() => {
                  if (copiedData || canUseClipboard) {
                    handlePaste('auto');
                  }
                  closeMobileActionSheet();
                }}
                disabled={!copiedData && !canUseClipboard}
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
                    applySheetUpdate((previous) => applyCellDelete(previous, cellAddress));
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
