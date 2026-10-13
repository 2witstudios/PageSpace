"use client";

import React, { useEffect, useState, useCallback, useRef, useId } from 'react';
import dynamic from 'next/dynamic';
import { useDocument } from '@/retained/hooks/useDocument';
import DocumentConflictGate from '@/retained/components/layout/middle-content/page-views/document/DocumentConflictGate';
import { motion, AnimatePresence } from 'motion/react';
import { usePageContentSocket } from '@/retained/hooks/usePageContentSocket';
import type { PageEventPayload } from '@/retained-adapters/ui-contracts';
import { toast } from 'sonner';
import { usePermissions } from '@/retained/hooks/usePermissions';
import { fetchWithAuth } from '@/retained/lib/auth/auth-fetch';
import { useEditingStore } from '@/retained/stores/useEditingStore';
import { usePageTree } from '@/retained/hooks/usePageTree';
import { findNodeAndParent } from '@/retained/lib/tree/tree-utils';
import { useParams } from '@/retained-adapters/navigation';
import { CodeLanguageSelect } from './CodeLanguageSelect';

interface CodePageViewProps {
  pageId: string;
  /**
   * The page's own drive, for cross-drive socket updates — mirrors
   * DocumentView's identical prop. Optional and falls back to the route's own
   * `driveId` param for backward compat with callers inside a drive route
   * (e.g. CenterPanel); a pane has no such route (or the wrong one, for a
   * cross-drive page in a global-assistant session), so it must pass the
   * fetched page's real driveId explicitly.
   */
  driveId?: string;
  /**
   * Controlled language, for a caller (the v3 Page tools strip) that renders the Language
   * select itself. Without `onLanguageChange` the view keeps its own choice and the select
   * sits in its own row, as before.
   */
  language?: string;
  onLanguageChange?: (language: string) => void;
}

const MonacoEditor = dynamic(() => import('@/retained/components/editors/MonacoEditor'), { ssr: false });


import { detectLanguageFromFilename } from '@pagespace/lib/utils/language-detection';

function detectLanguageFromTitle(title: string): string {
  return detectLanguageFromFilename(title);
}

const CodePageView = ({ pageId, driveId: driveIdProp, language: languageProp, onLanguageChange }: CodePageViewProps) => {
  const { permissions } = usePermissions(pageId);
  const isReadOnly = permissions?.canEdit !== true;
  const [internalLanguage, setInternalLanguage] = useState('plaintext');
  const language = languageProp ?? internalLanguage;
  const setLanguage = useCallback((next: string) => {
    if (onLanguageChange) onLanguageChange(next);
    else setInternalLanguage(next);
  }, [onLanguageChange]);
  const isDirtyRef = useRef(false);
  const hasInitializedRef = useRef(false);
  const params = useParams();
  const driveId = driveIdProp ?? (params.driveId as string);
  const { tree } = usePageTree(driveId);
  // Distinguishes this mount from any other simultaneous mount of the SAME
  // page (main center panel vs. an agent-session pane) — see DocumentView's
  // identical fix for why the key must not be pageId alone.
  const instanceId = useId();

  const {
    document: documentState,
    isLoading,
    initializeAndActivate,
    updateContent,
    updateContentFromServer,
    saveWithDebounce,
    forceSave,
    conflict,
    resolveConflict,
    isResolvingConflict,
  } = useDocument(pageId);

  // Store forceSave in ref to prevent cleanup effects from re-running
  const forceSaveRef = useRef(forceSave);
  useEffect(() => {
    forceSaveRef.current = forceSave;
  }, [forceSave]);

  // Detect language from page title
  useEffect(() => {
    const page = findNodeAndParent(tree, pageId)?.node;
    if (page?.title) {
      const detected = detectLanguageFromTitle(page.title);
      setLanguage(detected);
    }
  }, [tree, pageId, setLanguage]);

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

  // Register editing state when document is dirty
  useEffect(() => {
    const componentId = `code-${pageId}-${instanceId}`;

    if (documentState?.isDirty && !isReadOnly) {
      useEditingStore.getState().startEditing(componentId, 'document', {
        pageId: pageId,
        componentName: 'CodePageView',
      });
    } else {
      useEditingStore.getState().endEditing(componentId);
    }

    return () => {
      useEditingStore.getState().endEditing(componentId);
    };
  }, [documentState?.isDirty, pageId, isReadOnly, instanceId]);


  // Listen for content updates from other sources. Joins the PAGE's own
  // drive room (not just whatever the route happens to be) — see
  // DocumentView's identical usage: without this, a code page opened outside
  // its own drive's route (a pane in the global-assistant console, or a
  // cross-drive session) never receives live updates at all.
  const handleContentUpdate = useCallback(async (_eventData: PageEventPayload) => {
    try {
      const response = await fetchWithAuth(`/api/pages/${pageId}`);
      if (response.ok) {
        const updatedPage = await response.json();
        if (updatedPage.content !== documentState?.content && !documentState?.isDirty) {
          updateContentFromServer(updatedPage.content, updatedPage.revision);
        }
      }
    } catch (error) {
      console.error('Failed to fetch updated content:', error);
    }
  }, [pageId, documentState?.content, documentState?.isDirty, updateContentFromServer]);

  usePageContentSocket(pageId, driveId, {
    onContentUpdated: handleContentUpdate,
    enabled: !!driveId,
  });

  // Handle content changes
  const handleContentChange = useCallback((newContent: string | undefined) => {
    if (isReadOnly) {
      toast.error('You do not have permission to edit this page');
      return;
    }

    const content = newContent || '';
    updateContent(content);
    saveWithDebounce(content);
  }, [updateContent, saveWithDebounce, isReadOnly]);

  // Track isDirty in ref
  useEffect(() => {
    isDirtyRef.current = documentState?.isDirty || false;
  }, [documentState?.isDirty]);

  // Cleanup on unmount - auto-save any unsaved changes
  useEffect(() => {
    return () => {
      if (isDirtyRef.current) {
        forceSaveRef.current().catch(console.error);
      }
    };
  }, []);

  // Keyboard shortcuts
  useEffect(() => {
    if (typeof document === 'undefined' || !document.addEventListener) return;

    const handleKeyDown = (e: KeyboardEvent) => {
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
  }, []);

  // Auto-save on window blur
  useEffect(() => {
    if (typeof window === 'undefined' || !window.addEventListener) return;

    const handleBlur = () => {
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
  }, []);

  return (
    <motion.div
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -10 }}
      transition={{ duration: 0.2 }}
      className="h-full flex flex-col relative"
    >
      <DocumentConflictGate
        conflict={conflict}
        onResolve={resolveConflict}
        isResolving={isResolvingConflict}
        previewMode="plain"
      />
      {/* Language selector toolbar: omitted when the Page tools strip owns the select */}
      {!onLanguageChange && (
        <div className="flex items-center gap-2 px-4 py-2 border-b border-[var(--separator)]">
          <CodeLanguageSelect value={language} onValueChange={setLanguage} />
        </div>
      )}

      {/* Read-only indicator */}
      {isReadOnly && (
        <div className="bg-yellow-50 dark:bg-yellow-900/20 border-b border-yellow-200 dark:border-yellow-800 px-4 py-2">
          <p className="text-sm text-yellow-800 dark:text-yellow-200 text-center">
            You don&apos;t have permission to edit this page
          </p>
        </div>
      )}

      {/* Monaco editor */}
      <div className={`flex-1 min-h-0 ${isReadOnly ? 'editor-readonly' : ''}`}>
        <MonacoEditor
          value={documentState?.content || ''}
          onChange={handleContentChange}
          language={language}
          readOnly={isReadOnly}
        />
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
              <span className="text-sm text-muted-foreground">Loading code...</span>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </motion.div>
  );
};

export default React.memo(CodePageView, (prevProps, nextProps) => prevProps.pageId === nextProps.pageId);
