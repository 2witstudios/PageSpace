"use client";

import React, { useEffect, useState, useCallback, useRef } from 'react';
import { toast } from 'sonner';
import dynamic from 'next/dynamic';
import useSWR from 'swr';
import Sandbox from '@/components/sandbox/Sandbox';
import PreviewErrorBoundary from '@/components/sandbox/PreviewErrorBoundary';
import { useDocumentStore } from '@/stores/useDocumentStore';

const MonacoEditor = dynamic(() => import('@/components/editors/MonacoEditor'), { ssr: false });

const fetcher = (url: string) => fetch(url).then(res => res.json());

const UserDashboardView = () => {
  const { data: dashboard, error, mutate } = useSWR('/api/user/dashboard', fetcher);
  const { content, setContent, setDocument, setSaveCallback } = useDocumentStore();
  const [activeTab, setActiveTab] = useState('view');
  const containerRef = useRef<HTMLDivElement>(null);

  const saveContent = useCallback(async (userId: string, newValue: string) => {
    try {
      const response = await fetch(`/api/user/dashboard`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: newValue }),
      });
      if (!response.ok) {
        throw new Error(`Failed to save dashboard content. Status: ${response.status}`);
      }
      toast.success('Dashboard saved successfully!');
      mutate(); // Re-fetch the data to update the view
    } catch (error) {
      console.error('Failed to save dashboard content:', error);
      toast.error('Failed to save dashboard content.');
    }
  }, [mutate]);

  useEffect(() => {
    if (dashboard) {
      const initialText = typeof dashboard.content === 'string' ? dashboard.content : '';
      setDocument(dashboard.userId, initialText);
      setSaveCallback(saveContent);
    }
  }, [dashboard, setDocument, setSaveCallback, saveContent]);

  if (error) return <div>Failed to load dashboard</div>;
  if (!dashboard) return <div>Loading...</div>;

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
              <Sandbox html={content} />
            </PreviewErrorBoundary>
          </div>
        )}
      </div>
    </div>
  );
};

export default UserDashboardView;