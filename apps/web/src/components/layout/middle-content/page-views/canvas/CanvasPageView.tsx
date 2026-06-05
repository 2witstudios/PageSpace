"use client";

import React, { useEffect, useState, useCallback, useRef } from 'react';
import { fetchWithAuth } from '@/lib/auth/auth-fetch';
import dynamic from 'next/dynamic';
import { CanvasFrame } from '@/components/canvas/CanvasFrame';
import { ErrorBoundary } from '@/components/ai/shared';
import { useDocument } from '@/hooks/useDocument';
import { useDocumentManagerStore } from '@/stores/useDocumentManagerStore';
import { useEditingStore } from '@/stores/useEditingStore';
import { useSocket } from '@/hooks/useSocket';
import { PageEventPayload } from '@/lib/websocket';
import { useFindStore } from '@/stores/useFindStore';
import CanvasPublishControls from './CanvasPublishControls';

interface CanvasPageViewProps {
  pageId: string;
}

const MonacoEditor = dynamic(() => import('@/components/editors/MonacoEditor'), { ssr: false });

const CanvasPageView = ({ pageId }: CanvasPageViewProps) => {
  const [activeTab, setActiveTab] = useState('view');
  const containerRef = useRef<HTMLDivElement>(null);
  const hasInitializedRef = useRef(false);
  const isDirtyRef = useRef(false);
  const socket = useSocket();

  const {
    document: documentState,
    isLoading,
    initializeAndActivate,
    updateContent,
    updateContentFromServer,
    saveWithDebounce,
    forceSave,
  } = useDocument(pageId);

  const content = documentState?.content ?? '';

  // Find in page (view tab only; code tab uses Monaco's built-in find)
  const findQuery = useFindStore((s) => s.query);
  const isFindOpen = useFindStore((s) => s.isOpen);
  const reportMatches = useFindStore((s) => s.reportMatches);

  useEffect(() => {
    if (!isFindOpen || !findQuery || activeTab !== 'view') {
      reportMatches(0);
      return;
    }
    const parser = new DOMParser();
    const doc = parser.parseFromString(content, 'text/html');
    const text = (doc.body.textContent ?? '').toLowerCase();
    const q = findQuery.toLowerCase();
    let count = 0;
    let idx = text.indexOf(q);
    while (idx !== -1) {
      count++;
      idx = text.indexOf(q, idx + 1);
    }
    reportMatches(count);
  }, [isFindOpen, findQuery, content, activeTab, reportMatches]);

  // Store forceSave in ref to prevent cleanup effects from re-running
  const forceSaveRef = useRef(forceSave);
  useEffect(() => {
    forceSaveRef.current = forceSave;
  }, [forceSave]);

  // Initialize document when component mounts (fetches from API if not cached)
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

  // Register editing state to prevent SWR revalidation during edits
  useEffect(() => {
    const componentId = `canvas-${pageId}`;

    if (documentState?.isDirty) {
      useEditingStore.getState().startEditing(componentId, 'document', {
        pageId,
        componentName: 'CanvasPageView',
      });
    } else {
      useEditingStore.getState().endEditing(componentId);
    }

    return () => {
      useEditingStore.getState().endEditing(componentId);
    };
  }, [documentState?.isDirty, pageId]);

  // Track isDirty in ref
  useEffect(() => {
    isDirtyRef.current = documentState?.isDirty || false;
  }, [documentState?.isDirty]);

  // Listen for real-time content updates from AI tools / other users
  useEffect(() => {
    if (!socket) return;

    const handleContentUpdate = async (eventData: PageEventPayload) => {
      if (eventData.socketId && eventData.socketId === socket.id) {
        return;
      }

      if (eventData.pageId === pageId) {
        try {
          const response = await fetchWithAuth(`/api/pages/${pageId}`);
          if (response.ok) {
            const updatedPage = await response.json();
            // Re-read dirty state from store at merge time (not from stale closure)
            // to prevent overwriting edits that started while the fetch was in-flight
            const currentDoc = useDocumentManagerStore.getState().getDocument(pageId);
            if (!currentDoc?.isDirty) {
              updateContentFromServer(
                typeof updatedPage.content === 'string' ? updatedPage.content : '',
                updatedPage.revision
              );
            }
          }
        } catch (error) {
          console.error('Failed to fetch updated canvas content:', error);
        }
      }
    };

    socket.on('page:content-updated', handleContentUpdate);

    return () => {
      socket.off('page:content-updated', handleContentUpdate);
    };
  }, [socket, pageId, updateContentFromServer]);

  // Handle content changes from Monaco editor
  const handleContentChange = useCallback((newContent: string | undefined) => {
    const value = newContent || '';
    updateContent(value);
    saveWithDebounce(value);
  }, [updateContent, saveWithDebounce]);

  // Cleanup on unmount - auto-save any unsaved changes
  useEffect(() => {
    return () => {
      if (isDirtyRef.current) {
        forceSaveRef.current().catch(console.error);
      }
    };
  }, []);

  return (
    <div ref={containerRef} className="h-full flex flex-col relative">
      <div className="relative flex flex-wrap items-center border-b">
        <button
          className={`px-4 py-2 ${activeTab === 'code' ? 'border-b-2 border-blue-500' : ''}`}
          onClick={() => setActiveTab('code')}
        >
          Code
        </button>
        <button
          className={`px-4 py-2 ${activeTab === 'view' ? 'border-b-2 border-blue-500' : ''}`}
          onClick={() => setActiveTab('view')}
        >
          View
        </button>
        <div className="ml-auto min-w-0 max-w-full">
          <CanvasPublishControls pageId={pageId} contentDirty={documentState?.isDirty} />
        </div>
      </div>
      {activeTab === 'code' && (
        <div className="flex-1 min-h-0">
          <MonacoEditor
            value={content}
            onChange={handleContentChange}
            language="html"
          />
        </div>
      )}
      {activeTab === 'view' && (
        <div className="flex-1 w-full bg-background text-foreground">
          <ErrorBoundary>
            <CanvasFrame html={content} />
          </ErrorBoundary>
        </div>
      )}

      {isLoading && (
        <div className="absolute inset-0 bg-background/80 backdrop-blur-sm flex items-center justify-center">
          <div className="flex items-center gap-2">
            <div className="w-4 h-4 border-2 border-primary border-t-transparent rounded-full animate-spin" />
            <span className="text-sm text-muted-foreground">Loading canvas...</span>
          </div>
        </div>
      )}
    </div>
  );
};

export default React.memo(CanvasPageView, (prevProps, nextProps) => prevProps.pageId === nextProps.pageId);
