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
import SimpleGridView from './SimpleGridView';
import RevoFormulaBar from './RevoFormulaBar';
import { SheetDataAdapterProvider } from './SheetDataAdapter';
import { SheetData as NewSheetData, LegacySheetData as LegacySheetDataType, migrateLegacySheetData, createDefaultSheetData } from '@/lib/sheet-utils';
import { FormulaEngine } from '@pagespace/lib/formula-engine';

interface SheetViewProps {
  page: TreePage;
}

// Legacy interface for backward compatibility
export interface LegacySheetData {
  type: 'sheet';
  data: string[][];
  metadata: {
    rows: number;
    cols: number;
    headers: boolean;
    frozenRows: number;
  };
  formulas?: { [cellRef: string]: string };
  computedValues?: { [cellRef: string]: string | number };
  version: number;
}


const SheetView = ({ page }: SheetViewProps) => {
  const [isReadOnly, setIsReadOnly] = useState(false);
  const [selectedCell, setSelectedCell] = useState<string | null>(null);
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

  // Parse and migrate sheet data from document content
  const sheetData = useMemo<NewSheetData>(() => {
    try {
      if (typeof documentState?.content === 'string') {
        const parsed = JSON.parse(documentState.content);

        // Convert legacy spreadsheet type to sheet
        if (parsed.type === 'spreadsheet') {
          parsed.type = 'sheet';
        }

        // Check if this is legacy format (has data array)
        if (parsed.data && Array.isArray(parsed.data)) {
          console.log('🔄 Migrating legacy sheet data to new format');
          return migrateLegacySheetData(parsed as LegacySheetDataType);
        }

        // New format - ensure required fields
        if (!parsed.cells) parsed.cells = {};
        if (!parsed.metadata) {
          parsed.metadata = {
            rows: 100,
            cols: 26,
            headers: false,
            frozenRows: 0,
            lastModified: Date.now()
          };
        }
        if (!parsed.metadata.lastModified) {
          parsed.metadata.lastModified = Date.now();
        }

        return parsed as NewSheetData;
      }

      return documentState?.content || createDefaultSheetData();
    } catch (error) {
      console.error('Failed to parse sheet data:', error);
      return createDefaultSheetData();
    }
  }, [documentState?.content]);

  // Initialize formula engine with existing data when sheet data changes
  useEffect(() => {
    if (!formulaEngineRef.current || !sheetData) return;

    try {
      console.log('🔄 Initializing formula engine with sheet data...');

      // Clear the engine first
      formulaEngineRef.current.clear();

      // Load cells from new format
      Object.entries(sheetData.cells).forEach(([cellRef, cell]) => {
        try {
          if (cell.formula) {
            // Set formula
            const result = formulaEngineRef.current?.setCellContent(cellRef, cell.formula);
            console.log(`✓ Formula ${cellRef}: ${cell.formula} = ${result?.value}`);
          } else {
            // Set value
            const cellValue = typeof cell.value === 'boolean' ? (cell.value ? 'TRUE' : 'FALSE') : (cell.value || '');
            formulaEngineRef.current?.setCellContent(cellRef, cellValue);
            console.log(`✓ Value ${cellRef}: ${cell.value}`);
          }
        } catch (error) {
          console.error(`❌ Error setting cell ${cellRef}:`, error);
        }
      });

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

  // Handle data changes from the sheet adapter
  const handleDataChange = useCallback((newData: NewSheetData) => {
    if (isReadOnly) {
      toast.error('You do not have permission to edit this sheet');
      return;
    }

    const newContent = JSON.stringify(newData);
    console.log('💾 Saving updated sheet data');

    // Update document state immediately (optimistic update)
    updateContent(newContent);

    // Trigger debounced save
    saveWithDebounce(newContent);

    // Broadcast update via socket
    if (socket) {
      socket.emit('page-operation', {
        pageId: page.id,
        operation: 'content-updated',
        data: {
          timestamp: Date.now()
        }
      });
    }
  }, [updateContent, saveWithDebounce, isReadOnly, socket, page.id]);

  // Handle cell value changes from RevoGrid
  const handleCellChange = useCallback((cellRef: string, value: string | number, isFormula?: boolean) => {
    if (isReadOnly) {
      toast.error('You do not have permission to edit this sheet');
      return;
    }

    console.log(`📝 Cell change: ${cellRef} = "${value}" (isFormula: ${isFormula || false})`);

    const newCells = { ...sheetData.cells };
    let displayValue = value;

    if (isFormula && formulaEngineRef.current) {
      // Set formula in engine and get result
      try {
        const result = formulaEngineRef.current.setCellContent(cellRef, value);
        console.log(`🧮 Formula result for ${cellRef}:`, result);

        if (result.error) {
          displayValue = `#ERROR: ${result.error}`;
        } else {
          displayValue = result.value ?? '';
        }

        newCells[cellRef] = {
          value: displayValue,
          formula: String(value),
          type: 'formula'
        };
      } catch (error) {
        displayValue = '#ERROR!';
        newCells[cellRef] = {
          value: displayValue,
          formula: String(value),
          type: 'formula'
        };
        console.error(`❌ Formula calculation error for ${cellRef}:`, error);
      }

      // Update dependent cells
      if (formulaEngineRef.current) {
        try {
          const dependents = formulaEngineRef.current.getDependents(cellRef);
          console.log(`🔗 Updating ${dependents.length} dependent cells`);

          dependents.forEach(dependentRef => {
            const dependentResult = formulaEngineRef.current!.getCellValue(dependentRef);
            if (newCells[dependentRef]) {
              newCells[dependentRef] = {
                ...newCells[dependentRef],
                value: dependentResult.value ?? ''
              };
            }
          });
        } catch (error) {
          console.error('❌ Error updating dependent cells:', error);
        }
      }
    } else {
      // Regular value
      if (value === '' || value === null || value === undefined) {
        delete newCells[cellRef];
      } else {
        newCells[cellRef] = {
          value,
          type: typeof value === 'number' ? 'number' : 'string'
        };
      }

      // Update formula engine
      if (formulaEngineRef.current) {
        try {
          formulaEngineRef.current.setCellContent(cellRef, value);
        } catch (error) {
          console.error(`❌ Error setting value for ${cellRef}:`, error);
        }
      }
    }

    // Create updated sheet data
    const updatedSheetData: NewSheetData = {
      ...sheetData,
      cells: newCells,
      metadata: {
        ...sheetData.metadata,
        lastModified: Date.now()
      }
    };

    handleDataChange(updatedSheetData);
  }, [sheetData, handleDataChange, isReadOnly, formulaEngineRef]);

  // Handle cell selection
  const handleCellSelect = useCallback((cellRef: string) => {
    setSelectedCell(cellRef);
  }, []);

  // Handle formula bar changes
  const handleFormulaChange = useCallback((value: string) => {
    if (selectedCell) {
      const isFormula = value.startsWith('=');
      handleCellChange(selectedCell, value, isFormula);
    }
  }, [selectedCell, handleCellChange]);


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

        {/* Sheet with data adapter */}
        <SheetDataAdapterProvider
          sheetData={sheetData}
          onDataChange={handleDataChange}
        >
          {(adapter) => (
            <div className="flex-1 flex flex-col overflow-hidden">
              {/* Formula bar */}
              <RevoFormulaBar
                selectedCell={selectedCell}
                adapter={adapter}
                onFormulaChange={handleFormulaChange}
                isReadOnly={isReadOnly}
              />

              {/* Sheet content */}
              <div className={`flex-1 overflow-hidden ${isReadOnly ? 'bg-gray-50/50 dark:bg-gray-900/20' : ''}`}>
                <SimpleGridView
                  sheetData={sheetData}
                  onCellChange={handleCellChange}
                  onCellSelect={handleCellSelect}
                  selectedCell={selectedCell}
                  isReadOnly={isReadOnly}
                  className="h-full"
                />
              </div>
            </div>
          )}
        </SheetDataAdapterProvider>
      </motion.div>
    </SheetErrorBoundary>
  );
};

export default SheetView;