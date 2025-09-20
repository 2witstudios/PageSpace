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
  version: number;
}


const SheetView = ({ page }: SheetViewProps) => {
  const [isReadOnly, setIsReadOnly] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const socket = useSocket();
  const { user } = useAuth();

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
        version: 1
      };
    }
  }, [documentState?.content]);


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

    // Update the cell value
    newData[row][col] = value;

    // Create updated sheet data
    const updatedSheetData: SheetData = {
      ...sheetData,
      data: newData,
      metadata: {
        ...sheetData.metadata,
        rows: Math.max(sheetData.metadata.rows, newData.length),
        cols: Math.max(sheetData.metadata.cols, Math.max(...newData.map(row => row.length)))
      }
    };

    const newContent = JSON.stringify(updatedSheetData);

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
          cellRange: `${String.fromCharCode(65 + col)}${row + 1}`,
          value: value
        }
      });
    }
  }, [sheetData, updateContent, saveWithDebounce, isReadOnly, socket, page.id]);

  // Cleanup on unmount - auto-save any unsaved changes
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

      {/* Sheet content */}
      <div className={`flex-1 overflow-hidden ${isReadOnly ? 'bg-gray-50/50 dark:bg-gray-900/20' : ''}`}>
        <NativeSheetView
          sheetData={sheetData}
          onCellChange={handleCellChange}
          isReadOnly={isReadOnly}
        />
      </div>

      </motion.div>
    </SheetErrorBoundary>
  );
};

export default SheetView;