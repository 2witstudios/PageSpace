"use client";

import React, { useEffect, useState, useCallback, useRef } from 'react';
import { toast } from 'sonner';
import { patch, fetchWithAuth } from '@/lib/auth/auth-fetch';
import dynamic from 'next/dynamic';
import { useRouter } from 'next/navigation';
import { ShadowCanvas } from '@/components/canvas/ShadowCanvas';
import { ErrorBoundary } from '@/components/ai/shared';
import { TreePage } from '@/hooks/usePageTree';
import { useDocumentStore } from '@/stores/useDocumentStore';
import { useAuth } from '@/hooks/useAuth';
import { useSocket } from '@/hooks/useSocket';
import { PageEventPayload } from '@/lib/websocket';

interface CanvasPageViewProps {
  page: TreePage;
}

const MonacoEditor = dynamic(() => import('@/components/editors/MonacoEditor'), { ssr: false });

const CanvasPageView = ({ page }: CanvasPageViewProps) => {
  const { content, setContent, updateContentFromServer, setDocument, setSaveCallback } = useDocumentStore();
  const [activeTab, setActiveTab] = useState('view');
  const containerRef = useRef<HTMLDivElement>(null);
  const router = useRouter();
  const { user } = useAuth();
  const socket = useSocket();

  const saveContent = useCallback(async (pageId: string, newValue: string) => {
    console.log(`--- Saving Page ${pageId} ---`);
    console.log('Content:', newValue);
    try {
      // Include socket ID so server can exclude this client from broadcast
      const headers: Record<string, string> = {};
      if (socket?.id) {
        headers['X-Socket-ID'] = socket.id;
      }
      await patch(`/api/pages/${pageId}`, { content: newValue }, { headers });
      console.log('Save successful');
      toast.success('Page saved successfully!');
    } catch (error) {
      console.error('Failed to save page content:', error);
      toast.error('Failed to save page content.');
    }
  }, [socket]);

  useEffect(() => {
    const initialText = typeof page.content === 'string' ? page.content : '';
    setDocument(page.id, initialText);
    setSaveCallback(saveContent);
  }, [page.id, page.content, setDocument, setSaveCallback, saveContent]);

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
            toast.success('Canvas updated');
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

    // Handle external URLs
    if (isExternal) {
      const confirmed = window.confirm(`Navigate to external site?\n\n${url}`);
      if (confirmed) {
        window.open(url, '_blank', 'noopener,noreferrer');
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
      <div className="flex-1 flex justify-center items-start p-4 overflow-auto">
        {activeTab === 'code' && (
          <MonacoEditor
            value={content}
            onChange={(newValue) => setContent(newValue || '')}
            language="html"
          />
        )}
        {activeTab === 'view' && (
          <div className="w-full h-full bg-background text-foreground">
            <ErrorBoundary>
              <ShadowCanvas html={content} onNavigate={handleNavigation} />
            </ErrorBoundary>
          </div>
        )}
      </div>
    </div>
  );
};

export default CanvasPageView;