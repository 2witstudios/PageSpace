'use client';

import type { ReactNode } from 'react';
import { renderObjectPlaceholder } from '../../frame/shell/object-placeholder';
import { type DocumentPage } from '../document-view/document-view';
import { usePage } from '../page-object/page-object';
import dynamic from 'next/dynamic';
import type { TreePage } from '@/retained/hooks/usePageTree';
import { RetainedSurface } from '@/retained-adapters/retained-provider';
import { ViewHeader } from '@/retained/components/layout/middle-content/content-header';
import { PageHistory } from '@/retained-adapters/page-history';
import { AgentSettings } from '@/retained-adapters/agent-settings';

const Document = dynamic(() => import('@/retained/components/layout/middle-content/page-views/document/DocumentView'), { ssr: false });
const Code = dynamic(() => import('@/retained/components/layout/middle-content/page-views/code/CodePageView'), { ssr: false });
const Sheet = dynamic(() => import('@/retained/components/layout/middle-content/page-views/sheet/SheetView'), { ssr: false });
const Canvas = dynamic(() => import('@/retained/components/layout/middle-content/page-views/canvas/CanvasPageView'), { ssr: false });
const File = dynamic(() => import('@/retained-adapters/file-view'), { ssr: false });
const Channel = dynamic(() => import('@/retained/components/layout/middle-content/page-views/channel/ChannelView'), { ssr: false });
const Tasks = dynamic(() => import('@/retained/components/layout/middle-content/page-views/task-list/TaskListView'), { ssr: false });

export type PageViewProps = {
  readonly driveId: string;
  readonly pageId: string;
};

/** The page as a document the view can draw, or null for any other page type. */
export const documentOf = (data: unknown): DocumentPage | null => {
  if (typeof data !== 'object' || data === null) return null;
  const { id, title, type, content, revision, contentMode } = data as Record<string, unknown>;
  if (type !== 'DOCUMENT' || typeof id !== 'string') return null;
  return {
    id,
    title: typeof title === 'string' ? title : '',
    content: typeof content === 'string' ? content : '',
    revision: typeof revision === 'number' ? revision : 0,
    contentMode: contentMode === 'markdown' ? 'markdown' : 'html',
  };
};

/** Dispatch the permission-filtered page into a reused native object view. */
export function PageView({ driveId, pageId }: PageViewProps): ReactNode {
  const { data } = usePage(pageId);
  if (!data || typeof data !== 'object' || !('type' in data)) return renderObjectPlaceholder('Page');
  const page = data as TreePage;
  let content: ReactNode;
  switch (page.type) {
    case 'DOCUMENT': content = <Document pageId={pageId} driveId={driveId} />; break;
    case 'CODE': content = <Code pageId={pageId} driveId={driveId} />; break;
    case 'SHEET': content = <Sheet page={page} />; break;
    case 'CANVAS': content = <Canvas pageId={pageId} />; break;
    case 'FILE': content = <File driveId={driveId} pageId={pageId} />; break;
    case 'CHANNEL': content = <Channel page={page} />; break;
    case 'TASK_LIST': content = <Tasks page={page} />; break;
    case 'AI_CHAT': content = <AgentSettings pageId={pageId} driveId={driveId} title={page.title} />; break;
    default: return renderObjectPlaceholder('Page');
  }
  return <RetainedSurface><div className="flex h-full min-h-0 flex-col"><ViewHeader pageId={pageId}><PageHistory /></ViewHeader><div className="min-h-0 flex-1">{content}</div></div></RetainedSurface>;
}
