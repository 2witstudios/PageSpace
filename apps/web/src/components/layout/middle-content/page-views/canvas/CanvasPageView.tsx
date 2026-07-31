"use client";

import React, { useEffect, useCallback, useRef, useState, useId } from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { Maximize2 } from 'lucide-react';
import { fetchWithAuth } from '@/lib/auth/auth-fetch';
import dynamic from 'next/dynamic';
import { CanvasFrame } from '@/components/canvas/CanvasFrame';
import { ErrorBoundary } from '@/components/ai/shared';
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog';
import { useDocument } from '@/hooks/useDocument';
import { useDocumentManagerStore } from '@/stores/useDocumentManagerStore';
import { useEditingStore } from '@/stores/useEditingStore';
import { useSocket } from '@/hooks/useSocket';
import { PageEventPayload } from '@/lib/websocket';
import { useFindStore } from '@/stores/useFindStore';
import { usePublishStatusStore } from '@/stores/usePublishStatusStore';
import { CanvasSettingsPanel } from './settings/CanvasSettingsPanel';

interface CanvasPageViewProps {
  pageId: string;
}

type CanvasTab = 'view' | 'code' | 'settings';

const MonacoEditor = dynamic(() => import('@/components/editors/MonacoEditor'), { ssr: false });

const CANVAS_TABS: CanvasTab[] = ['view', 'code', 'settings'];
const isCanvasTab = (value: string | null): value is CanvasTab =>
  value !== null && (CANVAS_TABS as string[]).includes(value);

const CanvasPageView = ({ pageId }: CanvasPageViewProps) => {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const rawTab = searchParams.get('tab');
  // A stale/foreign ?tab= value (an old bookmark from before the Forms tab was
  // removed, a manually edited URL, …) must fall back to 'view' rather than
  // rendering none of the tab panels below.
  const activeTab = isCanvasTab(rawTab) ? rawTab : 'view';
  const setActiveTab = useCallback((tab: CanvasTab) => {
    const params = new URLSearchParams(searchParams.toString());
    if (tab === 'view') {
      params.delete('tab');
    } else {
      params.set('tab', tab);
    }
    // Switching top-level tab always leaves any settings category behind.
    params.delete('category');
    const qs = params.toString();
    router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
  }, [searchParams, pathname, router]);

  const [isPreviewOpen, setIsPreviewOpen] = useState(false);
  const closePreview = useCallback(() => setIsPreviewOpen(false), []);
  const containerRef = useRef<HTMLDivElement>(null);
  const hasInitializedRef = useRef(false);
  const isDirtyRef = useRef(false);
  const socket = useSocket();
  // Distinguishes this mount from any other simultaneous mount of the SAME
  // page (main center panel vs. an agent-session pane) — see DocumentView's
  // identical fix for why the key must not be pageId alone.
  const instanceId = useId();

  // Mirrors published_pages.themeBridgeEnabled so the View tab's live preview
  // matches what publishing produces. Shared with the header's
  // PublishControls and the Settings tab's Appearance category via
  // usePublishStatusStore — a save from either surface updates this
  // immediately, no callback prop needed.
  const fetchPublishStatus = usePublishStatusStore((s) => s.fetchStatus);
  const themeBridgeEnabled = usePublishStatusStore(
    (s) => s.statuses.get(pageId)?.settings.themeBridgeEnabled ?? true
  );
  useEffect(() => {
    fetchPublishStatus(pageId);
  }, [pageId, fetchPublishStatus]);

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
    const componentId = `canvas-${pageId}-${instanceId}`;

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
  }, [documentState?.isDirty, pageId, instanceId]);

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

  // Generic content read/write for the Forms settings category, which owns
  // all the <form> tag detection/wiring/deletion logic itself
  // (parse-form-tags.ts, @pagespace/lib/forms/form-html + embed-html) —
  // CanvasPageView just needs to persist whatever it decides the new content
  // should be.
  const handleFormsTabContentChange = useCallback((value: string) => {
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
          className={`px-4 py-2 ${activeTab === 'view' ? 'border-b-2 border-blue-500' : ''}`}
          onClick={() => setActiveTab('view')}
        >
          View
        </button>
        <button
          className={`px-4 py-2 ${activeTab === 'code' ? 'border-b-2 border-blue-500' : ''}`}
          onClick={() => setActiveTab('code')}
        >
          Code
        </button>
        <button
          className={`px-4 py-2 ${activeTab === 'settings' ? 'border-b-2 border-blue-500' : ''}`}
          onClick={() => setActiveTab('settings')}
        >
          Settings
        </button>
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
        <div className="relative flex-1 w-full bg-background text-foreground">
          <button
            type="button"
            title="Fullscreen preview"
            aria-label="Fullscreen preview"
            onClick={() => setIsPreviewOpen(true)}
            className="absolute top-2 right-2 z-10 rounded-md bg-background/70 p-1.5 text-muted-foreground backdrop-blur-sm hover:bg-background hover:text-foreground"
          >
            <Maximize2 className="h-4 w-4" />
          </button>
          {!isPreviewOpen && (
            <ErrorBoundary>
              <CanvasFrame html={content} themeBridgeEnabled={themeBridgeEnabled} />
            </ErrorBoundary>
          )}
        </div>
      )}
      {activeTab === 'settings' && (
        <div className="flex-1 min-h-0 overflow-y-auto">
          <CanvasSettingsPanel
            pageId={pageId}
            content={content}
            onContentChange={handleFormsTabContentChange}
          />
        </div>
      )}

      <Dialog open={isPreviewOpen} onOpenChange={setIsPreviewOpen}>
        <DialogContent
          showCloseButton
          className="w-screen h-screen max-w-none max-h-none p-0 gap-0 rounded-none border-0 sm:max-w-none"
        >
          <DialogTitle className="sr-only">Canvas preview</DialogTitle>
          <ErrorBoundary>
            <CanvasFrame html={content} title="Canvas preview" themeBridgeEnabled={themeBridgeEnabled} onEscape={closePreview} />
          </ErrorBoundary>
        </DialogContent>
      </Dialog>

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
