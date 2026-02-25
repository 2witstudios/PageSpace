"use client";

import React, { useEffect, useState, useCallback, useRef } from 'react';
import { toast } from 'sonner';
import { patch, fetchWithAuth } from '@/lib/auth/auth-fetch';
import dynamic from 'next/dynamic';
import { useRouter } from 'next/navigation';
import { ShadowCanvas } from '@/components/canvas/ShadowCanvas';
import { ErrorBoundary } from '@/components/ai/shared';
import { TreePage } from '@/hooks/usePageTree';
import { useDocumentManagerStore } from '@/stores/useDocumentManagerStore';
import { useEditingStore } from '@/stores/useEditingStore';
import { useAuth } from '@/hooks/useAuth';
import { useSocket } from '@/hooks/useSocket';
import { PageEventPayload } from '@/lib/websocket';
import { openExternalUrl } from '@/lib/navigation/app-navigation';

interface CanvasPageViewProps {
  page: TreePage;
}

const MonacoEditor = dynamic(() => import('@/components/editors/MonacoEditor'), { ssr: false });

const CanvasPageView = ({ page }: CanvasPageViewProps) => {
  const documentState = useDocumentManagerStore((state) => state.documents.get(page.id));
  const content = documentState?.content ?? '';
  const [activeTab, setActiveTab] = useState('view');
  const containerRef = useRef<HTMLDivElement>(null);
  const saveTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const saveVersionRef = useRef(0);
  const router = useRouter();
  const { user } = useAuth();
  const socket = useSocket();

  const saveContent = useCallback(async (pageId: string, newValue: string) => {
    try {
      const headers: Record<string, string> = {};
      if (socket?.id) {
        headers['X-Socket-ID'] = socket.id;
      }
      await patch(`/api/pages/${pageId}`, { content: newValue }, { headers });
    } catch (error) {
      console.error('Failed to save page content:', error);
      toast.error('Failed to save page content.');
      throw error;
    }
  }, [socket]);

  // Keep refs in sync for unmount cleanup (avoids stale closures in empty-deps effects)
  const saveContentRef = useRef(saveContent);
  const pageIdRef = useRef(page.id);
  useEffect(() => { saveContentRef.current = saveContent; }, [saveContent]);
  useEffect(() => { pageIdRef.current = page.id; }, [page.id]);

  const setContent = useCallback((newContent: string) => {
    const version = ++saveVersionRef.current;
    useDocumentManagerStore.getState().updateDocument(page.id, {
      content: newContent,
      isDirty: true,
      lastUpdateTime: Date.now(),
    });

    if (saveTimeoutRef.current) {
      clearTimeout(saveTimeoutRef.current);
    }
    saveTimeoutRef.current = setTimeout(async () => {
      try {
        await saveContent(page.id, newContent);
        // Only clear isDirty if no newer edits arrived while saving
        if (saveVersionRef.current === version) {
          useDocumentManagerStore.getState().updateDocument(page.id, {
            isDirty: false,
            lastSaved: Date.now(),
          });
        }
      } catch {
        // saveContent already logged and toasted - isDirty stays true for retry/unmount-save
      }
    }, 1000);
  }, [page.id, saveContent]);

  const updateContentFromServer = useCallback((newContent: string) => {
    if (saveTimeoutRef.current) {
      clearTimeout(saveTimeoutRef.current);
      saveTimeoutRef.current = null;
    }
    useDocumentManagerStore.getState().updateDocument(page.id, {
      content: newContent,
      isDirty: false,
      lastSaved: Date.now(),
      lastUpdateTime: Date.now(),
    });
  }, [page.id]);

  // Initialize or refresh document in manager store
  useEffect(() => {
    const initialText = typeof page.content === 'string' ? page.content : '';
    const store = useDocumentManagerStore.getState();
    const existing = store.getDocument(page.id);
    if (!existing) {
      store.createDocument(page.id, initialText, 'html');
    } else if (!existing.isDirty && existing.content !== initialText) {
      // Refresh from prop if doc exists but isn't dirty (e.g. out-of-band server update)
      store.updateDocument(page.id, {
        content: initialText,
        lastUpdateTime: Date.now(),
      });
    }
  }, [page.id, page.content]);

  // Register editing state to prevent SWR revalidation during edits
  useEffect(() => {
    if (documentState?.isDirty) {
      useEditingStore.getState().startEditing(page.id, 'document');
    } else {
      useEditingStore.getState().endEditing(page.id);
    }
    return () => useEditingStore.getState().endEditing(page.id);
  }, [documentState?.isDirty, page.id]);

  // Force-save on unmount and clean up cached document
  // Empty deps — parent renders with key={page.id} so this only runs on TRUE unmount
  useEffect(() => {
    return () => {
      if (saveTimeoutRef.current) {
        clearTimeout(saveTimeoutRef.current);
      }
      const id = pageIdRef.current;
      const store = useDocumentManagerStore.getState();
      const doc = store.getDocument(id);
      if (doc?.isDirty) {
        saveContentRef.current(id, doc.content).catch(console.error);
      }
      store.clearDocument(id);
      useEditingStore.getState().endEditing(id);
    };
  }, []);

  // Listen for real-time content updates from AI tools
  useEffect(() => {
    if (!socket) return;

    const handleContentUpdate = async (eventData: PageEventPayload) => {
      // Filter out self-triggered events
      if (eventData.socketId && eventData.socketId === socket.id) {
        return;
      }

      // Only update if it's for the current page
      if (eventData.pageId === page.id) {
        console.log(`[Canvas] Received content update for page ${page.id}`);

        // Fetch fresh content
        try {
          const response = await fetchWithAuth(`/api/pages/${page.id}`);
          if (response.ok) {
            const updatedPage = await response.json();
            const newContent = typeof updatedPage.content === 'string' ? updatedPage.content : '';
            // Use updateContentFromServer to avoid triggering auto-save loop
            updateContentFromServer(newContent);
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
  }, [socket, page.id, updateContentFromServer]);

  const handleNavigation = useCallback(async (url: string, isExternal: boolean) => {
    if (!url) return;

    // Handle external URLs - uses Capacitor Browser on mobile (Safari View Controller)
    if (isExternal) {
      const confirmed = window.confirm(`Navigate to external site?\n\n${url}`);
      if (confirmed) {
        await openExternalUrl(url);
      }
      return;
    }


    // Handle standard dashboard URLs
    const dashboardMatch = url.match(/^\/dashboard\/([^\/]+)\/([^\/]+)$/);
    if (dashboardMatch) {
      const [, , pageId] = dashboardMatch;
      if (user && pageId) {
        try {
          const response = await fetchWithAuth(`/api/pages/${pageId}/permissions/check`);
          if (response.ok) {
            const permissions = await response.json();
            if (!permissions.canView) {
              toast.error('You do not have permission to view this page');
              return;
            }
          } else {
            toast.error('Failed to verify page permissions');
            return;
          }
        } catch (error) {
          console.error('Error checking permissions:', error);
          toast.error('Failed to verify page permissions');
          return;
        }
      }
      router.push(url);
      return;
    }

    // Handle other internal routes
    if (url.startsWith('/')) {
      router.push(url);
    } else {
      toast.error('Invalid navigation URL');
    }
  }, [router, user]);

  return (
    <div ref={containerRef} className="h-full flex flex-col relative">
      <div className="flex border-b">
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
      </div>
      {activeTab === 'code' && (
        <div className="flex-1 min-h-0">
          <MonacoEditor
            value={content}
            onChange={(newValue) => setContent(newValue || '')}
            language="html"
          />
        </div>
      )}
      {activeTab === 'view' && (
        <div className="flex-1 w-full bg-background text-foreground">
          <ErrorBoundary>
            <ShadowCanvas html={content} onNavigate={handleNavigation} />
          </ErrorBoundary>
        </div>
      )}
    </div>
  );
};

export default React.memo(
  CanvasPageView,
  (prevProps, nextProps) =>
    prevProps.page.id === nextProps.page.id &&
    prevProps.page.content === nextProps.page.content
);
