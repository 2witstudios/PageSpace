"use client";

import { useParams } from 'next/navigation';
import { Skeleton } from "@/components/ui/skeleton";
import { ViewHeader } from './content-header';
import { usePageTree, TreePage } from '@/hooks/usePageTree';
import { findNodeAndParent } from '@/lib/tree/tree-utils';
import FolderView from './page-views/folder/FolderView';
import AiChatView from './page-views/ai-page/AiChatView';
import ChannelView from './page-views/channel/ChannelView';
import DocumentView from './page-views/document/DocumentView';
import FileViewer from './page-views/file/FileViewer';
import { CustomScrollArea } from '@/components/ui/custom-scroll-area';
import { getPageTypeComponent } from '@pagespace/lib/client-safe';
import CanvasPageView from './page-views/canvas/CanvasPageView';
import GlobalAssistantView from './page-views/dashboard/GlobalAssistantView';
import SheetView from './page-views/sheet/SheetView';
import TaskListView from './page-views/task-list/TaskListView';


const PageContent = ({ pageId }: { pageId: string | null }) => {
  const params = useParams();
  const driveId = params.driveId as string;
  const { tree, isLoading } = usePageTree(driveId);

  if (isLoading) {
    return <Skeleton className="h-full w-full" />;
  }

  if (!pageId) {
    return <div className="p-4">Select a page to view its content.</div>;
  }

  const pageResult = findNodeAndParent(tree, pageId);

  if (!pageResult) {
    return <div className="p-4">Page not found in the current tree.</div>;
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

  if (!ViewComponent) {
    return <div className="p-4">This page type is not supported.</div>;
  }

  // DocumentView uses pageId-only pattern for stability
  // Other components still use full page object (to be migrated)
  if (componentName === 'DocumentView') {
    return <DocumentView key={page.id} pageId={page.id} />;
  }

  // Other components still accept full page object
  const Component = ViewComponent as React.ComponentType<{ page: TreePage }>;
  return <Component key={page.id} page={page} />;
};

export default function CenterPanel() {
    const params = useParams();
    const { pageId } = params;

  return (
    <div className="h-full flex flex-col bg-transparent">
        {pageId ? (
            <>
              <ViewHeader />
              <CustomScrollArea className="flex-1">
                <PageContent pageId={pageId as string} />
              </CustomScrollArea>
            </>
        ) : (
          <GlobalAssistantView />
        )}
    </div>
  );
}