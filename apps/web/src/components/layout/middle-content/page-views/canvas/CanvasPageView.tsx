"use client";

import React, { useEffect, useState, useCallback, useRef } from 'react';
import { toast } from 'sonner';
import dynamic from 'next/dynamic';
import Sandbox from '@/components/sandbox/Sandbox';
import PreviewErrorBoundary from '@/components/sandbox/PreviewErrorBoundary';
import { TreePage } from '@/hooks/usePageTree';
import { useDocumentStore } from '@/stores/useDocumentStore';

interface CanvasPageViewProps {
  page: TreePage;
}

const MonacoEditor = dynamic(() => import('@/components/editors/MonacoEditor'), { ssr: false });

const CanvasPageView = ({ page }: CanvasPageViewProps) => {
  const { content, setContent, setDocument, setSaveCallback } = useDocumentStore();
  const [activeTab, setActiveTab] = useState('view');
  const containerRef = useRef<HTMLDivElement>(null);

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

export default CanvasPageView;