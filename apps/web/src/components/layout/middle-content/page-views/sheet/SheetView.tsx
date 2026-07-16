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
import { FloatingCellEditor } from './FloatingCellEditor';
import { useSheetHistory } from './useSheetHistory';
import { useSuggestion } from '@/hooks/useSuggestion';
import { SuggestionProvider, useSuggestionContext } from '@/components/providers/SuggestionProvider';
import { fetchWithAuth } from '@/lib/auth/auth-fetch';
import { useSheetFind } from './hooks/useSheetFind';
import {
  clampSelection,
  clampRange,
  getPrimaryCell,
  isCellInSelection,
  getSelectionAddress,
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
import { useSheetTouch } from './hooks/useSheetTouch';
import { useAnnouncements } from './hooks/useAnnouncements';
import { useSheetPermissions } from './hooks/useSheetPermissions';
import { useContextMenu } from './hooks/useContextMenu';
import { useExternalSheets } from './hooks/useExternalSheets';
import { useSheetPersistence } from './hooks/useSheetPersistence';
import { useSheetKeyboardShortcuts } from './hooks/useSheetKeyboardShortcuts';
import { useEditingSession } from '@/stores/useEditingSession';
import { shouldRegisterSheetEditing } from './core/editing';
import { sheetTriggerPattern } from './core/constants';
import { SheetStatusBar } from './components/SheetStatusBar';
import { SheetContextMenu } from './components/SheetContextMenu';
import { SheetMobileActionSheet } from './components/SheetMobileActionSheet';
import { SheetFormulaBar } from './components/SheetFormulaBar';
import { SheetGrid } from './components/SheetGrid';

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

  // Register an editing session while a cell is being edited, the formula bar is
  // focused, or the document is dirty — protecting sheet edits from auth-refresh
  // interruption and SWR clobbering (SheetView was the only unregistered editor).
  const isEditingActive = shouldRegisterSheetEditing({
    isEditingCell: !!editingCell,
    isFormulaFocused,
    isDirty: !!documentState?.isDirty,
  });
  useEditingSession(`sheet-${page.id}`, isEditingActive, 'document', {
    pageId: page.id,
    componentName: 'SheetView',
  });

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
      <SheetFormulaBar
        isRange={selection.type === 'range'}
        selectionAddress={selectionAddress}
        currentDisplay={currentDisplay}
        currentError={currentError}
        isReadOnly={isReadOnly}
        canUndo={canUndo}
        canRedo={canRedo}
        onUndo={handleUndo}
        onRedo={handleRedo}
        onAddRow={handleAddRow}
        onAddColumn={handleAddColumn}
        formulaInputRef={formulaInputRef}
        formulaValue={formulaValue}
        onFormulaFocus={() => {
          setIsFormulaFocused(true);
          // If we're not already editing, start editing the current cell.
          if (!editingCell) {
            const { row, column } = currentSelection;
            startCellEdit(row, column);
          }
        }}
        onFormulaBlur={(event) => {
          setIsFormulaFocused(false);
          if (editingCell && event.target.value !== currentRaw) {
            commitCellEdit(event.target.value);
          } else if (!editingCell && event.target.value !== currentRaw) {
            handleCommitFormula(event.target.value);
          }
        }}
        onFormulaChange={(value) => suggestion.handleValueChange(value)}
        onFormulaKeyDown={handleFormulaKeyDown}
        driveId={page.driveId}
        mention={{
          isOpen: suggestionContext.isOpen,
          position: suggestionContext.position,
          query: suggestion.query,
          onSelect: suggestion.actions.selectSuggestion,
          onClose: suggestion.actions.close,
        }}
      />
      <PullToRefresh
        direction="top"
        onRefresh={handleRefresh}
        disabled={isPullToRefreshDisabled}
        className="flex-1"
      >
        <CustomScrollArea ref={scrollContainerRef} className="h-full">
          <SheetGrid
            gridRef={gridRef}
            sheet={sheet}
            selection={selection}
            currentSelection={currentSelection}
            currentAddress={currentAddress}
            evaluation={evaluation}
            editingCell={editingCell}
            isReadOnly={isReadOnly}
            isDragging={isDragging}
            findAddressSet={findAddressSet}
            currentFindAddress={currentFindAddress}
            onKeyDown={handleGridKeyDown}
            onCellMouseDown={handleCellMouseDown}
            onCellMouseEnter={handleCellMouseEnter}
            onCellSelect={handleCellSelect}
            onCellRightClick={handleCellRightClick}
            onCellDoubleClick={(row, column) => {
              if (!isReadOnly) {
                startCellEdit(row, column);
              }
            }}
            onCellTouchStart={handleCellTouchStart}
            onCellTouchMove={handleCellTouchMove}
            onCellTouchEnd={handleCellTouchEnd}
          />
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
      <SheetContextMenu
        contextMenu={contextMenu}
        canPaste={!!copiedData || canUseClipboard}
        onCopy={handleCopy}
        onPaste={handlePaste}
        onClose={closeContextMenu}
      />

      {/* Mobile Action Sheet (long-press menu) */}
      <SheetMobileActionSheet
        state={mobileActionSheet}
        isReadOnly={isReadOnly}
        canPaste={!!copiedData || canUseClipboard}
        onEdit={(cell) => startCellEdit(cell.row, cell.column)}
        onCopy={handleCopy}
        onPaste={() => handlePaste('auto')}
        onClear={(cell) => {
          applySheetUpdate((previous) => applyCellDelete(previous, encodeCellAddress(cell.row, cell.column)));
          setFormulaValue('');
        }}
        onClose={closeMobileActionSheet}
      />

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
      <SheetStatusBar selectionAddress={selectionAddress} selection={selection} stats={selectionStats} />
    </div>
  );
};

const SheetView: React.FC<SheetViewProps> = (props) => (
  <SuggestionProvider>
    <SheetViewComponent {...props} />
  </SuggestionProvider>
);

export default SheetView;
