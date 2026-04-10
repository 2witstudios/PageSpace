"use client";

import React, { useEffect, useState, useCallback, useRef } from 'react';
import { toast } from 'sonner';
import { fetchWithAuth } from '@/lib/auth/auth-fetch';
import dynamic from 'next/dynamic';
import { useRouter } from 'next/navigation';
import { ShadowCanvas } from '@/components/canvas/ShadowCanvas';
import { ErrorBoundary } from '@/components/ai/shared';
import { useDocument } from '@/hooks/useDocument';
import { useEditingStore } from '@/stores/useEditingStore';
import { useAuth } from '@/hooks/useAuth';
import { useSocket } from '@/hooks/useSocket';
import { PageEventPayload } from '@/lib/websocket';
import { openExternalUrl } from '@/lib/navigation/app-navigation';

interface CanvasPageViewProps {
  pageId: string;
}

const MonacoEditor = dynamic(() => import('@/components/editors/MonacoEditor'), { ssr: false });

const CanvasPageView = ({ pageId }: CanvasPageViewProps) => {
  const [activeTab, setActiveTab] = useState('view');
  const containerRef = useRef<HTMLDivElement>(null);
  const hasInitializedRef = useRef(false);
  const isDirtyRef = useRef(false);
  const router = useRouter();
  const { user } = useAuth();
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
            if (!documentState?.isDirty) {
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
  }, [socket, pageId, documentState?.isDirty, updateContentFromServer]);

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

  const handleNavigation = useCallback(async (url: string, isExternal: boolean) => {
    if (!url) return;

    if (isExternal) {
      const confirmed = window.confirm(`Navigate to external site?\n\n${url}`);
      if (confirmed) {
        await openExternalUrl(url);
      }
      return;
    }

    const dashboardMatch = url.match(/^\/dashboard\/([^\/]+)\/([^\/]+)$/);
    if (dashboardMatch) {
      const [, , targetPageId] = dashboardMatch;
      if (user && targetPageId) {
        try {
          const response = await fetchWithAuth(`/api/pages/${targetPageId}/permissions/check`);
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
            onChange={handleContentChange}
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
