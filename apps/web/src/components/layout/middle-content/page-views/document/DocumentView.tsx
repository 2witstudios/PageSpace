"use client";

import React, { useEffect, useState, useCallback, useRef } from 'react';
import dynamic from 'next/dynamic';
import { TreePage } from '@/hooks/usePageTree';
import { useDocument } from '@/hooks/useDocument';
import { Editor } from '@tiptap/react';
import Toolbar from '@/components/editors/Toolbar';
import { motion, AnimatePresence } from 'motion/react';
import { useDocumentStore } from '@/stores/useDocumentStore';
import { useSocket } from '@/hooks/useSocket';
import { PageEventPayload } from '@/lib/socket-utils';
import { toast } from 'sonner';
import { useAuth } from '@/hooks/use-auth';
import { patch } from '@/lib/auth-fetch';

interface DocumentViewProps {
  page: TreePage;
}

const MonacoEditor = dynamic(() => import('@/components/editors/MonacoEditor'), { ssr: false });
const RichEditor = dynamic(() => import('@/components/editors/RichEditor'), { ssr: false });


const DocumentView = ({ page }: DocumentViewProps) => {
  const { activeView } = useDocumentStore();
  const [editor, setEditor] = useState<Editor | null>(null);
  const [isLoading] = useState(false);
  const [isReadOnly, setIsReadOnly] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const socket = useSocket();
  const { user } = useAuth();
  
  // Use the new document hook
  const {
    document: documentState,
    initializeAndActivate,
    updateContent,
    updateContentFromServer,
    saveWithDebounce,
    forceSave,
  } = useDocument(page.id, page.content);
  
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
  }, [user?.id, page.id]);

  // Listen for content updates from other sources (AI, other users)
  useEffect(() => {
    if (!socket) return;

    const handleContentUpdate = async (eventData: PageEventPayload) => {
      // Only update if it's for the current page
      if (eventData.pageId === page.id) {
        console.log('📝 Document content updated via socket, fetching latest...');
        
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


  // Handle content changes
  const handleContentChange = useCallback((newContent: string | undefined, shouldSave = true) => {
    if (isReadOnly) {
      toast.error('You do not have permission to edit this document');
      return;
    }

    const content = newContent || '';
    // Always update document state (sets isDirty flag)
    updateContent(content);

    // Only trigger save if requested (after formatting completes)
    if (shouldSave) {
      saveWithDebounce(content);
    }
  }, [updateContent, saveWithDebounce, isReadOnly]);


  // Cleanup on unmount - auto-save any unsaved changes
  useEffect(() => {
    return () => {
      // Force save if dirty before unmounting
      if (documentState?.isDirty) {
        console.log('🚨 Component unmounting with unsaved changes, force saving...');
        // Fire-and-forget save since we can't await in cleanup
        patch(`/api/pages/${page.id}`, { content: documentState.content }).catch(error => {
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
        console.log('🔄 Window blur detected, auto-saving...');
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
                  onEditorChange={setEditor}
                  readOnly={isReadOnly}
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