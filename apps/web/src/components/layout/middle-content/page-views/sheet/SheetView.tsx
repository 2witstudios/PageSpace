"use client";

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { TreePage, usePageTree } from '@/hooks/usePageTree';
import { useDocument } from '@/hooks/useDocument';
import { useSocket } from '@/hooks/useSocket';
import { useAuth } from '@/hooks/use-auth';
import { PageEventPayload } from '@/lib/socket-utils';
import { toast } from 'sonner';
import {
  SheetData,
  SheetExternalReferenceToken,
  collectExternalReferences,
  encodeCellAddress,
  evaluateSheet,
  PageType,
  parseSheetContent,
  sanitizeSheetData,
  serializeSheetContent,
} from '@pagespace/lib';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { FloatingCellEditor } from './FloatingCellEditor';
import { useSuggestion } from '@/hooks/useSuggestion';
import { SuggestionProvider, useSuggestionContext } from '@/components/providers/SuggestionProvider';
import SuggestionPopup from '@/components/mentions/SuggestionPopup';

interface SheetViewProps {
  page: TreePage;
}

type GridSelection = {
  row: number;
  column: number;
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

const getColumnLabel = (columnIndex: number) => encodeCellAddress(0, columnIndex).replace(/\d+/g, '');

// Utility function to check if a key should trigger direct cell editing
const isPrintableKey = (key: string): boolean => {
  // Single printable characters (letters, numbers, symbols)
  if (key.length === 1 && key.match(/[\x20-\x7E]/)) {
    return true;
  }
  // Special cases that should start editing
  return key === 'F2' || key === 'Delete' || key === 'Backspace';
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
  const [sheet, setSheet] = useState<SheetData>(initialSheet);
  const [selectedCell, setSelectedCell] = useState<GridSelection>({ row: 0, column: 0 });
  const [formulaValue, setFormulaValue] = useState('');
  const [isFormulaFocused, setIsFormulaFocused] = useState(false);
  const [isReadOnly, setIsReadOnly] = useState(false);

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
  } = useDocument(page.id, page.content);

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

      fetch(`/api/pages/${target.pageId}`)
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
  const currentSelection = clampSelection(selectedCell, sheet);
  const currentAddress = encodeCellAddress(currentSelection.row, currentSelection.column);
  const currentCell = evaluation.byAddress[currentAddress];
  const currentError = currentCell?.error;
  const currentDisplay = currentCell?.error ? '#ERROR' : currentCell?.display ?? '';
  const currentRaw = sheet.cells[currentAddress] ?? '';

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
    [saveWithDebounce, updateContent]
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
      if (key === 'Delete' || key === 'Backspace') {
        initialValue = '';
      } else if (key === 'F2') {
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

  const handleCellSelect = useCallback(
    (row: number, column: number) => {
      const next = clampSelection({ row, column }, sheet);
      setSelectedCell(next);
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

  const handleGridKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      if (!selectedCell) return;
      const { key, shiftKey, ctrlKey, metaKey } = event;
      let { row, column } = clampSelection(selectedCell, sheet);

      // Don't interfere if we're already editing
      if (editingCell) return;

      // Don't trigger editing for modifier key combinations (except F2)
      if ((ctrlKey || metaKey) && key !== 'F2') {
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

      setSelectedCell({ row, column });
    },
    [isReadOnly, selectedCell, sheet, editingCell, startCellEdit]
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
    setSheet(sanitizeSheetData(parseSheetContent(page.content)));
  }, [page.content, page.id]);

  useEffect(() => {
    setSelectedCell({ row: 0, column: 0 });
  }, [page.id]);

  // Update sheet when document content updates
  useEffect(() => {
    if (documentState) {
      setSheet(sanitizeSheetData(parseSheetContent(documentState.content)));
    }
  }, [documentState]);

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
    const gridElement = gridRef.current;
    const handleScroll = () => updateCellRect();
    const handleResize = () => updateCellRect();

    if (gridElement) {
      gridElement.addEventListener('scroll', handleScroll, { passive: true });
    }
    window.addEventListener('resize', handleResize, { passive: true });

    return () => {
      if (gridElement) {
        gridElement.removeEventListener('scroll', handleScroll);
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
    setSelectedCell((prev) => ({
      row: Math.min(Math.max(prev.row, 0), Math.max(0, sheet.rowCount - 1)),
      column: Math.min(Math.max(prev.column, 0), Math.max(0, sheet.columnCount - 1)),
    }));
  }, [sheet.columnCount, sheet.rowCount]);

  // Permission check
  useEffect(() => {
    const checkPermissions = async () => {
      if (!user?.id) return;
      try {
        const response = await fetch(`/api/pages/${page.id}/permissions/check?userId=${user.id}`);
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
        const response = await fetch(`/api/pages/${page.id}`);
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

  // Save on unmount if dirty
  useEffect(() => {
    return () => {
      if (documentState?.isDirty) {
        forceSave().catch(console.error);
      }
    };
  }, [documentState?.isDirty, forceSave]);

  // Save on window blur
  useEffect(() => {
    if (typeof window === 'undefined' || !window.addEventListener) return;
    const handleBlur = () => {
      if (documentState?.isDirty) {
        forceSave().catch(console.error);
      }
    };
    window.addEventListener('blur', handleBlur);
    return () => {
      window.removeEventListener('blur', handleBlur);
    };
  }, [documentState?.isDirty, forceSave]);

  // Ctrl/Cmd + S shortcut
  useEffect(() => {
    if (typeof document === 'undefined' || !document.addEventListener) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key === 's') {
        event.preventDefault();
        forceSave().catch(console.error);
      }
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [forceSave]);

  return (
    <div className="flex h-full flex-col">
      <div className="border-b bg-muted/40">
        <div className="grid grid-cols-[80px_1fr_auto] items-center gap-2 px-4 pt-3 pb-1">
          <span className="text-xs font-medium uppercase text-muted-foreground">Cell</span>
          <div className="font-semibold">{currentAddress}</div>
          <div className="text-xs text-muted-foreground">Value: {currentDisplay || '—'}</div>
        </div>
        <div className="grid grid-cols-[80px_1fr_auto] items-center gap-2 px-4 pb-3">
          <span className="text-xs font-medium uppercase text-muted-foreground">Formula</span>
          <div className="relative">
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
                'w-full rounded border border-input bg-background px-2 py-1 text-sm focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/20',
                isReadOnly && 'cursor-not-allowed opacity-75'
              )}
              placeholder="Enter a value or formula (e.g. =SUM(A1:A5))"
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
          <div className="flex items-center gap-2">
            <Button variant="outline" size="sm" onClick={handleAddColumn} disabled={isReadOnly}>
              + Column
            </Button>
            <Button variant="outline" size="sm" onClick={handleAddRow} disabled={isReadOnly}>
              + Row
            </Button>
          </div>
        </div>
        {currentError && (
          <div className="px-4 pb-3 text-xs text-destructive">Error: {currentError}</div>
        )}
      </div>
      <div
        ref={gridRef}
        role="grid"
        aria-label="Spreadsheet"
        aria-rowcount={sheet.rowCount}
        aria-colcount={sheet.columnCount}
        aria-activedescendant={`cell-${currentAddress}`}
        tabIndex={0}
        onKeyDown={handleGridKeyDown}
        className="flex-1 overflow-auto focus:outline-none"
      >
        <table className="min-w-max border-collapse text-sm" role="presentation">
          <thead>
            <tr role="row">
              <th
                role="columnheader"
                className="sticky left-0 top-0 z-20 h-8 w-14 border border-border bg-muted text-left text-xs font-semibold text-muted-foreground"
                aria-label="Row headers"
              ></th>
              {Array.from({ length: sheet.columnCount }).map((_, columnIndex) => (
                <th
                  key={`column-${columnIndex}`}
                  role="columnheader"
                  aria-colindex={columnIndex + 1}
                  className="sticky top-0 z-10 h-8 min-w-[120px] border border-border bg-muted px-3 text-left text-xs font-semibold text-muted-foreground"
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
                  className="sticky left-0 z-10 h-10 border border-border bg-muted px-2 text-left text-xs font-semibold text-muted-foreground"
                >
                  {rowIndex + 1}
                </th>
                {Array.from({ length: sheet.columnCount }).map((_, columnIndex) => {
                  const cellAddress = encodeCellAddress(rowIndex, columnIndex);
                  const isSelected = currentSelection.row === rowIndex && currentSelection.column === columnIndex;
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
                      tabIndex={isSelected ? 0 : -1}
                      className={cn(
                        'h-10 min-w-[120px] cursor-pointer border border-border bg-background px-3 align-middle',
                        'transition-colors hover:bg-muted/40 focus:outline-none focus:ring-2 focus:ring-primary focus:ring-inset',
                        isSelected && 'bg-primary/10 outline outline-2 outline-offset-[-2px] outline-primary',
                        cellError && 'bg-destructive/10 text-destructive',
                        editingCell && editingCell.row === rowIndex && editingCell.column === columnIndex && 'opacity-50'
                      )}
                      onClick={() => handleCellSelect(rowIndex, columnIndex)}
                      onDoubleClick={() => {
                        if (!isReadOnly) {
                          startCellEdit(rowIndex, columnIndex);
                        }
                      }}
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
    </div>
  );
};

const SheetView: React.FC<SheetViewProps> = (props) => (
  <SuggestionProvider>
    <SheetViewComponent {...props} />
  </SuggestionProvider>
);

export default SheetView;
