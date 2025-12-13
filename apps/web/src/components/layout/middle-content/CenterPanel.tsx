"use client";

import { useParams, usePathname } from 'next/navigation';
import { Skeleton } from "@/components/ui/skeleton";
import { ViewHeader } from './content-header';
import { usePageTree, TreePage } from '@/hooks/usePageTree';
import { findNodeAndParent } from '@/lib/tree/tree-utils';
import FolderView from './page-views/folder/FolderView';
import AiChatView from './page-views/ai-page/AiChatView';
import ChannelView from './page-views/channel/ChannelView';
import DocumentView from './page-views/document/DocumentView';
import FileViewer from './page-views/file/FileViewer';
import SheetView from './page-views/sheet/SheetView';
import TaskListView from './page-views/task-list/TaskListView';
import { CustomScrollArea } from '@/components/ui/custom-scroll-area';
import { getPageTypeComponent } from '@pagespace/lib/client-safe';
import AiSettingsView from './page-views/settings/ai-api/AiSettingsView';
import MCPSettingsView from './page-views/settings/mcp/MCPSettingsView';
import CanvasPageView from './page-views/canvas/CanvasPageView';
import GlobalAssistantView from './page-views/dashboard/GlobalAssistantView';
import { memo, useState, useEffect } from 'react';
import { useLayoutStore } from '@/stores/useLayoutStore';
import { cn } from '@/lib/utils';

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

  // Dynamic component selection using centralized config
  const componentMap = {
    FolderView,
    AiChatView,
    ChannelView,
    DocumentView,
    CanvasPageView,
    FileViewer,
    SheetView,
    TaskListView,
  };
  
  const componentName = getPageTypeComponent(page.type);
  const ViewComponent = componentMap[componentName as keyof typeof componentMap];

  // DocumentView uses pageId-only pattern for stability
  // Other components still use full page object (to be migrated)
  let pageComponent: React.ReactNode;
  if (!ViewComponent) {
    pageComponent = (
      <div className="p-4 text-center text-muted-foreground">
        This page type is not supported.
      </div>
    );
  } else if (componentName === 'DocumentView') {
    // DocumentView accepts only pageId (new pattern)
    pageComponent = <DocumentView pageId={page.id} />;
  } else {
    // Other components still accept full page object
    // Type assertion: we've excluded DocumentView above, so ViewComponent here
    // is one of the components that accepts { page: TreePage }
    const Component = ViewComponent as React.ComponentType<{ page: TreePage }>;
    pageComponent = <Component page={page} />;
  }

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

  // Determine visibility states
  const isSettingsRoute = pathname.endsWith('/settings') || pathname.endsWith('/settings/mcp');
  const showGlobalAssistant = !activePageId && !isSettingsRoute;
  const showPageContent = activePageId || isSettingsRoute;

  // Track if GlobalAssistantView has ever been rendered (lazy mount, then persist)
  // This ensures we don't mount it until the user visits dashboard, but once mounted it stays
  const [hasRenderedGlobalAssistant, setHasRenderedGlobalAssistant] = useState(false);

  useEffect(() => {
    if (showGlobalAssistant && !hasRenderedGlobalAssistant) {
      setHasRenderedGlobalAssistant(true);
    }
  }, [showGlobalAssistant, hasRenderedGlobalAssistant]);

  return (
    <div className="h-full flex flex-col relative">
      {/* GlobalAssistantView - mount once on first dashboard visit, never unmount */}
      {hasRenderedGlobalAssistant && (
        <div
          className={cn(
            "absolute inset-0 z-10",
            showGlobalAssistant ? "flex flex-col" : "hidden pointer-events-none"
          )}
          aria-hidden={!showGlobalAssistant}
        >
          <GlobalAssistantView />
        </div>
      )}

      {/* PageContent - renders when viewing a page or settings */}
      {showPageContent && (
        <div className="h-full flex flex-col z-10">
          <OptimizedViewHeader />
          <div className="flex-1 min-h-0 relative overflow-hidden">
            <CustomScrollArea className="h-full">
              <PageContent pageId={activePageId} />
            </CustomScrollArea>
          </div>
        </div>
      )}
    </div>
  );
}