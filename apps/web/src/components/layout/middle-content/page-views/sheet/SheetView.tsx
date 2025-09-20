"use client";

import React, { useEffect, useState, useCallback, useRef, useMemo } from 'react';
import { TreePage } from '@/hooks/usePageTree';
import { useDocument } from '@/hooks/useDocument';
import { motion } from 'motion/react';
import { useSocket } from '@/hooks/useSocket';
import { PageEventPayload } from '@/lib/socket-utils';
import { toast } from 'sonner';
import { useAuth } from '@/hooks/use-auth';
import SheetErrorBoundary from './SheetErrorBoundary';
import NativeSheetView from './NativeSheetView';
import FormulaBar from './FormulaBar';
import { FormulaEngine } from '@pagespace/lib/formula-engine';

interface SheetViewProps {
  page: TreePage;
}

export interface SheetData {
  type: 'sheet';
  data: string[][];
  metadata: {
    rows: number;
    cols: number;
    headers: boolean;
    frozenRows: number;
  };
  formulas?: { [cellRef: string]: string }; // e.g., "A1": "=SUM(B1:B5)"
  computedValues?: { [cellRef: string]: string | number }; // cached calculated values
  version: number;
}


const SheetView = ({ page }: SheetViewProps) => {
  const [isReadOnly, setIsReadOnly] = useState(false);
  const [selectedCell, setSelectedCell] = useState<{ row: number; col: number } | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const socket = useSocket();
  const { user } = useAuth();

  // Formula engine instance
  const formulaEngineRef = useRef<FormulaEngine | null>(null);

  // Initialize formula engine
  useEffect(() => {
    if (!formulaEngineRef.current) {
      formulaEngineRef.current = new FormulaEngine();
      console.log('✓ Formula engine initialized');
    }
  }, []);

  // Use the document hook with sheet data
  const {
    document: documentState,
    initializeAndActivate,
    updateContent,
    updateContentFromServer,
    saveWithDebounce,
    forceSave,
  } = useDocument(page.id, page.content);

  // Parse sheet data from document content
  const sheetData = useMemo<SheetData>(() => {
    try {
      if (typeof documentState?.content === 'string') {
        const parsed = JSON.parse(documentState.content);
        // Convert legacy spreadsheet type to sheet
        if (parsed.type === 'spreadsheet') {
          parsed.type = 'sheet';
        }
        // Ensure formulas and computedValues are initialized
        if (!parsed.formulas) parsed.formulas = {};
        if (!parsed.computedValues) parsed.computedValues = {};
        return parsed;
      }
      return documentState?.content || {
        type: 'sheet',
        data: [
          ['', '', '', '', '', '', '', '', '', ''],
          ['', '', '', '', '', '', '', '', '', ''],
          ['', '', '', '', '', '', '', '', '', ''],
          ['', '', '', '', '', '', '', '', '', ''],
          ['', '', '', '', '', '', '', '', '', '']
        ],
        metadata: {
          rows: 5,
          cols: 10,
          headers: false,
          frozenRows: 0
        },
        formulas: {},
        computedValues: {},
        version: 1
      };
    } catch (error) {
      console.error('Failed to parse sheet data:', error);
      return {
        type: 'sheet',
        data: [
          ['', '', '', '', '', '', '', '', '', ''],
          ['', '', '', '', '', '', '', '', '', ''],
          ['', '', '', '', '', '', '', '', '', ''],
          ['', '', '', '', '', '', '', '', '', ''],
          ['', '', '', '', '', '', '', '', '', '']
        ],
        metadata: {
          rows: 5,
          cols: 10,
          headers: false,
          frozenRows: 0
        },
        formulas: {},
        computedValues: {},
        version: 1
      };
    }
  }, [documentState?.content]);

  // Initialize formula engine with existing data when sheet data changes
  useEffect(() => {
    if (!formulaEngineRef.current || !sheetData) return;

    try {
      console.log('🔄 Initializing formula engine with sheet data...');

      // Clear the engine first
      formulaEngineRef.current.clear();

      // Load regular cell data first (non-formula cells)
      const nonFormulaData = sheetData.data.map((row, rowIndex) =>
        row.map((cell, colIndex) => {
          const cellRef = `${String.fromCharCode(65 + colIndex)}${rowIndex + 1}`;
          // If this cell has a formula, load empty for now
          return sheetData.formulas?.[cellRef] ? '' : cell;
        })
      );

      formulaEngineRef.current.loadData(nonFormulaData);
      console.log('✓ Loaded non-formula cell data');

      // Then set formulas if they exist
      if (sheetData.formulas) {
        console.log(`📊 Setting ${Object.keys(sheetData.formulas).length} formulas...`);
        Object.entries(sheetData.formulas).forEach(([cellRef, formula]) => {
          try {
            const result = formulaEngineRef.current?.setCellContent(cellRef, formula);
            console.log(`✓ Formula ${cellRef}: ${formula} = ${result?.value}`);
          } catch (error) {
            console.error(`❌ Error setting formula for ${cellRef} (${formula}):`, error);
          }
        });
      }

      console.log('✅ Formula engine initialization complete');
    } catch (error) {
      console.error('❌ Error initializing formula engine:', error);
    }
  }, [sheetData]);


  // Initialize document when component mounts
  useEffect(() => {
    initializeAndActivate();
  }, [initializeAndActivate]);

  // Check user permissions
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
              position: 'bottom-right'
            });
          }
        }
      } catch (error) {
        console.error('Failed to check permissions:', error);
      }
    };

    checkPermissions();
  }, [user?.id, page.id]);

  // Listen for content updates from other sources (AI, other users)
  useEffect(() => {
    if (!socket) return;

    const handleContentUpdate = async (eventData: PageEventPayload) => {
      // Only update if it's for the current page
      if (eventData.pageId === page.id) {
        // Sheet content updated via socket, fetching latest

        try {
          // Fetch the latest content from the server
          const response = await fetch(`/api/pages/${page.id}`);
          if (response.ok) {
            const updatedPage = await response.json();

            // Only update if content actually changed and we're not currently editing
            if (updatedPage.content !== documentState?.content && !documentState?.isDirty) {
              updateContentFromServer(updatedPage.content);
            }
          }
        } catch (error) {
          console.error('Failed to fetch updated content:', error);
        }
      }
    };

    // Listen for content update events
    socket.on('page:content-updated', handleContentUpdate);

    return () => {
      socket.off('page:content-updated', handleContentUpdate);
    };
  }, [socket, page.id, documentState, updateContentFromServer]);

  // Handle cell value changes
  const handleCellChange = useCallback((row: number, col: number, value: string) => {
    if (isReadOnly) {
      toast.error('You do not have permission to edit this sheet');
      return;
    }

    const cellRef = `${String.fromCharCode(65 + col)}${row + 1}`; // Convert to A1 notation
    const isFormula = value.startsWith('=');

    console.log(`📝 Cell change: ${cellRef} = "${value}" (isFormula: ${isFormula})`);

    // Update the data array
    const newData = [...sheetData.data];

    // Ensure row exists
    while (newData.length <= row) {
      newData.push(new Array(sheetData.metadata.cols).fill(''));
    }

    // Ensure column exists
    while (newData[row].length <= col) {
      newData[row].push('');
    }

    // Initialize formulas and computedValues if not present
    const newFormulas = { ...(sheetData.formulas || {}) };
    const newComputedValues = { ...(sheetData.computedValues || {}) };

    let displayValue = value;

    if (isFormula && formulaEngineRef.current) {
      // It's a formula - store the formula and calculate the result
      newFormulas[cellRef] = value;

      try {
        // Set the formula in the engine
        const result = formulaEngineRef.current.setCellContent(cellRef, value);
        console.log(`🧮 Formula result for ${cellRef}:`, result);

        if (result.error) {
          displayValue = `#ERROR: ${result.error}`;
          newComputedValues[cellRef] = displayValue;
          console.log(`❌ Formula error in ${cellRef}: ${result.error}`);
        } else {
          // Use the calculated value from the formula engine
          displayValue = String(result.value ?? '');
          newComputedValues[cellRef] = result.value ?? '';
          console.log(`✅ Formula ${cellRef} calculated: ${displayValue}`);
        }
      } catch (error) {
        displayValue = '#ERROR!';
        newComputedValues[cellRef] = displayValue;
        console.error(`❌ Formula calculation error for ${cellRef}:`, error);
      }
    } else {
      // Regular value - remove any existing formula
      delete newFormulas[cellRef];
      delete newComputedValues[cellRef];

      // Also update the formula engine with the raw value
      if (formulaEngineRef.current) {
        try {
          const result = formulaEngineRef.current.setCellContent(cellRef, value);
          console.log(`📊 Raw value set for ${cellRef}:`, result);
        } catch (error) {
          console.error(`❌ Error setting raw value for ${cellRef}:`, error);
        }
      }
    }

    // Update the cell with the display value
    newData[row][col] = displayValue;

    // Also get updated computed values from any dependent cells that might have changed
    if (formulaEngineRef.current) {
      try {
        // Get all dependents of this cell
        const dependents = formulaEngineRef.current.getDependents(cellRef);
        console.log(`🔗 Updating ${dependents.length} dependent cells: ${dependents.join(', ')}`);

        dependents.forEach(dependentRef => {
          const dependentResult = formulaEngineRef.current!.getCellValue(dependentRef);
          const dependentFormula = formulaEngineRef.current!.getCellFormula(dependentRef);

          if (dependentFormula) {
            // This is a formula cell that needs updating
            const dependentCoords = formulaEngineRef.current!.parseA1Notation(dependentRef);
            const dependentDisplayValue = String(dependentResult.value ?? '');

            // Ensure the dependent cell's row/col exists in newData
            while (newData.length <= dependentCoords.row) {
              newData.push(new Array(sheetData.metadata.cols).fill(''));
            }
            while (newData[dependentCoords.row].length <= dependentCoords.col) {
              newData[dependentCoords.row].push('');
            }

            // Update the display value for the dependent cell
            newData[dependentCoords.row][dependentCoords.col] = dependentDisplayValue;
            newComputedValues[dependentRef] = dependentResult.value ?? '';

            console.log(`🔄 Updated dependent ${dependentRef}: ${dependentDisplayValue}`);
          }
        });
      } catch (error) {
        console.error('❌ Error updating dependent cells:', error);
      }
    }

    // Create updated sheet data
    const updatedSheetData: SheetData = {
      ...sheetData,
      data: newData,
      formulas: newFormulas,
      computedValues: newComputedValues,
      metadata: {
        ...sheetData.metadata,
        rows: Math.max(sheetData.metadata.rows, newData.length),
        cols: Math.max(sheetData.metadata.cols, Math.max(...newData.map(row => row.length)))
      }
    };

    const newContent = JSON.stringify(updatedSheetData);

    console.log(`💾 Saving updated sheet data for ${cellRef}`);

    // Update document state immediately (optimistic update)
    updateContent(newContent);

    // Trigger debounced save
    saveWithDebounce(newContent);

    // Broadcast cell update via socket
    if (socket) {
      socket.emit('page-operation', {
        pageId: page.id,
        operation: 'content-updated',
        data: {
          cellRange: cellRef,
          value: value,
          isFormula: isFormula,
          displayValue: displayValue
        }
      });
    }
  }, [sheetData, updateContent, saveWithDebounce, isReadOnly, socket, page.id]);

  // Handle cell selection
  const handleCellSelect = useCallback((row: number, col: number) => {
    setSelectedCell({ row, col });
  }, []);

  // Handle formula bar changes
  const handleFormulaChange = useCallback((value: string) => {
    if (selectedCell) {
      handleCellChange(selectedCell.row, selectedCell.col, value);
    }
  }, [selectedCell, handleCellChange]);

  // Get current cell value and formula for formula bar
  const selectedCellData = useMemo(() => {
    if (!selectedCell) return { value: '', formula: undefined };

    const cellRef = `${String.fromCharCode(65 + selectedCell.col)}${selectedCell.row + 1}`;
    const formula = sheetData.formulas?.[cellRef];
    const value = sheetData.data[selectedCell.row]?.[selectedCell.col] || '';

    return { value, formula };
  }, [selectedCell, sheetData]);

  // Cleanup on unmount - auto-save any unsaved changes and destroy formula engine
  useEffect(() => {
    return () => {
      // Force save if dirty before unmounting
      if (documentState?.isDirty) {
        // Component unmounting with unsaved changes, force saving
        // Fire-and-forget save since we can't await in cleanup
        fetch(`/api/pages/${page.id}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ content: documentState.content }),
        }).catch(error => {
          console.error('Failed to save on unmount:', error);
        });
      }

      // Cleanup formula engine
      if (formulaEngineRef.current) {
        formulaEngineRef.current.destroy();
        formulaEngineRef.current = null;
      }
    };
  }, [documentState, page.id]);

  // Handle keyboard shortcuts
  useEffect(() => {
    // Only run on client side with proper document API
    if (typeof document === 'undefined' || !document.addEventListener) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      // Ctrl+S / Cmd+S to save
      if ((e.ctrlKey || e.metaKey) && e.key === 's') {
        e.preventDefault();
        forceSave();
      }
    };

    document.addEventListener('keydown', handleKeyDown);
    return () => {
      if (typeof document !== 'undefined' && document.removeEventListener) {
        document.removeEventListener('keydown', handleKeyDown);
      }
    };
  }, [forceSave, documentState]);

  // Auto-save on window blur
  useEffect(() => {
    // Only run on client side with proper window API
    if (typeof window === 'undefined' || !window.addEventListener) return;

    const handleBlur = () => {
      if (documentState?.isDirty) {
        // Window blur detected, auto-saving
        forceSave().catch(console.error);
      }
    };

    window.addEventListener('blur', handleBlur);
    return () => {
      if (typeof window !== 'undefined' && window.removeEventListener) {
        window.removeEventListener('blur', handleBlur);
      }
    };
  }, [documentState, forceSave]);

  return (
    <SheetErrorBoundary>
      <motion.div
        initial={{ opacity: 0, y: 10 }}
        animate={{ opacity: 1, y: 0 }}
        exit={{ opacity: 0, y: -10 }}
        transition={{ duration: 0.2 }}
        ref={containerRef}
        className="h-full flex flex-col relative"
      >
      {/* Read-only indicator */}
      {isReadOnly && (
        <div className="bg-yellow-50 dark:bg-yellow-900/20 border-b border-yellow-200 dark:border-yellow-800 px-4 py-2">
          <p className="text-sm text-yellow-800 dark:text-yellow-200 text-center">
            You don&apos;t have permission to edit this sheet
          </p>
        </div>
      )}

      {/* Formula bar */}
      <FormulaBar
        selectedCell={selectedCell}
        cellValue={selectedCellData.value}
        formula={selectedCellData.formula}
        onFormulaChange={handleFormulaChange}
        isReadOnly={isReadOnly}
      />

      {/* Sheet content */}
      <div className={`flex-1 overflow-hidden ${isReadOnly ? 'bg-gray-50/50 dark:bg-gray-900/20' : ''}`}>
        <NativeSheetView
          sheetData={sheetData}
          onCellChange={handleCellChange}
          onCellSelect={handleCellSelect}
          selectedCell={selectedCell}
          isReadOnly={isReadOnly}
        />
      </div>

      </motion.div>
    </SheetErrorBoundary>
  );
};

export default SheetView;