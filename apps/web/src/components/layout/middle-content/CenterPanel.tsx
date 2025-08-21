"use client";

import { useParams, usePathname } from 'next/navigation';
import { Skeleton } from "@/components/ui/skeleton";
import { ViewHeader } from './content-header';
import { usePageTree } from '@/hooks/usePageTree';
import { findNodeAndParent } from '@/lib/tree/tree-utils';
import FolderView from './page-views/folder/FolderView';
import AiChatView from './page-views/ai-page/AiChatView';
import ChannelView from './page-views/channel/ChannelView';
import DocumentView from './page-views/document/DocumentView';
import { CustomScrollArea } from '@/components/ui/custom-scroll-area';
import { PageType } from '@pagespace/lib/client';
import AiSettingsView from './page-views/settings/ai-api/AiSettingsView';
import MCPSettingsView from './page-views/settings/mcp/MCPSettingsView';
import CanvasPageView from './page-views/canvas/CanvasPageView';
import GlobalAssistantView from './page-views/dashboard/GlobalAssistantView';
import { memo } from 'react';
import { useLayoutStore } from '@/stores/useLayoutStore';

// Memoized page content component to prevent unnecessary re-renders
const PageContent = memo(({ pageId }: { pageId: string | null }) => {
  const params = useParams();
  const pathname = usePathname();
  const driveId = params.driveId as string;
  const { tree, isLoading } = usePageTree(driveId);

  // Handle special routes
  if (pathname.endsWith('/settings')) {
    return <AiSettingsView />;
  }

  if (pathname.endsWith('/settings/mcp')) {
    return <MCPSettingsView />;
  }

  if (isLoading) {
    return <Skeleton className="h-full w-full" />;
  }

  if (!pageId) {
    return (
      <div className="p-4 text-center text-muted-foreground">
        Select a page to view its content.
      </div>
    );
  }

  const pageResult = findNodeAndParent(tree, pageId);

  if (!pageResult) {
    return (
      <div className="p-4 text-center text-muted-foreground">
        Page not found in the current tree.
      </div>
    );
  }
  
  const { node: page } = pageResult;

  // Show cached content immediately if available, then update with fresh data - moved outside conditional
  const pageComponent = (() => {
    switch (page.type) {
      case PageType.FOLDER:
        return <FolderView key={page.id} page={page} />;
      case PageType.AI_CHAT:
        return <AiChatView key={page.id} page={page} />;
      case PageType.CHANNEL:
        return <ChannelView key={page.id} page={page} />;
      case PageType.DOCUMENT:
        return <DocumentView key={page.id} page={page} />;
      case PageType.CANVAS:
        return <CanvasPageView key={page.id} page={page} />;
      default:
        return (
          <div className="p-4 text-center text-muted-foreground">
            This page type is not supported.
          </div>
        );
    }
  })();

  return (
    <div key={pageId} className="h-full transition-opacity duration-150">
      {pageComponent}
    </div>
  );
}, (prevProps, nextProps) => {
  // Only re-render if pageId actually changes
  return prevProps.pageId === nextProps.pageId;
});

PageContent.displayName = 'PageContent';

// Optimized header component
const OptimizedViewHeader = memo(() => {
  const layoutStore = useLayoutStore();
  const pathname = usePathname();
  
  // Only show header when we have a page or are on special routes
  const shouldShowHeader = layoutStore.activePageId || 
                          pathname.endsWith('/settings') || 
                          pathname.endsWith('/settings/mcp');
  
  if (!shouldShowHeader) {
    return null;
  }
  
  return (
    <div className="transition-opacity duration-150">
      <ViewHeader />
    </div>
  );
});

OptimizedViewHeader.displayName = 'OptimizedViewHeader';

export default function CenterPanel() {
  const params = useParams();
  const pathname = usePathname();
  const activePageId = params.pageId as string || null;

  return (
    <div className="h-full flex flex-col relative">
      {/* Main content area */}
      {activePageId || pathname.endsWith('/settings') || pathname.endsWith('/settings/mcp') ? (
        <>
          <OptimizedViewHeader />
          <div className="flex-1 min-h-0 relative overflow-hidden">
            <CustomScrollArea className="h-full">
              <PageContent pageId={activePageId} />
            </CustomScrollArea>
          </div>
        </>
      ) : (
        <div key="dashboard" className="h-full transition-opacity duration-200">
          <GlobalAssistantView />
        </div>
      )}
    </div>
  );
}