"use client";

import React, { useEffect, useState, useCallback, useRef } from 'react';
import dynamic from 'next/dynamic';
import { useDocument } from '@/hooks/useDocument';
import { Editor } from '@tiptap/react';
import Toolbar from '@/components/editors/Toolbar';
import { PageSetupPanel } from '@/components/editors/PageSetupPanel';
import { motion, AnimatePresence } from 'motion/react';
import { useDocumentStore } from '@/stores/useDocumentStore';
import { useSocket } from '@/hooks/useSocket';
import { PageEventPayload } from '@/lib/socket-utils';
import { toast } from 'sonner';
import { useAuth } from '@/hooks/use-auth';
import { fetchWithAuth } from '@/lib/auth-fetch';
import { useEditingStore } from '@/stores/useEditingStore';
import { useLocalStorage } from '@/hooks/useLocalStorage';
import { useEditorDomStore } from '@/stores/useEditorDomStore';

interface DocumentViewProps {
  pageId: string;
}

const MonacoEditor = dynamic(() => import('@/components/editors/MonacoEditor'), { ssr: false });
const RichEditor = dynamic(() => import('@/components/editors/RichEditor'), { ssr: false });


const DocumentView = ({ pageId }: DocumentViewProps) => {
  const { activeView } = useDocumentStore();
  const [editor, setEditor] = useState<Editor | null>(null);
  const [isReadOnly, setIsReadOnly] = useState(false);
  const [isPaginated, setIsPaginated] = useState(false);
  const [isPageSetupOpen, setIsPageSetupOpen] = useLocalStorage('pageSetupPanelOpen', false);
  const [pageSize, setPageSize] = useState<string>('letter');
  const [margins, setMargins] = useState<string>('normal');
  const [showPageNumbers, setShowPageNumbers] = useState<boolean>(true);
  const [showHeaders, setShowHeaders] = useState<boolean>(false);
  const [showFooters, setShowFooters] = useState<boolean>(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const isDirtyRef = useRef(false);
  const hasInitializedRef = useRef(false);
  const socket = useSocket();
  const { user } = useAuth();
  const setEditorElement = useEditorDomStore((state) => state.setEditorElement);

  // Use the new document hook - will fetch content if not cached
  const {
    document: documentState,
    isLoading,
    initializeAndActivate,
    updateContent,
    updateContentFromServer,
    updateContentSilently,
    saveWithDebounce,
    forceSave,
  } = useDocument(pageId);

  // Store forceSave in ref to prevent cleanup effects from re-running
  const forceSaveRef = useRef(forceSave);
  useEffect(() => {
    forceSaveRef.current = forceSave;
  }, [forceSave]);

  // Initialize document when component mounts (only once)
  useEffect(() => {
    if (!hasInitializedRef.current) {
      hasInitializedRef.current = true;
      initializeAndActivate();
    }
  }, [pageId, initializeAndActivate]); // Re-initialize on pageId change

  // Reset initialization flag when pageId changes
  useEffect(() => {
    hasInitializedRef.current = false;
  }, [pageId]);

  // Fetch pagination settings from page data
  useEffect(() => {
    const fetchPageSettings = async () => {
      try {
        const response = await fetchWithAuth(`/api/pages/${pageId}`);
        if (response.ok) {
          const page = await response.json();
          setIsPaginated(page.isPaginated || false);
          setPageSize(page.pageSize || 'letter');
          setMargins(page.margins || 'normal');
          setShowPageNumbers(page.showPageNumbers ?? true);
          setShowHeaders(page.showHeaders ?? false);
          setShowFooters(page.showFooters ?? false);
        }
      } catch (error) {
        console.error('Failed to fetch page settings:', error);
      }
    };

    fetchPageSettings();
  }, [pageId]);

  // Register editing state when document is dirty
  useEffect(() => {
    const componentId = `document-${pageId}`;

    if (documentState?.isDirty && !isReadOnly) {
      useEditingStore.getState().startEditing(componentId, 'document', {
        pageId: pageId,
        componentName: 'DocumentView',
      });
    } else {
      useEditingStore.getState().endEditing(componentId);
    }

    return () => {
      useEditingStore.getState().endEditing(componentId);
    };
  }, [documentState?.isDirty, pageId, isReadOnly]);

  // Check user permissions
  useEffect(() => {
    const checkPermissions = async () => {
      if (!user?.id) return;

      try {
        const response = await fetchWithAuth(`/api/pages/${pageId}/permissions/check?userId=${user.id}`);
        if (response.ok) {
          const permissions = await response.json();
          setIsReadOnly(!permissions.canEdit);
          if (!permissions.canEdit) {
            toast.info("You don't have permission to edit this document", {
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
  }, [user?.id, pageId]);

  // Listen for content updates from other sources (AI, other users)
  useEffect(() => {
    if (!socket) return;

    const handleContentUpdate = async (eventData: PageEventPayload) => {
      // Filter out self-triggered events to prevent refetch loop
      if (eventData.socketId && eventData.socketId === socket.id) {
        return;
      }

      // Only update if it's for the current page
      if (eventData.pageId === pageId) {

        try {
          // Fetch the latest content from the server
          const response = await fetchWithAuth(`/api/pages/${pageId}`);
          if (response.ok) {
            const updatedPage = await response.json();

            // Only update if content actually changed and we're not currently editing
            // Note: This uses closure over documentState, which is acceptable here
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
  }, [socket, pageId, documentState, updateContentFromServer]);


  // Handle content changes
  const handleContentChange = useCallback((newContent: string | undefined) => {
    if (isReadOnly) {
      toast.error('You do not have permission to edit this document');
      return;
    }

    const content = newContent || '';

    // Update content (sets isDirty flag)
    updateContent(content);

    // Save timer - CRITICAL for data persistence (1000ms)
    // Triggered every time content changes
    saveWithDebounce(content);
  }, [updateContent, saveWithDebounce, isReadOnly]);

  // Handle formatting changes (Prettier) - silent update without marking dirty
  const handleFormatChange = useCallback((newContent: string | undefined) => {
    const content = newContent || '';
    updateContentSilently(content);
  }, [updateContentSilently]);

  // Track isDirty in ref without causing effect recreation
  useEffect(() => {
    isDirtyRef.current = documentState?.isDirty || false;
  }, [documentState?.isDirty]);

  // Cleanup on unmount - auto-save any unsaved changes
  // Empty deps array ensures cleanup only runs on TRUE component unmount
  useEffect(() => {
    return () => {
      if (isDirtyRef.current) {
        forceSaveRef.current().catch(console.error);
      }
    };
  }, []); // ✅ Empty deps - only runs on mount/unmount

  // Handle keyboard shortcuts
  useEffect(() => {
    // Only run on client side with proper document API
    if (typeof document === 'undefined' || !document.addEventListener) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      // Ctrl+S / Cmd+S to save
      if ((e.ctrlKey || e.metaKey) && e.key === 's') {
        e.preventDefault();
        forceSaveRef.current();
      }
    };

    document.addEventListener('keydown', handleKeyDown);
    return () => {
      if (typeof document !== 'undefined' && document.removeEventListener) {
        document.removeEventListener('keydown', handleKeyDown);
      }
    };
  }, []); // ✅ Empty deps - uses ref for latest forceSave

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

  // Handle editor DOM element changes - expose to store for print handler
  const handleEditorDomChange = useCallback((element: HTMLElement | null) => {
    setEditorElement(element);
  }, [setEditorElement]);

  return (
    <motion.div 
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -10 }}
      transition={{ duration: 0.2 }}
      ref={containerRef} 
      className="h-full flex flex-col relative"
    >

      {/* Editor toolbar for rich text mode */}
      <AnimatePresence>
        {activeView === 'rich' && !isReadOnly && (
          <motion.div
            initial={{ y: -10, opacity: 0 }}
            animate={{ y: 0, opacity: 1 }}
            exit={{ y: -10, opacity: 0 }}
            transition={{ duration: 0.2 }}
            className="sticky top-0 z-10 mx-4 mt-4 rounded-lg liquid-glass-thin border border-[var(--separator)] shadow-[var(--shadow-ambient)] overflow-hidden"
          >
            {/* Formatting Toolbar */}
            <Toolbar
              editor={editor}
              isPaginated={isPaginated}
              isPageSetupOpen={isPageSetupOpen}
              onTogglePageSetup={() => setIsPageSetupOpen(!isPageSetupOpen)}
            />

            {/* Page Setup Panel - collapsible dropdown below toolbar */}
            <AnimatePresence>
              {isPaginated && isPageSetupOpen && (
                <motion.div
                  initial={{ height: 0, opacity: 0 }}
                  animate={{ height: "auto", opacity: 1 }}
                  exit={{ height: 0, opacity: 0 }}
                  transition={{ duration: 0.2 }}
                  className="overflow-hidden"
                >
                  <PageSetupPanel
                    pageId={pageId}
                    pageSize={pageSize}
                    margins={margins}
                    showPageNumbers={showPageNumbers}
                    showHeaders={showHeaders}
                    showFooters={showFooters}
                    onSettingChange={(field, value) => {
                      if (field === 'pageSize') setPageSize(value as string);
                      else if (field === 'margins') setMargins(value as string);
                      else if (field === 'showPageNumbers') setShowPageNumbers(value as boolean);
                      else if (field === 'showHeaders') setShowHeaders(value as boolean);
                      else if (field === 'showFooters') setShowFooters(value as boolean);
                    }}
                  />
                </motion.div>
              )}
            </AnimatePresence>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Read-only indicator */}
      {isReadOnly && (
        <div className="bg-yellow-50 dark:bg-yellow-900/20 border-b border-yellow-200 dark:border-yellow-800 px-4 py-2">
          <p className="text-sm text-yellow-800 dark:text-yellow-200 text-center">
            You don&apos;t have permission to edit this document
          </p>
        </div>
      )}

      {/* Editor content */}
      <div className={`flex-1 flex justify-center items-start p-4 overflow-auto ${isReadOnly ? 'bg-gray-50/50 dark:bg-gray-900/20' : ''}`}>
        <AnimatePresence mode="wait">
          {activeView === 'code' ? (
            <motion.div
              key="code-editor"
              initial={{ opacity: 0, x: 20 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: -20 }}
              transition={{ duration: 0.2 }}
              className="w-full h-full"
            >
              <div className={`h-full ${isReadOnly ? 'editor-readonly' : ''}`}>
                <MonacoEditor
                  value={documentState?.content || ''}
                  onChange={handleContentChange}
                  language="html"
                  readOnly={isReadOnly}
                />
              </div>
            </motion.div>
          ) : (
            <motion.div
              key="rich-editor"
              initial={{ opacity: 0, x: 20 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: -20 }}
              transition={{ duration: 0.2 }}
              className="w-full h-full"
            >
              <div className="max-w-4xl mx-auto w-full">
                <RichEditor
                  value={documentState?.content || ''}
                  onChange={handleContentChange}
                  onFormatChange={handleFormatChange}
                  onEditorChange={setEditor}
                  onEditorDomChange={handleEditorDomChange}
                  readOnly={isReadOnly}
                  isPaginated={isPaginated}
                  pageSize={pageSize}
                  margins={margins}
                  showPageNumbers={showPageNumbers}
                  showHeaders={showHeaders}
                  showFooters={showFooters}
                />
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </div>

      {/* Loading overlay */}
      <AnimatePresence>
        {isLoading && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="absolute inset-0 bg-background/80 backdrop-blur-sm flex items-center justify-center"
          >
            <div className="flex items-center gap-2">
              <div className="w-4 h-4 border-2 border-primary border-t-transparent rounded-full animate-spin" />
              <span className="text-sm text-muted-foreground">Loading document...</span>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </motion.div>
  );
};

export default DocumentView;