"use client";

import React, { Suspense, useState } from 'react';
import { FileText, Code } from 'lucide-react';
import { cn } from '@/lib/utils';
import { PageLink } from './PageLink';
import type { PageType } from '@pagespace/lib/client-safe';

// Lazy load the heavy editors
const LazyRichEditor = React.lazy(() => import('@/components/editors/RichEditor'));
const LazyMonacoEditor = React.lazy(() => import('@/components/editors/MonacoEditor'));

interface DocumentPreviewContainerProps {
  content: string;
  title: string;
  pageId?: string;
  driveId?: string;
  pageType?: PageType;
  isTaskLinked?: boolean;
  showNavigation?: boolean;
  className?: string;
}

const PreviewSkeleton: React.FC = () => (
  <div className="h-full w-full animate-pulse bg-muted/50 flex items-center justify-center">
    <div className="text-muted-foreground text-sm">Loading preview...</div>
  </div>
);

// Noop functions for read-only editor
const noop = () => {};

export const DocumentPreviewContainer: React.FC<DocumentPreviewContainerProps> = ({
  content,
  title,
  pageId,
  driveId,
  pageType = 'DOCUMENT',
  isTaskLinked,
  showNavigation = true,
  className
}) => {
  const [viewMode, setViewMode] = useState<'rich' | 'code'>('rich');

  return (
    <div
      className={cn("rounded-md border bg-card overflow-hidden", className)}
      style={{ maxWidth: 816 }}
    >
      {/* Header with title and view toggle */}
      <div className="flex items-center justify-between px-3 py-2 bg-muted/40 border-b">
        <div className="flex items-center gap-2 overflow-hidden">
          <FileText className="h-4 w-4 text-muted-foreground shrink-0" />
          <span className="font-medium text-sm truncate" title={title}>
            {title}
          </span>
        </div>
        <div className="flex items-center gap-1 shrink-0">
          <button
            onClick={() => setViewMode('rich')}
            className={cn(
              "px-2 py-1 text-xs rounded transition-colors",
              viewMode === 'rich'
                ? "bg-secondary text-secondary-foreground"
                : "hover:bg-muted text-muted-foreground"
            )}
          >
            Rich
          </button>
          <button
            onClick={() => setViewMode('code')}
            className={cn(
              "px-2 py-1 text-xs rounded transition-colors",
              viewMode === 'code'
                ? "bg-secondary text-secondary-foreground"
                : "hover:bg-muted text-muted-foreground"
            )}
          >
            <Code className="h-3 w-3 inline-block mr-1" />
            HTML
          </button>
        </div>
      </div>

      {/* Content area with lazy-loaded editor */}
      <div className="h-[400px] overflow-hidden">
        <Suspense fallback={<PreviewSkeleton />}>
          {viewMode === 'rich' ? (
            <LazyRichEditor
              value={content}
              readOnly
              onChange={noop}
              onEditorChange={noop}
            />
          ) : (
            <LazyMonacoEditor
              value={content}
              readOnly
              language="html"
              onChange={noop}
            />
          )}
        </Suspense>
      </div>

      {/* Footer with navigation */}
      {showNavigation && pageId && driveId && (
        <div className="px-3 py-2 border-t bg-muted/20">
          <PageLink
            pageId={pageId}
            driveId={driveId}
            title={title}
            type={pageType}
            isTaskLinked={isTaskLinked}
          />
        </div>
      )}
    </div>
  );
};
