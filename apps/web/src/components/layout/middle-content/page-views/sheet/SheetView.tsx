"use client";

import React, { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import DocumentConflictGate from '@/components/layout/middle-content/page-views/document/DocumentConflictGate';
import { TreePage, usePageTree } from '@/hooks/usePageTree';
import { useSocket } from '@/hooks/useSocket';
import { useAuth } from '@/hooks/useAuth';
import { toast } from 'sonner';
import { motion } from 'motion/react';
import { PullToRefresh } from '@/components/ui/pull-to-refresh';
import {
  SheetData,
  SheetExternalReferenceToken,
  collectExternalReferences,
  decodeCellAddress,
  encodeCellAddress,
  evaluateSheetSparse,
  sparseDisplayAt,
  parseSheetContent,
  sanitizeSheetData,
  serializeSheetContent,
  setColumnWidth,
  setFrozen,
  setRowHeight,
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
import { useExternalSheets } from './hooks/useExternalSheets';
import { useSheetPersistence } from './hooks/useSheetPersistence';
import { useSheetKeyboardShortcuts } from './hooks/useSheetKeyboardShortcuts';
import { useEditingSession } from '@/stores/useEditingSession';
import { shouldRegisterSheetEditing } from './core/editing';
import { sheetTriggerPattern } from './core/constants';
import { SheetStatusBar } from './components/SheetStatusBar';
import { SheetContextMenu } from './components/SheetContextMenu';
import { ContextMenu, ContextMenuTrigger } from '@/components/ui/context-menu';
import { SheetMobileActionSheet } from './components/SheetMobileActionSheet';
import { SheetFormulaBar } from './components/SheetFormulaBar';
import { SheetGrid } from './components/SheetGrid';
import { SheetToolbar } from './components/SheetToolbar';
import { SheetTabBar } from './components/SheetTabBar';
import type { SheetCellHandlers } from './components/SheetCell';
import {
  DENSITY_ROW_HEIGHTS,
  buildColumnAxis,
  buildRowAxis,
  cellViewportRect,
  isCellVisible,
  scrollOffsetToReveal,
  type GridDensity,
  type SizeOverride,
} from './core/grid-metrics';
import { useGridViewport } from './hooks/useGridViewport';
import {
  activeFormat,
  applyFormatCommand,
  selectionAddresses,
  type FormatCommand,
} from './core/format-commands';

interface SheetViewProps {
  page: TreePage;
}

/** Ctrl/Cmd chords that apply a format to the selection. */
const FORMAT_SHORTCUTS: Record<string, FormatCommand> = {
  b: { kind: 'toggle', field: 'bold' },
  i: { kind: 'toggle', field: 'italic' },
  u: { kind: 'toggle', field: 'underline' },
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
  const [initialKey, setInitialKey] = useState<string | undefined>(undefined);

  // Row density, and the size currently being dragged but not yet committed.
  const [density, setDensity] = useState<GridDensity>('normal');
  const [columnResize, setColumnResize] = useState<SizeOverride | undefined>(undefined);
  const [rowResize, setRowResize] = useState<SizeOverride | undefined>(undefined);

  // Accessibility announcements (transient live-region message)
  const { announcement, announce } = useAnnouncements();

  const formulaInputRef = useRef<HTMLInputElement>(null);
  const gridRef = useRef<HTMLDivElement>(null);
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const socket = useSocket();
  const { user } = useAuth();
  const lacksEditPermission = useSheetPermissions(page.id, user?.id);
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
    loadError,
    updateContent,
    updateContentFromServer,
    saveWithDebounce,
    forceSaveNow,
    conflict,
    resolveConflict,
    isResolvingConflict,
  } = useSheetPersistence({ pageId: page.id, socket, resetHistory });

  // Editing is blocked either by permissions or by a load failure. When the
  // stored content could not be parsed we must not let edits through: saving
  // would overwrite content we were unable to read.
  const isReadOnly = lacksEditPermission || loadError !== null;

  // Two different reasons to refuse an edit deserve two different messages;
  // blaming permissions for a load failure sends the user to the wrong place.
  const readOnlyReason = loadError
    ? 'This sheet could not be loaded, so editing is disabled'
    : "You don't have permission to edit this sheet";

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

  /**
   * Sparse: one entry per cell that exists, not per grid position.
   *
   * The dense `evaluateSheet` allocates `rowCount × columnCount` objects and
   * runs on every keystroke — 600,000 of them for a 10,000-row sheet — so
   * virtualizing the grid alone would not have made a large sheet usable. The
   * dense form is still what the exports, the published page, and the
   * serializer use; `sheet-sparse-equivalence.test.ts` holds the two together.
   */
  const evaluation = useMemo(
    () => evaluateSheetSparse(sheet, evaluationOptions),
    [sheet, evaluationOptions]
  );

  /** Evaluated text at a position, for copy and find. */
  const displayAt = useCallback(
    (row: number, column: number) => sparseDisplayAt(evaluation, row, column),
    [evaluation]
  );

  // Grid geometry. The axes are prefix sums over the stored column widths and
  // row heights, with any in-flight resize drag previewed on top; the viewport
  // is the scroll container measured into state. Every position in the surface
  // — which cells exist, where the header strips sit, where the cell editor is
  // anchored — derives from exactly these two, so they cannot disagree.
  const columnAxis = useMemo(
    () => buildColumnAxis(sheet, columnResize),
    [sheet, columnResize]
  );
  const rowAxis = useMemo(
    () => buildRowAxis(sheet, DENSITY_ROW_HEIGHTS[density], rowResize),
    [sheet, density, rowResize]
  );
  const { viewport, scrollTo } = useGridViewport(scrollContainerRef);

  /**
   * The latest viewport, read through a ref rather than a dependency.
   *
   * `revealCell` needs the current scroll offsets, but depending on `viewport`
   * would give it a new identity on every scroll frame — and that identity
   * propagates through `startCellEdit` into the per-cell handlers object,
   * changing every cell's props on every frame and defeating the memo that
   * makes virtualization worth having.
   */
  const viewportRef = useRef(viewport);
  viewportRef.current = viewport;

  /** Scroll the minimum distance that brings a cell into view, if it is not already. */
  const revealCell = useCallback(
    (row: number, column: number) => {
      const view = viewportRef.current;
      const left = scrollOffsetToReveal(
        columnAxis,
        column,
        view.scrollLeft,
        view.bodyWidth,
        sheet.frozenColumns ?? 0
      );
      const top = scrollOffsetToReveal(
        rowAxis,
        row,
        view.scrollTop,
        view.bodyHeight,
        sheet.frozenRows ?? 0
      );
      if (left !== view.scrollLeft || top !== view.scrollTop) {
        scrollTo(left, top);
      }
    },
    [columnAxis, rowAxis, scrollTo, sheet.frozenColumns, sheet.frozenRows]
  );

  // Register an editing session while a cell is being edited, the formula bar is
  // focused, or the document is dirty — protecting sheet edits from auth-refresh
  // interruption and SWR clobbering (SheetView was the only unregistered editor).
  const isEditingActive = shouldRegisterSheetEditing({
    isEditingCell: !!editingCell,
    isFormulaFocused,
    isDirty: !!documentState?.isDirty,
  });
  // instanceId distinguishes this mount from any other simultaneous mount of
  // the SAME page (main center panel vs. an agent-session pane) — without it,
  // both compute the identical `sheet-${page.id}` key and collide in
  // useEditingStore's Map (see DocumentView's identical fix).
  const instanceId = useId();
  useEditingSession(`sheet-${page.id}-${instanceId}`, isEditingActive, 'document', {
    pageId: page.id,
    componentName: 'SheetView',
  });

  // Find-in-sheet: highlight set + current match (scrolls into view).
  const revealAddress = useCallback(
    (address: string) => {
      const { row, column } = decodeCellAddress(address);
      revealCell(row, column);
    },
    [revealCell]
  );
  const { findAddressSet, currentFindAddress } = useSheetFind(sheet, displayAt, revealAddress);

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

  /**
   * Serialize and hand off to the store, returning false if serialization
   * refused.
   *
   * `serializeSheetContent` re-parses its own output and throws rather than
   * emit something that would read back as an empty sheet. Every caller runs
   * inside a React event or state update, where an uncaught throw escapes to
   * the nearest error boundary and blanks the view — so the failure is turned
   * into a declined change here instead.
   */
  const persistSheet = useCallback(
    (sheet: SheetData): boolean => {
      try {
        const serialized = serializeSheetContent(sheet);
        updateContent(serialized);
        saveWithDebounce(serialized);
        return true;
      } catch (error) {
        console.error('Failed to serialize sheet; change not applied:', error);
        toast.error('That change could not be saved and was undone.');
        return false;
      }
    },
    [saveWithDebounce, updateContent]
  );

  const applySheetUpdate = useCallback(
    (updater: (previous: SheetData) => SheetData, shouldPersist = true) => {
      setSheet((previous) => {
        const updated = updater(previous);
        // A command that changed nothing (nudging decimals already at zero)
        // must not push an entry onto the undo stack or trigger a save.
        if (updated === previous) return previous;
        const sanitized = sanitizeSheetData({ ...updated });
        if (shouldPersist && !persistSheet(sanitized)) {
          // Serialization refused; keep the last good state.
          return previous;
        }
        return sanitized;
      });
    },
    [persistSheet, setSheet]
  );

  // Start editing a cell with optional initial key
  const startCellEdit = useCallback(
    (row: number, column: number, key?: string) => {
      if (isReadOnly) {
        toast.error(readOnlyReason);
        return;
      }

      const cellAddress = encodeCellAddress(row, column);
      const currentValue = sheet.cells[cellAddress] ?? '';
      const initialValue = initialEditValueForKey(currentValue, key);

      // The editor's rectangle is derived, not measured, so there is no
      // "cell element not found" case to bail out on any more. Scroll it into
      // view first, so starting an edit off-screen (via find, or the formula
      // bar) shows the user what they are editing.
      revealCell(row, column);

      setEditingCell({ row, column });
      setEditingValue(initialValue);
      setInitialKey(key && key.length === 1 ? key : undefined);

      // Update formula bar to match
      setFormulaValue(initialValue);

      // Announce edit mode to screen readers
      announce(`Editing cell ${cellAddress}`);
    },
    [sheet.cells, isReadOnly, readOnlyReason, announce, revealCell]
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
        toast.error(readOnlyReason);
        return;
      }
      setFormulaValue(value);
      applySheetUpdate((previous) => applyCellWrite(previous, currentAddress, value));
    },
    [applySheetUpdate, currentAddress, isReadOnly, readOnlyReason]
  );

  const handleAddRow = useCallback(() => {
    if (isReadOnly) {
      toast.error(readOnlyReason);
      return;
    }
    applySheetUpdate(addRow);
  }, [applySheetUpdate, isReadOnly, readOnlyReason]);

  const handleAddColumn = useCallback(() => {
    if (isReadOnly) {
      toast.error(readOnlyReason);
      return;
    }
    applySheetUpdate(addColumn);
  }, [applySheetUpdate, isReadOnly, readOnlyReason]);

  // Undo handler
  const handleUndo = useCallback(() => {
    if (isReadOnly || !canUndo) return;

    const previousState = undo();
    if (previousState && persistSheet(previousState)) {
      toast.success('Undo', { duration: 1500 });
      announce('Undo performed');
    }
  }, [isReadOnly, canUndo, undo, persistSheet, announce]);

  // Redo handler
  const handleRedo = useCallback(() => {
    if (isReadOnly || !canRedo) return;

    const nextState = redo();
    if (nextState && persistSheet(nextState)) {
      toast.success('Redo', { duration: 1500 });
      announce('Redo performed');
    }
  }, [isReadOnly, canRedo, redo, persistSheet, announce]);

  const handleCellMouseDown = useCallback(
    (row: number, column: number, event: React.MouseEvent) => {
      // Selection is not a mutation: a view-only user still needs to select a
      // range to read it, copy it, and see the sum/average footer. Editing is
      // gated at each write site instead.
      event.preventDefault();
      const cell = clampSelection({ row, column }, sheet);

      setIsDragging(true);
      setDragStart(cell);
      setSelection({
        type: 'single',
        cell
      });
      setIsFormulaFocused(false);

      // Exit editing mode if selecting a different cell
      if (editingCell && (editingCell.row !== cell.row || editingCell.column !== cell.column)) {
        setEditingCell(null);
        setEditingValue('');
          setInitialKey(undefined);
      }

      requestAnimationFrame(() => {
        gridRef.current?.focus({ preventScroll: true });
      });
    },
    [sheet, editingCell]
  );

  const handleCellRightClick = useCallback(
    (row: number, column: number) => {
      // Right-clicking inside an existing range acts on that range; right-
      // clicking outside it moves the selection first. The menu itself is
      // positioned by the shared primitive, so nothing here touches the DOM.
      if (!isCellInSelection(row, column, selection)) {
        setSelection({ type: 'single', cell: clampSelection({ row, column }, sheet) });
      }
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
        const { data: copyData, cellCount } = buildCopyPayload(selection, sheet, displayAt, mode);

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
    [editingCell, selection, sheet, displayAt]
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

  // ---- Formatting -------------------------------------------------------

  const currentFormat = useMemo(() => activeFormat(sheet, selection), [sheet, selection]);

  const runFormatCommand = useCallback(
    (command: FormatCommand) => {
      if (isReadOnly) {
        toast.error(readOnlyReason);
        return;
      }
      applySheetUpdate((previous) => applyFormatCommand(previous, selection, command));
    },
    [applySheetUpdate, isReadOnly, readOnlyReason, selection]
  );

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

      // Modifier combinations dispatch explicitly. The old surface returned
      // early on every Ctrl/Cmd chord except F2, which meant no formatting
      // shortcut could ever be added without this branch swallowing it first.
      if (ctrlKey || metaKey) {
        if (key === 'F2') {
          // fall through to the editing/navigation handling below
        } else {
          const command = FORMAT_SHORTCUTS[key.toLowerCase()];
          if (command) {
            event.preventDefault();
            runFormatCommand(command);
          }
          // Everything else (Ctrl+S/Z/Y, browser chords) is handled elsewhere
          // or belongs to the browser.
          return;
        }
      }

      // Handle Delete and Backspace as instant delete actions
      if (key === 'Delete' || key === 'Backspace') {
        if (isReadOnly) {
          toast.error(readOnlyReason);
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
      // Native focus-scrolling no longer applies: the target cell may not be
      // rendered yet, so the grid has to scroll to it deliberately.
      revealCell(next.row, next.column);
    },
    [isReadOnly, readOnlyReason, selection, sheet, editingCell, startCellEdit, handleCopy, applySheetUpdate, setFormulaValue, announce, runFormatCommand, revealCell]
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


  /**
   * Where the floating editor sits, computed from the axes and the measured
   * viewport rather than read off a DOM node.
   *
   * The old surface measured the cell element and cancelled the edit whenever
   * the lookup failed — which is exactly what happens once the cell scrolls out
   * of a virtualized window. Deriving the rect means scrolling away from a cell
   * you are editing no longer throws the edit away.
   */
  const editingCellRect = useMemo(() => {
    if (!editingCell) return null;
    return cellViewportRect({
      rowAxis,
      columnAxis,
      row: editingCell.row,
      column: editingCell.column,
      frozenRows: sheet.frozenRows,
      frozenColumns: sheet.frozenColumns,
      view: viewport,
    });
  }, [editingCell, rowAxis, columnAxis, sheet.frozenRows, sheet.frozenColumns, viewport]);

  /**
   * Whether the edited cell is still within the scrolled body.
   *
   * The overlay is hidden when it is not — otherwise the editor floats over the
   * toolbar and the rest of the page. Crucially this hides the overlay only:
   * `editingCell` and `editingValue` are untouched, so scrolling back brings
   * the editor and the typed text straight back. That is the distinction the
   * old surface got wrong, where "not visible" meant "discard the edit".
   */
  const isEditingCellVisible = useMemo(() => {
    if (!editingCell) return false;
    return isCellVisible({
      rowAxis,
      columnAxis,
      row: editingCell.row,
      column: editingCell.column,
      frozenRows: sheet.frozenRows,
      frozenColumns: sheet.frozenColumns,
      view: viewport,
    });
  }, [editingCell, rowAxis, columnAxis, sheet.frozenRows, sheet.frozenColumns, viewport]);

  // Keep the active cell in view when the selection moves. Guarded on the
  // address so this reacts to navigation only: re-running it on every scroll
  // would drag the viewport back and make the sheet impossible to scroll away
  // from the selection.
  const lastRevealedRef = useRef<string | null>(null);
  useEffect(() => {
    if (lastRevealedRef.current === currentAddress) return;
    lastRevealedRef.current = currentAddress;
    revealCell(currentSelection.row, currentSelection.column);
  }, [currentAddress, currentSelection.row, currentSelection.column, revealCell]);

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
  // Ctrl+S must not write when the document failed to load: there is nothing
  // legitimate to save, and the write would only bump the revision.
  const handleSaveShortcut = useCallback(() => {
    if (isReadOnly) return;
    forceSaveNow();
  }, [isReadOnly, forceSaveNow]);

  useSheetKeyboardShortcuts({ onSave: handleSaveShortcut, onUndo: handleUndo, onRedo: handleRedo });

  // ---- Freeze panes ------------------------------------------------------

  const handleFreezeRows = useCallback(
    (rows: number) => {
      if (isReadOnly) {
        toast.error(readOnlyReason);
        return;
      }
      applySheetUpdate((previous) => setFrozen(previous, rows, previous.frozenColumns));
    },
    [applySheetUpdate, isReadOnly, readOnlyReason]
  );

  const handleFreezeColumns = useCallback(
    (columns: number) => {
      if (isReadOnly) {
        toast.error(readOnlyReason);
        return;
      }
      applySheetUpdate((previous) => setFrozen(previous, previous.frozenRows, columns));
    },
    [applySheetUpdate, isReadOnly, readOnlyReason]
  );

  // ---- Header interaction ------------------------------------------------

  const handleSelectColumn = useCallback(
    (column: number, event: React.MouseEvent) => {
      event.preventDefault();
      const lastRow = Math.max(0, sheet.rowCount - 1);
      setSelection((previous) => {
        // Shift-click extends from the existing anchor, matching the grid's own
        // range behaviour rather than inventing a second convention.
        const anchorColumn = event.shiftKey ? getPrimaryCell(previous).column : column;
        return {
          type: 'range',
          range: {
            start: { row: 0, column: anchorColumn },
            end: { row: lastRow, column },
          },
        };
      });
      gridRef.current?.focus({ preventScroll: true });
    },
    [sheet.rowCount]
  );

  const handleSelectRow = useCallback(
    (row: number, event: React.MouseEvent) => {
      event.preventDefault();
      const lastColumn = Math.max(0, sheet.columnCount - 1);
      setSelection((previous) => {
        const anchorRow = event.shiftKey ? getPrimaryCell(previous).row : row;
        return {
          type: 'range',
          range: {
            start: { row: anchorRow, column: 0 },
            end: { row, column: lastColumn },
          },
        };
      });
      gridRef.current?.focus({ preventScroll: true });
    },
    [sheet.columnCount]
  );

  const handleResizeColumn = useCallback(
    (column: number, width: number) => {
      if (isReadOnly) return;
      applySheetUpdate((previous) => setColumnWidth(previous, column, width));
    },
    [applySheetUpdate, isReadOnly]
  );

  const handleResizeRow = useCallback(
    (row: number, height: number) => {
      if (isReadOnly) return;
      applySheetUpdate((previous) => setRowHeight(previous, row, height));
    },
    [applySheetUpdate, isReadOnly]
  );

  const handlePreviewColumnWidth = useCallback((column: number, width: number | null) => {
    setColumnResize(width === null ? undefined : { index: column, size: width });
  }, []);

  const handlePreviewRowHeight = useCallback((row: number, height: number | null) => {
    setRowResize(height === null ? undefined : { index: row, size: height });
  }, []);

  /**
   * Double-clicking a column edge sizes it to its widest value.
   *
   * Width is estimated from character count rather than measured: measuring
   * would mean laying out every cell in the column, including the ones
   * virtualization deliberately never rendered.
   */
  const handleAutoFitColumn = useCallback(
    (column: number) => {
      if (isReadOnly) return;

      let widest = 0;
      for (let row = 0; row < sheet.rowCount; row++) {
        const cell = evaluation.byAddress[encodeCellAddress(row, column)];
        const text = cell?.error ? '#ERROR' : cell?.display ?? '';
        if (text.length > widest) widest = text.length;
      }

      // ~7px per character at 14px, plus the cell's horizontal padding.
      applySheetUpdate((previous) => setColumnWidth(previous, column, widest * 7 + 20));
    },
    [applySheetUpdate, evaluation.byAddress, isReadOnly, sheet.rowCount]
  );

  const handleClearContents = useCallback(() => {
    if (isReadOnly) {
      toast.error(readOnlyReason);
      return;
    }
    const addresses = selectionAddresses(selection);
    applySheetUpdate((previous) =>
      addresses.reduce((sheetSoFar, address) => applyCellDelete(sheetSoFar, address), previous)
    );
    setFormulaValue('');
  }, [applySheetUpdate, isReadOnly, readOnlyReason, selection]);

  /**
   * One stable object for every per-cell handler. Passing these individually
   * would change a cell's props on every render of the view and defeat the
   * memo, which is the usual reason a virtualized grid is still slow.
   */
  const cellHandlers = useMemo<SheetCellHandlers>(
    () => ({
      onMouseDown: handleCellMouseDown,
      onMouseEnter: handleCellMouseEnter,
      onDoubleClick: (row: number, column: number) => {
        if (!isReadOnly) startCellEdit(row, column);
      },
      onContextMenu: handleCellRightClick,
      onTouchStart: handleCellTouchStart,
      onTouchMove: handleCellTouchMove,
      onTouchEnd: handleCellTouchEnd,
    }),
    [
      handleCellMouseDown,
      handleCellMouseEnter,
      handleCellRightClick,
      handleCellTouchEnd,
      handleCellTouchMove,
      handleCellTouchStart,
      isReadOnly,
      startCellEdit,
    ]
  );

  return (
    <div className="flex h-full flex-col">
      <DocumentConflictGate
        conflict={conflict}
        onResolve={resolveConflict}
        isResolving={isResolvingConflict}
        previewMode="plain"
      />
      {loadError && (
        <div
          role="alert"
          className="border-b border-destructive/30 bg-destructive/10 px-4 py-2 text-sm text-destructive"
        >
          This sheet could not be loaded, so editing is disabled to protect your data. Reload the
          page to try again; if it keeps failing, the stored content needs repair.
        </div>
      )}
      <motion.div
        initial={{ y: -10, opacity: 0 }}
        animate={{ y: 0, opacity: 1 }}
        transition={{ duration: 0.2 }}
        className="sticky top-0 z-10 mx-4 mt-4 overflow-hidden rounded-lg liquid-glass-thin border border-[var(--separator)] shadow-[var(--shadow-ambient)]"
      >
        <SheetToolbar
          format={currentFormat}
          disabled={isReadOnly}
          canUndo={canUndo}
          canRedo={canRedo}
          frozenRows={sheet.frozenRows ?? 0}
          frozenColumns={sheet.frozenColumns ?? 0}
          onCommand={runFormatCommand}
          onUndo={handleUndo}
          onRedo={handleRedo}
          onFreezeRows={handleFreezeRows}
          onFreezeColumns={handleFreezeColumns}
        />
      </motion.div>
      <SheetFormulaBar
        isRange={selection.type === 'range'}
        selectionAddress={selectionAddress}
        currentDisplay={currentDisplay}
        currentError={currentError}
        isReadOnly={isReadOnly}
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
        className="min-h-0 flex-1"
      >
        {/* The grid sits in a rounded, hairline-bordered shell so the surface
            reads as a panel in the product rather than a full-bleed mesh of
            borders. `overflow-hidden` keeps the cells square inside the radius. */}
        <div className="h-full px-4 pb-2">
          <ContextMenu>
            <ContextMenuTrigger asChild>
              <div className="h-full overflow-hidden rounded-lg border border-[var(--separator)] bg-background">
                <SheetGrid
              gridRef={gridRef}
              scrollRef={scrollContainerRef}
              sheet={sheet}
              rowAxis={rowAxis}
              columnAxis={columnAxis}
              viewport={viewport}
              selection={selection}
              currentSelection={currentSelection}
              currentAddress={currentAddress}
              evaluation={evaluation}
              editingCell={editingCell}
              isReadOnly={isReadOnly}
              findAddressSet={findAddressSet}
              currentFindAddress={currentFindAddress}
              onKeyDown={handleGridKeyDown}
              onSelectColumn={handleSelectColumn}
              onSelectRow={handleSelectRow}
              onResizeColumn={handleResizeColumn}
              onResizeRow={handleResizeRow}
              onPreviewColumnWidth={handlePreviewColumnWidth}
              onPreviewRowHeight={handlePreviewRowHeight}
              onAutoFitColumn={handleAutoFitColumn}
                  handlers={cellHandlers}
                />
              </div>
            </ContextMenuTrigger>
            <SheetContextMenu
              canPaste={!!copiedData || canUseClipboard}
              isReadOnly={isReadOnly}
              onCopy={handleCopy}
              onPaste={handlePaste}
              onClearContents={handleClearContents}
              onClearFormatting={() => runFormatCommand({ kind: 'clear' })}
            />
          </ContextMenu>
        </div>
      </PullToRefresh>

      {/* Floating Cell Editor */}
      <FloatingCellEditor
        value={editingValue}
        cellRect={editingCellRect}
        isVisible={!!editingCell && isEditingCellVisible}
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

      <SheetTabBar
        activeName={sheet.sheetName ?? 'Sheet1'}
        otherNames={(sheet.extraSheets ?? []).map((tab) => tab.name)}
      />

      {/* Quick Stats Footer */}
      <SheetStatusBar
        selectionAddress={selectionAddress}
        selection={selection}
        stats={selectionStats}
        density={density}
        onDensityChange={setDensity}
      />
    </div>
  );
};

const SheetView: React.FC<SheetViewProps> = (props) => (
  <SuggestionProvider>
    <SheetViewComponent {...props} />
  </SuggestionProvider>
);

export default SheetView;
