'use client';

/**
 * A `'page'` pane's content: any non-container, non-chat page type rendered
 * with the SAME view component the main content area uses
 * (`CenterPanel.tsx`'s `PageContent`), so a document/task-list/sheet/etc. is
 * exactly as editable in a pane as it is in the center panel.
 *
 * Deliberately NOT built on `usePageTree` — a pane has no reason to load the
 * whole drive's tree just to look up one page. It fetches the page directly
 * (`/api/pages/{pageId}`), the same fallback fetch `CenterPanel` already uses
 * when a page isn't in the loaded tree. Access control is enforced entirely
 * by that fetch and by each view's own data hooks — this component adds no
 * permission check of its own, so an inaccessible pageId (including one an
 * agent supplied via `open_page_pane`) just renders the permission-denied
 * message below rather than leaking anything.
 */

import { AlertCircle } from 'lucide-react';
import dynamic from 'next/dynamic';
import useSWR from 'swr';
import { getPageTypeComponent, isPaneablePageType } from '@pagespace/lib/content/page-types.config';
import { fetchWithAuth } from '@/lib/auth/auth-fetch';
import type { TreePage } from '@/hooks/usePageTree';
import { Skeleton } from '@/components/ui/skeleton';

export interface PagePaneViewProps {
  pageId: string;
  /** The session's drive, for DocumentView's cross-drive socket scoping. Null for a global-assistant session. */
  driveId: string | null;
}

// Lazily loaded, same as DocumentView's own MonacoEditor/RichEditor split —
// a pane is a secondary surface, and FileViewer alone pulls in pdfjs-dist
// (heavy, browser-only). Pane-safe views only: no FolderView (a tree browser,
// not content) and no AgentPageView (would nest a chat conversation inside a
// chat pane). `isPaneablePageType` is the same exclusion the picker's search
// applies.
const componentMap = {
  DocumentView: dynamic(() => import('@/components/layout/middle-content/page-views/document/DocumentView'), { ssr: false }),
  CodePageView: dynamic(() => import('@/components/layout/middle-content/page-views/code/CodePageView'), { ssr: false }),
  CanvasPageView: dynamic(() => import('@/components/layout/middle-content/page-views/canvas/CanvasPageView'), { ssr: false }),
  ChannelView: dynamic(() => import('@/components/layout/middle-content/page-views/channel/ChannelView'), { ssr: false }),
  FileViewer: dynamic(() => import('@/components/layout/middle-content/page-views/file/FileViewer'), { ssr: false }),
  SheetView: dynamic(() => import('@/components/layout/middle-content/page-views/sheet/SheetView'), { ssr: false }),
  TaskListView: dynamic(() => import('@/components/layout/middle-content/page-views/task-list/TaskListView'), { ssr: false }),
};

async function fetcher(url: string): Promise<TreePage> {
  const response = await fetchWithAuth(url);
  if (!response.ok) {
    const body = await response.json().catch(() => null);
    throw new Error(body?.error ?? `Failed to load this page (${response.status})`);
  }
  const page = await response.json();
  // The single-page fetch omits `aiChat` (only the tree endpoint's shape
  // carries it) — patched the same way CenterPanel's own fallback fetch does.
  return { ...page, aiChat: null };
}

export default function PagePaneView({ pageId, driveId }: PagePaneViewProps) {
  const { data: page, error, isLoading } = useSWR<TreePage>(`/api/pages/${pageId}`, fetcher);

  if (isLoading) {
    return <Skeleton className="h-full w-full" />;
  }

  if (error || !page) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 p-4 text-center text-muted-foreground">
        <AlertCircle className="h-8 w-8" />
        <p className="text-sm">{error instanceof Error ? error.message : 'This page could not be loaded.'}</p>
      </div>
    );
  }

  if (!isPaneablePageType(page.type)) {
    return (
      <div className="flex h-full items-center justify-center p-4 text-center text-sm text-muted-foreground">
        This page type can&apos;t be opened in a pane.
      </div>
    );
  }

  const componentName = getPageTypeComponent(page.type);
  const ViewComponent = componentMap[componentName as keyof typeof componentMap];

  if (!ViewComponent) {
    return (
      <div className="flex h-full items-center justify-center p-4 text-center text-sm text-muted-foreground">
        This page type isn&apos;t supported in a pane.
      </div>
    );
  }

  // Same calling-convention split as CenterPanel.tsx's PageContent: the
  // pageId-only views fetch their own data; everything else still takes the
  // full page object.
  let pageComponent: React.ReactNode;
  if (componentName === 'DocumentView') {
    const DocumentView = componentMap.DocumentView;
    pageComponent = <DocumentView key={`document-${page.id}`} pageId={page.id} driveId={driveId ?? undefined} />;
  } else if (componentName === 'CodePageView') {
    const CodePageView = componentMap.CodePageView;
    pageComponent = <CodePageView key={`code-${page.id}`} pageId={page.id} />;
  } else if (componentName === 'CanvasPageView') {
    const CanvasPageView = componentMap.CanvasPageView;
    pageComponent = <CanvasPageView key={`canvas-${page.id}`} pageId={page.id} />;
  } else {
    const Component = ViewComponent as React.ComponentType<{ page: TreePage }>;
    pageComponent = <Component key={`${componentName}-${page.id}`} page={page} />;
  }

  return <div className="h-full">{pageComponent}</div>;
}
