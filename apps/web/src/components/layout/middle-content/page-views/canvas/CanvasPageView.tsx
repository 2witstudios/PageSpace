"use client";

import React, { useEffect, useState, useCallback, useRef } from 'react';
import { toast } from 'sonner';
import dynamic from 'next/dynamic';
import { useRouter, useParams } from 'next/navigation';
import { ShadowCanvas } from '@/components/canvas/ShadowCanvas';
import PreviewErrorBoundary from '@/components/sandbox/PreviewErrorBoundary';
import { TreePage } from '@/hooks/usePageTree';
import { useDocumentStore } from '@/stores/useDocumentStore';
import { getUserAccessLevel } from '@pagespace/lib';
import { useAuth } from '@/hooks/use-auth';

interface CanvasPageViewProps {
  page: TreePage;
}

const MonacoEditor = dynamic(() => import('@/components/editors/MonacoEditor'), { ssr: false });

const CanvasPageView = ({ page }: CanvasPageViewProps) => {
  const { content, setContent, setDocument, setSaveCallback } = useDocumentStore();
  const [activeTab, setActiveTab] = useState('view');
  const containerRef = useRef<HTMLDivElement>(null);
  const router = useRouter();
  const params = useParams();
  const { user } = useAuth();
  const currentDriveId = params.driveId as string;

  const saveContent = useCallback(async (pageId: string, newValue: string) => {
    console.log(`--- Saving Page ${pageId} ---`);
    console.log('Content:', newValue);
    try {
      const response = await fetch(`/api/pages/${pageId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: newValue }),
      });
      console.log('Save Response:', response);
      if (!response.ok) {
        throw new Error(`Failed to save page content. Status: ${response.status}`);
      }
      toast.success('Page saved successfully!');
    } catch (error) {
      console.error('Failed to save page content:', error);
      toast.error('Failed to save page content.');
    }
  }, []);

  useEffect(() => {
    const initialText = typeof page.content === 'string' ? page.content : '';
    setDocument(page.id, initialText);
    setSaveCallback(saveContent);
  }, [page.id, page.content, setDocument, setSaveCallback, saveContent]);

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

    // Handle PageSpace protocol
    if (url.startsWith('pagespace://page/')) {
      const pageId = url.replace('pagespace://page/', '');
      if (user) {
        try {
          const accessLevel = await getUserAccessLevel(user.id, pageId);
          if (!accessLevel || !accessLevel.canView) {
            toast.error('You do not have permission to view this page');
            return;
          }
        } catch (error) {
          console.error('Error checking permissions:', error);
          toast.error('Failed to verify page permissions');
          return;
        }
      }
      router.push(`/dashboard/${currentDriveId}/${pageId}`);
      return;
    }

    // Handle standard dashboard URLs
    const dashboardMatch = url.match(/^\/dashboard\/([^\/]+)\/([^\/]+)$/);
    if (dashboardMatch) {
      const [, , pageId] = dashboardMatch;
      if (user && pageId) {
        try {
          const accessLevel = await getUserAccessLevel(user.id, pageId);
          if (!accessLevel || !accessLevel.canView) {
            toast.error('You do not have permission to view this page');
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
  }, [router, currentDriveId, user]);

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
            <PreviewErrorBoundary>
              <ShadowCanvas html={content} onNavigate={handleNavigation} />
            </PreviewErrorBoundary>
          </div>
        )}
      </div>
    </div>
  );
};

export default CanvasPageView;