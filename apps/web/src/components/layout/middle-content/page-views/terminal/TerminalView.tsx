"use client";

import React, { useEffect, useState, useCallback, useRef } from 'react';
import dynamic from 'next/dynamic';
import { useDocument } from '@/hooks/useDocument';
import { motion, AnimatePresence } from 'motion/react';
import { useSocket } from '@/hooks/useSocket';
import { PageEventPayload } from '@/lib/websocket';
import { toast } from 'sonner';
import { useAuth } from '@/hooks/useAuth';
import { fetchWithAuth } from '@/lib/auth/auth-fetch';
import { useEditingStore } from '@/stores/useEditingStore';
import { useTheme } from 'next-themes';
import type { TerminalSession } from './types';

interface TerminalViewProps {
  pageId: string;
}

function parseSession(content: string): TerminalSession {
  try {
    const parsed = JSON.parse(content);
    return { history: Array.isArray(parsed.history) ? parsed.history : [] };
  } catch {
    return { history: [] };
  }
}

function serializeSession(session: TerminalSession): string {
  return JSON.stringify(session);
}

const GridlandTerminal = dynamic(
  () => import('./GridlandTerminal'),
  { ssr: false }
);

const TerminalView = ({ pageId }: TerminalViewProps) => {
  const [isReadOnly, setIsReadOnly] = useState(false);
  const [session, setSession] = useState<TerminalSession>({ history: [] });
  const isDirtyRef = useRef(false);
  const hasInitializedRef = useRef(false);
  const socket = useSocket();
  const { user } = useAuth();
  const { resolvedTheme } = useTheme();

  const {
    document: documentState,
    isLoading,
    initializeAndActivate,
    updateContent,
    updateContentFromServer,
    saveWithDebounce,
    forceSave,
  } = useDocument(pageId);

  const forceSaveRef = useRef(forceSave);
  useEffect(() => {
    forceSaveRef.current = forceSave;
  }, [forceSave]);

  // Initialize document when component mounts
  useEffect(() => {
    if (!hasInitializedRef.current) {
      hasInitializedRef.current = true;
      initializeAndActivate();
    }
  }, [pageId, initializeAndActivate]);

  // Reset initialization flag when pageId changes
  useEffect(() => {
    hasInitializedRef.current = false;
  }, [pageId]);

  // Sync document content to local session state
  useEffect(() => {
    if (documentState?.content) {
      setSession(parseSession(documentState.content));
    }
  }, [documentState?.content]);

  // Register editing state when document is dirty
  useEffect(() => {
    const componentId = `terminal-${pageId}`;
    if (documentState?.isDirty && !isReadOnly) {
      useEditingStore.getState().startEditing(componentId, 'document', {
        pageId,
        componentName: 'TerminalView',
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
        }
      } catch (error) {
        console.error('Failed to check permissions:', error);
      }
    };
    checkPermissions();
  }, [user?.id, pageId]);

  // Keep a ref to latest documentState to avoid stale closures in socket handler
  const documentStateRef = useRef(documentState);
  useEffect(() => {
    documentStateRef.current = documentState;
  }, [documentState]);

  // Listen for content updates from other sources
  useEffect(() => {
    if (!socket) return;
    const handleContentUpdate = async (eventData: PageEventPayload) => {
      if (eventData.socketId && eventData.socketId === socket.id) return;
      if (eventData.pageId === pageId) {
        try {
          const response = await fetchWithAuth(`/api/pages/${pageId}`);
          if (response.ok) {
            const updatedPage = await response.json();
            const currentDoc = documentStateRef.current;
            if (updatedPage.content !== currentDoc?.content && !currentDoc?.isDirty) {
              updateContentFromServer(updatedPage.content, updatedPage.revision);
            }
          }
        } catch (error) {
          console.error('Failed to fetch updated content:', error);
        }
      }
    };
    socket.on('page:content-updated', handleContentUpdate);
    return () => {
      socket.off('page:content-updated', handleContentUpdate);
    };
  }, [socket, pageId, updateContentFromServer]);

  // Handle command submission — gated on document initialization
  const handleCommand = useCallback((command: string) => {
    if (isReadOnly || !documentState) {
      if (!isReadOnly && !documentState) {
        toast.error('Terminal is still loading');
      } else {
        toast.error('You do not have permission to edit this page');
      }
      return;
    }

    const entry = {
      command,
      output: 'Shell not connected. PTY backend required.',
      timestamp: Date.now(),
    };

    setSession(prev => {
      const updated = { history: [...prev.history, entry] };
      const serialized = serializeSession(updated);
      updateContent(serialized);
      saveWithDebounce(serialized);
      return updated;
    });
  }, [isReadOnly, documentState, updateContent, saveWithDebounce]);

  // Handle clearing the terminal
  const handleClear = useCallback(() => {
    if (isReadOnly || !documentState) return;
    const updated: TerminalSession = { history: [] };
    setSession(updated);
    const serialized = serializeSession(updated);
    updateContent(serialized);
    saveWithDebounce(serialized);
  }, [isReadOnly, documentState, updateContent, saveWithDebounce]);

  // Track isDirty in ref
  useEffect(() => {
    isDirtyRef.current = documentState?.isDirty || false;
  }, [documentState?.isDirty]);

  // Cleanup on unmount - auto-save
  useEffect(() => {
    return () => {
      if (isDirtyRef.current) {
        forceSaveRef.current().catch(console.error);
      }
    };
  }, []);

  // Ctrl+S to save
  useEffect(() => {
    if (typeof document === 'undefined') return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 's') {
        e.preventDefault();
        forceSaveRef.current();
      }
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, []);

  // Auto-save on window blur
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const handleBlur = () => {
      if (isDirtyRef.current) {
        forceSaveRef.current().catch(console.error);
      }
    };
    window.addEventListener('blur', handleBlur);
    return () => window.removeEventListener('blur', handleBlur);
  }, []);

  const isDark = resolvedTheme === 'dark';

  return (
    <motion.div
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -10 }}
      transition={{ duration: 0.2 }}
      className="h-full flex flex-col relative"
    >
      {isReadOnly && (
        <div className="bg-yellow-50 dark:bg-yellow-900/20 border-b border-yellow-200 dark:border-yellow-800 px-4 py-2">
          <p className="text-sm text-yellow-800 dark:text-yellow-200 text-center">
            You don&apos;t have permission to edit this page
          </p>
        </div>
      )}

      <div className="flex-1 min-h-0">
        <GridlandTerminal
          session={session}
          onCommand={handleCommand}
          onClear={handleClear}
          isDark={isDark}
          isReadOnly={isReadOnly || isLoading || !documentState}
        />
      </div>

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
              <span className="text-sm text-muted-foreground">Loading terminal...</span>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </motion.div>
  );
};

export default React.memo(TerminalView, (prevProps, nextProps) => prevProps.pageId === nextProps.pageId);
