"use client";

import React, { useEffect, useState, useCallback, useRef } from 'react';
import dynamic from 'next/dynamic';
import { useDocument } from '@/hooks/useDocument';
import { Editor } from '@tiptap/react';
import Toolbar from '@/components/editors/Toolbar';
import { motion, AnimatePresence } from 'motion/react';
import { useDocumentStore } from '@/stores/useDocumentStore';
import { useSocket } from '@/hooks/useSocket';
import { PageEventPayload } from '@/lib/websocket';
import { toast } from 'sonner';
import { useAuth } from '@/hooks/useAuth';
import { fetchWithAuth } from '@/lib/auth/auth-fetch';
import { useEditingStore } from '@/stores/useEditingStore';
import { PullToRefresh } from '@/components/ui/pull-to-refresh';
import { CustomScrollArea } from '@/components/ui/custom-scroll-area';

interface DocumentViewProps {
  pageId: string;
}

const MonacoEditor = dynamic(() => import('@/components/editors/MonacoEditor'), { ssr: false });
const RichEditor = dynamic(() => import('@/components/editors/RichEditor'), { ssr: false });


const DocumentView = ({ pageId }: DocumentViewProps) => {
  const { activeView } = useDocumentStore();
  const [editor, setEditor] = useState<Editor | null>(null);
  const [isReadOnly, setIsReadOnly] = useState(false);
  const [isEditorFocused, setIsEditorFocused] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const isDirtyRef = useRef(false);
  const hasInitializedRef = useRef(false);
  const socket = useSocket();
  const { user } = useAuth();

  // Use the new document hook - will fetch content if not cached
  const {
    document: documentState,
    isLoading,
    initializeAndActivate,
    updateContent,
    updateContentFromServer,
    saveWithDebounce,
    forceSave,
  } = useDocument(pageId);

  // Track editor focus state for pull-to-refresh
  useEffect(() => {
    if (!editor) return;

    const handleFocus = () => setIsEditorFocused(true);
    const handleBlur = () => setIsEditorFocused(false);

    editor.on('focus', handleFocus);
    editor.on('blur', handleBlur);

    // Set initial state
    setIsEditorFocused(editor.isFocused);

    return () => {
      editor.off('focus', handleFocus);
      editor.off('blur', handleBlur);
    };
  }, [editor]);

  // Pull-to-refresh handler
  const handleRefresh = useCallback(async () => {
    try {
      const response = await fetchWithAuth(`/api/pages/${pageId}`);
      if (response.ok) {
        const updatedPage = await response.json();
        updateContentFromServer(updatedPage.content);
      }
    } catch (error) {
      console.error('Failed to refresh document:', error);
    }
  }, [pageId, updateContentFromServer]);

  // Disable pull-to-refresh when editing
  const isPullToRefreshDisabled = isEditorFocused || documentState?.isDirty || activeView === 'code';

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
            <Toolbar editor={editor} />
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

      {/* Editor content with pull-to-refresh */}
      <PullToRefresh
        direction="top"
        onRefresh={handleRefresh}
        disabled={isPullToRefreshDisabled}
        className="flex-1"
      >
        <CustomScrollArea className={`h-full ${isReadOnly ? 'bg-gray-50/50 dark:bg-gray-900/20' : ''}`}>
          <div className={`flex justify-center items-start p-4 ${activeView === 'code' ? 'h-full' : ''}`}>
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
                      onEditorChange={setEditor}
                      readOnly={isReadOnly}
                      isPaginated={true}
                    />
                  </div>
                </motion.div>
              )}
            </AnimatePresence>
          </div>
        </CustomScrollArea>
      </PullToRefresh>

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